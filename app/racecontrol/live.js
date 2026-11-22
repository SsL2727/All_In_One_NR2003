// RaceControl's graphics as web pages (OBS Browser sources, a second screen): /board is the choose cone board, /status the caution panel,
// /pit AIMOD's pit board, / all of them, each on a transparent background; /state.json is what they draw. Read-only, and on this PC only unless `lan` is set.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

class LiveGfx {
  // opts: { getData() -> object|null, pageFile }
  constructor(opts) { this.opts = opts; this.server = null; this.port = 0; this.lan = false; }

  start(port, lan) {
    if (this.server && this.port === port && this.lan === !!lan) return true;
    this.stop();
    try {
      const page = this.opts.pageFile || path.join(__dirname, '..', 'rcgfx.html');
      const srv = http.createServer((req, res) => {
        const url = String(req.url || '/').split('?')[0];
        if (url === '/state.json') {
          const body = JSON.stringify(this.opts.getData() || {});
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
          return res.end(body);
        }
        if (url === '/' || url === '/board' || url === '/status' || url === '/pit') {
          fs.readFile(page, (err, buf) => {
            if (err) { res.writeHead(500); return res.end('rcgfx.html missing'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(buf);
          });
          return;
        }
        res.writeHead(404); res.end('not found');
      });
      srv.on('error', () => { if (this.server === srv) { this.server = null; this.port = 0; } });
      srv.listen(port, lan ? '0.0.0.0' : '127.0.0.1');
      this.server = srv; this.port = port; this.lan = !!lan;
      return true;
    } catch (e) { this.server = null; return false; }
  }

  stop() { if (this.server) { try { this.server.close(); } catch (e) { /* ignore */ } } this.server = null; this.port = 0; }
}

module.exports = { LiveGfx };
