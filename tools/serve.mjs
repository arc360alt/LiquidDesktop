// Browser preview: serves LiquidDesktop to a normal web browser (files/terminal are mocked).
//   npm run web   →   http://localhost:5173
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
const port = Number(process.env.PORT) || 5173;

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/') { res.writeHead(302, { Location: '/renderer/index.html' }); return res.end(); }
  const file = path.join(root, path.normalize(url));
  const allowed = [path.join(root, 'renderer'), path.join(root, 'node_modules', '@xterm'), path.join(root, 'node_modules', '@fontsource-variable')];
  if (!allowed.some((dir) => file.startsWith(dir + path.sep))) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`LiquidDesktop preview: http://localhost:${port}`));
