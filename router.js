'use strict';

const LOCAL_HINTS = [
  'quick', 'briefly', 'brief', 'short', 'fast', 'simple',
  'local', 'private', 'offline', 'one line', 'tldr', 'summarize'
];

const CLOUD_HINTS = [
  'explain', 'analyze', 'analyse', 'generate', 'implement',
  'design', 'debug', 'comprehensive', 'detailed', 'step by step',
  'write', 'create', 'refactor', 'fix', 'edit', 'modify',
  'add ', 'remove', 'update', 'change', 'build', 'how do', 'how does'
];

function route(message) {
  const lower = message.toLowerCase();
  const localScore = LOCAL_HINTS.filter(h => lower.includes(h)).length;
  const cloudScore = CLOUD_HINTS.filter(h => lower.includes(h)).length;
  if (localScore > cloudScore) return 'local';
  if (cloudScore > localScore) return 'cloud';
  return lower.split(/\s+/).length <= 8 ? 'local' : 'cloud';
}

module.exports = { route };
