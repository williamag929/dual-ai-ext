'use strict';

const path  = require('path');
const fs    = require('fs');
const { exec } = require('child_process');

let vscode;
try { vscode = require('vscode'); } catch { vscode = null; }

const { default: Anthropic } = require('@anthropic-ai/sdk');
const client = new Anthropic();

// ── Tools Claude can call ────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'read_file',
    description: 'Read the full contents of a file. Paths are relative to the workspace root.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path (relative or absolute)' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or fully overwrite a file with new content.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Complete file content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'str_replace',
    description:
      'Replace an exact string inside a file. ' +
      'old_text must match exactly (whitespace included). ' +
      'Use for targeted edits without rewriting the whole file.',
    input_schema: {
      type: 'object',
      properties: {
        path:     { type: 'string' },
        old_text: { type: 'string', description: 'Exact text to find' },
        new_text: { type: 'string', description: 'Replacement text' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'list_files',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path. Defaults to workspace root.' }
      }
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the workspace. ' +
      'Use for npm, pytest, git, python, node, etc. ' +
      'Only executables in motkra.allowedCommands are permitted.',
    input_schema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Full command string to execute' },
        cwd: { type: 'string', description: 'Working directory (defaults to workspace root)' }
      },
      required: ['cmd']
    }
  }
];

// ── Workspace helpers ─────────────────────────────────────────────────────────

function workspaceRoot() {
  return vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

function resolvePath(p) {
  return path.isAbsolute(p) ? p : path.join(workspaceRoot(), p);
}

// ── Tool executor ─────────────────────────────────────────────────────────────

/**
 * @param {string}   name
 * @param {Object}   input
 * @param {Object}   opts
 * @param {Function} [opts.onDiffRequest]     (id, filePath, before, after) → Promise<boolean>
 * @param {string[]} [opts.allowedCommands]
 * @param {number}   [opts.terminalTimeout]   seconds
 */
async function executeTool(name, input, opts = {}) {
  const { onDiffRequest, allowedCommands, terminalTimeout } = opts;

  switch (name) {

    case 'read_file': {
      return fs.readFileSync(resolvePath(input.path), 'utf8');
    }

    case 'write_file': {
      const full = resolvePath(input.path);
      let before = '';
      try { before = fs.readFileSync(full, 'utf8'); } catch { /* new file */ }

      if (onDiffRequest && before !== input.content) {
        const id       = `diff_${Date.now()}`;
        const accepted = await onDiffRequest(id, input.path, before, input.content);
        if (!accepted) return `Edit rejected by user: ${input.path}`;
      }

      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, input.content, 'utf8');
      return `Wrote ${input.path}`;
    }

    case 'str_replace': {
      const full    = resolvePath(input.path);
      const content = fs.readFileSync(full, 'utf8');
      if (!content.includes(input.old_text)) {
        throw new Error(`Text not found in ${input.path}: "${input.old_text.slice(0, 60)}"`);
      }
      const newContent = content.replace(input.old_text, input.new_text);

      if (onDiffRequest) {
        const id       = `diff_${Date.now()}`;
        const accepted = await onDiffRequest(id, input.path, content, newContent);
        if (!accepted) return `Edit rejected by user: ${input.path}`;
      }

      fs.writeFileSync(full, newContent, 'utf8');
      return `Edited ${input.path}`;
    }

    case 'list_files': {
      const dir     = input.path ? resolvePath(input.path) : workspaceRoot();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    }

    case 'run_command': {
      const { cmd, cwd: relCwd } = input;
      const exe = cmd.trim().split(/\s+/)[0];

      const cfg     = vscode?.workspace?.getConfiguration('motkra');
      const allowed = allowedCommands
        ?? cfg?.get('allowedCommands')
        ?? ['npm', 'npx', 'python', 'python3', 'pytest', 'git', 'node'];

      if (!allowed.includes(exe)) {
        return `Error: '${exe}' is not in motkra.allowedCommands.\nAllowed: ${allowed.join(', ')}`;
      }

      const timeoutMs = ((terminalTimeout ?? cfg?.get('terminalTimeout') ?? 30)) * 1000;
      const workdir   = relCwd ? resolvePath(relCwd) : workspaceRoot();

      return new Promise(res => {
        exec(cmd, { cwd: workdir, timeout: timeoutMs }, (err, stdout, stderr) => {
          const out = [stdout, stderr].filter(Boolean).join('\n').trim();
          if (out)           res(out);
          else if (err?.code) res(`Exit code ${err.code}`);
          else               res('Done (no output)');
        });
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agentic loop ─────────────────────────────────────────────────────────────

/**
 * Run Claude with file + terminal tools until it produces a final answer.
 *
 * @param {Array}    history          Conversation so far [{role, content}]
 * @param {string}   system           System prompt string
 * @param {Function} onToken          Called with each streamed text token
 * @param {Function} onTool           Called when a tool fires (name, input)
 * @param {Function} onDone           Called with full assistant text when finished
 * @param {Function} [onDiffRequest]  Called before a file write; returns Promise<boolean>
 * @param {Function} [onUsage]        Called with {inputTokens, outputTokens} after each LLM turn
 * @param {Object}   [toolOpts]       Forwarded to executeTool (allowedCommands, terminalTimeout)
 */
async function runAgent(history, system, onToken, onTool, onDone, onDiffRequest, onUsage, toolOpts) {
  const messages = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  const cfg   = vscode?.workspace?.getConfiguration('motkra');
  const model = cfg?.get('claudeModel') ?? 'claude-opus-4-7';

  let fullText = '';

  for (let i = 0; i < 10; i++) {
    const stream = client.messages.stream({
      model,
      max_tokens:    16000,
      thinking:      { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
      tools:         TOOLS,
      system:        [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        onToken(event.delta.text);
        fullText += event.delta.text;
      }
    }

    const response = await stream.finalMessage();

    if (onUsage) {
      onUsage({
        inputTokens:  response.usage.input_tokens,
        outputTokens: response.usage.output_tokens
      });
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      onTool(block.name, block.input);
      let result;
      try {
        result = await executeTool(block.name, block.input, {
          onDiffRequest,
          ...toolOpts
        });
      } catch (err) {
        result = `Error: ${err.message}`;
      }
      results.push({ type: 'tool_result', tool_use_id: block.id, content: String(result) });
    }
    messages.push({ role: 'user', content: results });
  }

  onDone(fullText);
}

module.exports = { runAgent };
