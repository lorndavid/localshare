/**
 * LocalShare Interactive Test Server (Zero Dependencies)
 * Run with: node demo-app/server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 4500);
const indexPath = path.join(__dirname, 'index.html');

let hits = 0;
const messages = [
  {
    text: 'LocalShare test server started and ready for public HTTPS sharing!',
    from: 'localhost',
    time: new Date().toISOString(),
  },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/api/info') {
    hits += 1;
    const visitorIp =
      req.headers['cf-connecting-ip'] ||
      req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      '127.0.0.1';
    const country = req.headers['cf-ipcountry'] || '';

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        localPort: PORT,
        hits,
        visitorIp,
        country,
        headers: req.headers,
        messages,
      }),
    );
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/message') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const text = String(parsed.text || '').trim().slice(0, 200);
        const from =
          req.headers['cf-ipcountry'] ||
          req.headers['cf-connecting-ip'] ||
          req.headers['x-forwarded-for'] ||
          'Visitor';
        if (text) {
          messages.unshift({
            text,
            from: String(from),
            time: new Date().toISOString(),
          });
          if (messages.length > 20) messages.pop();
        }
        hits += 1;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, hits, messages }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // Serve index.html for root and all other GET routes
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to load index.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`========================================================`);
  console.log(` LocalShare Test App running at http://localhost:${PORT}`);
  console.log(` Now open the LocalShare sidebar in VS Code and share port ${PORT}!`);
  console.log(`========================================================`);
});

