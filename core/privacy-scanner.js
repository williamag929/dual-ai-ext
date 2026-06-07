'use strict';

// Patterns that indicate secrets or sensitive content.
// Ordered from most specific to least to minimise false positives.
const PATTERNS = [
  // Anthropic / OpenAI style keys
  { re: /sk-[a-zA-Z0-9]{20,}/,                              label: 'API key (sk-)' },
  // AWS access key
  { re: /AKIA[0-9A-Z]{16}/,                                 label: 'AWS access key' },
  // Google API key
  { re: /AIza[0-9A-Za-z\-_]{35}/,                          label: 'Google API key' },
  // GitHub PAT
  { re: /gh[pousr]_[a-zA-Z0-9]{36}/,                       label: 'GitHub token' },
  // Slack token
  { re: /xox[baprs]-[0-9a-zA-Z\-]{10,}/,                  label: 'Slack token' },
  // Generic Bearer token (≥20 chars)
  { re: /Bearer\s+[a-zA-Z0-9\-._~+/]{20,}={0,2}/,         label: 'Bearer token' },
  // PEM private key
  { re: /-----BEGIN\s+(?:RSA\s+)?PRIVATE KEY-----/,        label: 'PEM private key' },
  // Database connection strings
  { re: /(?:mongodb|postgres(?:ql)?|mysql|redis):\/\/[^"'\s]{10,}/i, label: 'DB connection string' },
  // Assignments like PASSWORD=..., SECRET=..., API_KEY=...
  { re: /(?:password|passwd|secret|api[_\-]?key|auth[_\-]?token)\s*[:=]\s*["']?[^\s"']{8,}/i, label: 'credential assignment' },
];

/**
 * Scan text for secrets/credentials.
 * @param {string} text
 * @returns {{ hit: boolean, label?: string }}
 */
function scan(text) {
  for (const { re, label } of PATTERNS) {
    if (re.test(text)) return { hit: true, label };
  }
  return { hit: false };
}

module.exports = { scan };
