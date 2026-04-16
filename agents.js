'use strict';

const fs   = require('fs');
const path = require('path');

// Locations scanned (relative to workspace root)
const SCAN_GLOBS = [
  { glob: '.github/copilot-instructions.md', name: 'Copilot Instructions' },
  { glob: '.github/agents',    dir: true, ext: ['.md', '.yml', '.yaml'] },
  { glob: '.agents',           dir: true, ext: ['.md', '.yml', '.yaml'] },
  { glob: 'claude.md',         name: 'Claude' },
  { glob: 'CLAUDE.md',         name: 'Claude' },
  { glob: 'architect.yml',     name: 'Architect' },
  { glob: 'architect.yaml',    name: 'Architect' },
];

const DEFAULT_AGENT = {
  id:           'default',
  name:         'Default',
  description:  'Built-in coding agent',
  systemPrompt: null,   // extension.js uses its own SYSTEM_PROMPT
};

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseMd(filePath, defaultName) {
  const raw  = fs.readFileSync(filePath, 'utf8');
  let name   = defaultName;
  let desc   = '';
  let prompt = raw;

  // Optional YAML frontmatter: ---\nname: ...\ndescription: ...\n---
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fm) {
    const meta = fm[1];
    prompt     = fm[2].trim();
    const n    = meta.match(/^name:\s*(.+)$/m);
    const d    = meta.match(/^description:\s*(.+)$/m);
    if (n) name = n[1].trim();
    if (d) desc = d[1].trim();
  }

  return { name, description: desc, systemPrompt: prompt.trim() };
}

function parseYml(filePath, defaultName) {
  const raw  = fs.readFileSync(filePath, 'utf8');
  const get  = (key) => { const m = raw.match(new RegExp(`^${key}:\\s*(.+)$`, 'm')); return m ? m[1].trim() : ''; };

  const name   = get('name')   || defaultName;
  const desc   = get('description') || get('desc') || '';

  // Multi-line system/prompt block (indented lines after key)
  const blockMatch = raw.match(/^(?:system|prompt):\s*\|?\r?\n((?:[ \t]+.+\r?\n?)+)/m);
  const inline     = get('system') || get('prompt');
  const systemPrompt = blockMatch
    ? blockMatch[1].replace(/^[ \t]{2}/gm, '').trimEnd()
    : inline;

  return { name, description: desc, systemPrompt: systemPrompt || raw };
}

// ── Scanner ───────────────────────────────────────────────────────────────────

function loadAgents(workspaceRoot) {
  const agents = [DEFAULT_AGENT];
  const seen   = new Set();

  function add(filePath, fallbackName) {
    if (seen.has(filePath)) return;
    seen.add(filePath);
    try {
      const ext  = path.extname(filePath).toLowerCase();
      const base = path.basename(filePath, ext);
      const parsed = (ext === '.yml' || ext === '.yaml')
        ? parseYml(filePath, fallbackName || base)
        : parseMd(filePath, fallbackName || base);

      agents.push({
        id:   filePath,
        ...parsed,
      });
    } catch { /* skip unreadable files */ }
  }

  for (const entry of SCAN_GLOBS) {
    const full = path.join(workspaceRoot, entry.glob);
    if (entry.dir) {
      if (!fs.existsSync(full)) continue;
      try {
        fs.readdirSync(full).forEach(f => {
          if (entry.ext.includes(path.extname(f).toLowerCase())) {
            add(path.join(full, f));
          }
        });
      } catch { /* skip */ }
    } else {
      if (fs.existsSync(full)) add(full, entry.name);
    }
  }

  return agents;
}

module.exports = { loadAgents };
