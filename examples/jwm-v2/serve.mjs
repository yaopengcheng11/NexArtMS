import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 8197);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
};

http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const target = path.resolve(root, relative);
  if (path.relative(root, target).startsWith('..')) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(target, (error, stats) => {
    if (error || !stats.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const baseHeaders = {
      'Content-Type': types[path.extname(target)] || 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    };
    const range = request.headers.range?.match(/^bytes=(\d*)-(\d*)$/);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), stats.size - 1) : stats.size - 1;
      if (start > end || start >= stats.size) {
        response.writeHead(416, { ...baseHeaders, 'Content-Range': `bytes */${stats.size}` }).end();
        return;
      }
      response.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Content-Length': end - start + 1,
      });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(target, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...baseHeaders, 'Content-Length': stats.size });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(target).pipe(response);
  });
}).listen(port, '127.0.0.1', () => {
  process.stdout.write(`JWM Three.js preview: http://127.0.0.1:${port}/\n`);
});
