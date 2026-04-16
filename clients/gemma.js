'use strict';

const http = require('http');

/** Stream a response from Gemma 4 via the Ollama HTTP API. */
function askGemma(messages, onToken) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({
      model: 'gemma4:e2b',
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true
    }));

    const req = http.request(
      { hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } },
      (res) => {
        let buf = '';
        res.on('data', chunk => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const data = JSON.parse(line);
              if (data.message?.content) onToken(data.message.content);
            } catch { /* partial line */ }
          }
        });
        res.on('end', resolve);
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { askGemma };
