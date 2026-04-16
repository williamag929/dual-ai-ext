'use strict';

const path = require('path');
const fs   = require('fs');

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
        new_text: { type: 'string', description: 'Replacement text'   }
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
  }
];

// ── File-system helpers ───────────────────────────────────────────────────────

function workspaceRoot() {
  return vscode?.workspace?.workspaceFolders?.[0]?.uri?.fsPath ?? process.cwd();
}

function resolve(p) {
  return path.isAbsolute(p) ? p : path.join(workspaceRoot(), p);
}

async function executeTool(name, input) {
  switch (name) {
    case 'read_file': {
      return fs.readFileSync(resolve(input.path), 'utf8');
    }
    case 'write_file': {
      const full = resolve(input.path);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, input.content, 'utf8');
      return `Wrote ${input.path}`;
    }
    case 'str_replace': {
      const full    = resolve(input.path);
      const content = fs.readFileSync(full, 'utf8');
      if (!content.includes(input.old_text)) {
        throw new Error(`Text not found in ${input.path}: "${input.old_text.slice(0, 50)}..."`);
      }
      fs.writeFileSync(full, content.replace(input.old_text, input.new_text), 'utf8');
      return `Edited ${input.path}`;
    }
    case 'list_files': {
      const dir     = input.path ? resolve(input.path) : workspaceRoot();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n');
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Agentic loop ─────────────────────────────────────────────────────────────

/**
 * Run Claude with file tools until it produces a final answer.
 *
 * @param {Array}    history      - conversation so far [{role, content}]
 * @param {string}   system       - system prompt
 * @param {Function} onToken      - called with each streamed text token
 * @param {Function} onTool       - called when a tool fires (name, inputJson)
 * @param {Function} onDone       - called with the full assistant text when finished
 */
async function runAgent(history, system, onToken, onTool, onDone) {
  // Strip any stray system-role entries (API only accepts user/assistant in messages)
  const messages = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  let fullText = '';

  for (let i = 0; i < 10; i++) {           // max 10 tool-call iterations
    const stream = client.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 8096,
      tools:      TOOLS,
      system,
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
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;

    // Execute every tool Claude requested
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      onTool(block.name, block.input);
      let result;
      try {
        result = await executeTool(block.name, block.input);
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
