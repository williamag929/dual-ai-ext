'use strict';

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

require('dotenv').config({
  path: path.join(__dirname, '..', 'dual_ai', '.env')
});

const { route }      = require('./router');
const { runAgent }   = require('./agent');
const { askGemma }   = require('./clients/gemma');
const { loadAgents } = require('./agents');
const { scan: scanPrivacy } = require('./core/privacy-scanner');

const DEFAULT_SYSTEM_PROMPT =
  'You are a coding agent inside VS Code. ' +
  'You have tools to read, write, and edit files in the workspace, ' +
  'and a run_command tool to execute shell commands. ' +
  'When asked to modify code, use the tools to make changes directly — ' +
  'do not just show a diff. Be concise.';

// Claude Opus 4.7 pricing per token (used for local savings estimate)
const CLOUD_INPUT_PRICE  = 5  / 1_000_000;   // $5 per 1M input tokens
const CLOUD_OUTPUT_PRICE = 25 / 1_000_000;   // $25 per 1M output tokens

// ── Webview provider ────────────────────────────────────────────────────────

class MoktaProvider {
  constructor(context) {
    this._ctx          = context;
    this._view         = null;

    // Sessions: Map<id, { name, history[] }>
    this._sessions     = new Map();
    this._activeSessId = null;
    this._sessCounter  = 0;

    // Agents
    this._agents      = [{ id: 'default', name: 'Default', description: 'Built-in coding agent', systemPrompt: null }];
    this._activeAgent = 'default';

    // Pending diff approvals: Map<diffId, resolve(boolean)>
    this._pendingDiffs = new Map();
  }

  get _systemPrompt() {
    const agent = this._agents.find(a => a.id === this._activeAgent);
    return agent?.systemPrompt || DEFAULT_SYSTEM_PROMPT;
  }

  get _activeHistory() {
    return this._sessions.get(this._activeSessId)?.history ?? [];
  }

  // ── Session helpers ──────────────────────────────────────────────────

  _newSession() {
    const id   = `s${Date.now()}_${++this._sessCounter}`;
    const name = `Session ${this._sessCounter}`;
    this._sessions.set(id, { name, history: [] });
    this._activeSessId = id;
    this._post({ type: 'session-created', id, name });
    return id;
  }

  // ── VS Code lifecycle ────────────────────────────────────────────────

  resolveWebviewView(webviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._ctx.extensionUri, 'media')]
    };
    webviewView.webview.html = this._buildHtml(webviewView.webview);

    // Push editor context whenever selection or active file changes
    const pushCtx = this._debounce(() => this._pushEditorContext(), 150);
    this._ctx.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(pushCtx),
      vscode.window.onDidChangeActiveTextEditor(pushCtx)
    );

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'ready':
          this._pushAgents();
          if (this._sessions.size === 0) this._newSession();
          this._pushEditorContext();
          // Restore persisted savings
          this._pushSavedCost();
          break;

        case 'chat':
          await this._onChat(msg.text, msg.mode ?? 'auto', msg.sessionId, msg.attachContext !== false);
          break;

        case 'clear': {
          const sess = this._sessions.get(this._activeSessId);
          if (sess) sess.history = [];
          break;
        }

        case 'newSession':
          this._newSession();
          break;

        case 'switchSession':
          if (this._sessions.has(msg.id)) this._activeSessId = msg.id;
          break;

        case 'deleteSession':
          this._sessions.delete(msg.id);
          if (this._activeSessId === msg.id) {
            this._activeSessId = this._sessions.keys().next().value ?? null;
          }
          break;

        case 'renameSession': {
          const sess = this._sessions.get(msg.id);
          if (sess) sess.name = msg.name;
          break;
        }

        case 'agent':
          this._activeAgent = msg.id;
          break;

        // ── Diff approval ────────────────────────────────────────────
        case 'diff-accept': {
          const resolve = this._pendingDiffs.get(msg.id);
          if (resolve) { resolve(true);  this._pendingDiffs.delete(msg.id); }
          break;
        }
        case 'diff-reject': {
          const resolve = this._pendingDiffs.get(msg.id);
          if (resolve) { resolve(false); this._pendingDiffs.delete(msg.id); }
          break;
        }
      }
    });
  }

  inject(text) {
    this._view?.webview.postMessage({ type: 'inject', text });
  }

  // ── Core chat handler ────────────────────────────────────────────────

  async _onChat(userText, mode = 'auto', sessionId, attachContext = true) {
    const sid  = (sessionId && this._sessions.has(sessionId)) ? sessionId : this._activeSessId;
    const sess = this._sessions.get(sid);
    if (!sess) return;

    const ctx        = attachContext ? this._getEditorContext() : '';
    const msgWithCtx = ctx ? `${userText}\n\n${ctx}` : userText;
    sess.history.push({ role: 'user', content: msgWithCtx });

    // ── Privacy scan ─────────────────────────────────────────────────
    const cfg         = vscode.workspace.getConfiguration('motkra');
    const privacyScan = cfg.get('privacyScan') ?? true;
    let   forcedLocal = false;

    if (privacyScan) {
      const hit = scanPrivacy(msgWithCtx);
      if (hit.hit) {
        forcedLocal = true;
        this._post({ type: 'privacy', label: hit.label, sessionId: sid });
        // Log to output channel (never the content, only the pattern label)
        this._outputChannel().appendLine(`[Motkra] Privacy: '${hit.label}' detected → forced local model`);
      }
    }

    // ── Route ────────────────────────────────────────────────────────
    const model = forcedLocal
      ? 'local'
      : mode === 'cloud' ? 'cloud'
      : mode === 'local' ? 'local'
      : route(userText);

    const s = (extra) => ({ sessionId: sid, ...extra });

    this._post(s({ type: 'model', model }));
    this._post(s({ type: 'start' }));

    // ── Ollama options ───────────────────────────────────────────────
    const ollamaOpts = {
      host:  cfg.get('ollamaHost')  ?? 'localhost',
      port:  cfg.get('ollamaPort')  ?? 11434,
    };

    // ── Tool options ─────────────────────────────────────────────────
    const toolOpts = {
      allowedCommands: cfg.get('allowedCommands'),
      terminalTimeout: cfg.get('terminalTimeout'),
    };

    try {
      if (model === 'cloud') {
        await runAgent(
          sess.history,
          this._systemPrompt,
          (token)        => this._post(s({ type: 'token', text: token })),
          (name, input)  => this._post(s({ type: 'tool',  name, input: JSON.stringify(input) })),
          (fullResponse) => sess.history.push({ role: 'assistant', content: fullResponse }),
          // onDiffRequest: pause tool execution, show diff in panel, wait for user
          async (id, filePath, before, after) => {
            this._post(s({ type: 'diff-request', id, path: filePath, before, after }));
            return new Promise(resolve => this._pendingDiffs.set(id, resolve));
          },
          // onUsage: cloud tokens don't save money — no cost update needed
          null,
          toolOpts
        );
      } else {
        // ── Local (Gemma / Ollama) ───────────────────────────────────
        let full       = '';
        let inputChars = sess.history.reduce((acc, m) => acc + String(m.content).length, 0);

        const outputTokenCount = await askGemma(
          [{ role: 'system', content: this._systemPrompt }, ...sess.history],
          (token) => {
            this._post(s({ type: 'token', text: token }));
            full += token;
          },
          ollamaOpts
        );

        sess.history.push({ role: 'assistant', content: full });

        // ── Cost savings ─────────────────────────────────────────────
        const inputTokens  = Math.ceil(inputChars / 4);
        const outputTokens = outputTokenCount;
        const savedNow     = (inputTokens  * CLOUD_INPUT_PRICE) +
                             (outputTokens * CLOUD_OUTPUT_PRICE);
        const totalSaved   = ((this._ctx.globalState.get('motkra.totalSaved') ?? 0) + savedNow);
        this._ctx.globalState.update('motkra.totalSaved', totalSaved);
        this._post({ type: 'cost-update', saved: totalSaved });
      }
    } catch (err) {
      this._post(s({ type: 'error', text: err.message }));
      sess.history.pop();
    }

    this._post(s({ type: 'done' }));
  }

  // ── Agents ───────────────────────────────────────────────────────────

  _pushAgents() {
    this._post({
      type:   'agents',
      agents: this._agents.map(a => ({ id: a.id, name: a.name, description: a.description })),
    });
  }

  reloadAgents() {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
    if (root) {
      this._agents = loadAgents(root);
      if (!this._agents.find(a => a.id === this._activeAgent)) this._activeAgent = 'default';
    }
    this._pushAgents();
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  _pushSavedCost() {
    const total = this._ctx.globalState.get('motkra.totalSaved') ?? 0;
    if (total > 0) this._post({ type: 'cost-update', saved: total });
  }

  _outputChannel() {
    if (!this._channel) {
      this._channel = vscode.window.createOutputChannel('Motkra');
    }
    return this._channel;
  }

  _getEditorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) return '';
    const name = path.basename(ed.document.fileName);
    const sel  = ed.document.getText(ed.selection);
    if (sel.trim()) {
      const start = ed.selection.start.line + 1;
      const end   = ed.selection.end.line + 1;
      const range = start === end ? `line ${start}` : `lines ${start}–${end}`;
      return `Selected code in \`${name}\` (${range}):\n\`\`\`\n${sel}\n\`\`\``;
    }
    return `Current file \`${name}\`:\n\`\`\`\n${ed.document.getText().slice(0, 6000)}\n\`\`\``;
  }

  _pushEditorContext() {
    const ed = vscode.window.activeTextEditor;
    if (!ed) {
      this._post({ type: 'context', ctx: null });
      return;
    }
    const file         = path.basename(ed.document.fileName);
    const sel          = ed.document.getText(ed.selection);
    const hasSelection = sel.trim().length > 0;
    let lines          = null;
    if (hasSelection) {
      const start = ed.selection.start.line + 1;
      const end   = ed.selection.end.line + 1;
      lines = start === end ? `line ${start}` : `lines ${start}–${end}`;
    }
    this._post({ type: 'context', ctx: { file, lines, hasSelection } });
  }

  _debounce(fn, ms) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  _post(msg) {
    this._view?.webview.postMessage(msg);
  }

  _buildHtml(webview) {
    const htmlPath = path.join(this._ctx.extensionPath, 'media', 'panel.html');
    const nonce    = [...Array(32)].map(() =>
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[
        Math.floor(Math.random() * 62)
      ]
    ).join('');
    return fs.readFileSync(htmlPath, 'utf8').replace(/\$\{nonce\}/g, nonce);
  }
}

// ── Activation ──────────────────────────────────────────────────────────────

function activate(context) {
  const provider = new MoktaProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('motkra.panel', provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  provider.reloadAgents();

  // Watch for agent file changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{.github/agents,claude.md,CLAUDE.md,architect.{yml,yaml},.agents/**}'
  );
  const reload = () => provider.reloadAgents();
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);

  context.subscriptions.push(
    vscode.commands.registerCommand('motkra.reloadAgents', () => {
      provider.reloadAgents();
      vscode.window.showInformationMessage('Motkra: agents reloaded.');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('motkra.sendSelection', () => {
      const sel = vscode.window.activeTextEditor?.document.getText(
        vscode.window.activeTextEditor.selection
      );
      if (sel?.trim()) provider.inject(`Explain this code:\n\`\`\`\n${sel}\n\`\`\``);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('motkra.fixSelection', () => {
      const ed  = vscode.window.activeTextEditor;
      const sel = ed?.document.getText(ed.selection);
      if (sel?.trim()) provider.inject(`Fix this code (edit the file directly):\n\`\`\`\n${sel}\n\`\`\``);
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
