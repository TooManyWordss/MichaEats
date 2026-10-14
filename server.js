// Local server: serves the web app from public/ and the API from lib/app.js.
// On Vercel, public/ is served as static files and api/index.js handles /api/*.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { handle, store } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname.startsWith('/api/')) return handle(req, res);
  serveStatic(res, decodeURIComponent(pathname));
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    store?.flush();
    process.exit(0);
  });
}

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  console.log(`\nMichEats POS running (${store.kind === 'redis' ? 'Upstash Redis' : 'local file data/db.json'})`);
  console.log(`  This computer:  http://localhost:${PORT}`);
  for (const ip of lan) console.log(`  Other devices:  http://${ip}:${PORT}`);
  console.log(`  Default staff PIN: 1234 (change it in Admin → Settings)\n`);
});
