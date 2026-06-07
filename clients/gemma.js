'use strict';

const http = require('http');

/**
 * Stream a response from a local Ollama model.
 * @param {Array}    messages  chat history including system message
 * @param {Function} onToken   called with each text token
 * @param {Object}   [opts]    { host, port, model }
 * @returns {Promise<number>}  estimated output token count
 */
function askGemma(messages, onToken, opts = {}) {
  const host  = opts.host  ?? 'localhost';
  const port  = opts.port  ?? 11434;
  const model = opts.model ?? 'gemma4:e2b';

  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true
    }));

    const req = http.request(
      {
        hostname: host,
        port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': body.length
        }
      },
      (res) => {
        let buf = '';
        let outputChars = 0;

        res.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.message?.content) {
                onToken(data.message.content);
                outputChars += data.message.content.length;
              }
            } catch { /* partial line */ }
          }
        });

        res.on('end', () => resolve(Math.ceil(outputChars / 4)));
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { askGemma };
