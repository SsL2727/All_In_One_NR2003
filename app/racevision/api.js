// Client for RaceVision's phone-remote HTTP API (the same endpoints its phone page uses):
//   GET  /api/state?k=KEY                       the live state (on TV, field, shot candidates, cameras, settings pages ...)
//   POST /api/set?name=&value=&k=KEY            change a setting
//   POST /api/focus?slot=&k=KEY                 put a car on TV (the director then waits manual_hold seconds)
//   POST /api/cam?c=&k=KEY                      switch camera
//   POST /api/auto?k=KEY                        hand the director back its control
//   POST /api/pause?on=0|1&k=KEY                pause / resume the director
// RaceVision has to be running with `remote = 1`; the pairing code is `remote_key` in racevision.ini.
'use strict';
const http = require('http');

class RaceVisionApi {
  // opts: { host, port, key, timeoutMs }
  constructor(opts) {
    this.host = (opts && opts.host) || '127.0.0.1';
    this.port = (opts && opts.port) || 8090;
    this.key = (opts && opts.key) || '';
    this.timeoutMs = (opts && opts.timeoutMs) || 2500;
  }

  _call(method, path, params) {
    const q = new URLSearchParams(Object.assign({}, params || {}, { k: this.key })).toString();
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.host, port: this.port, path: `/api/${path}?${q}`, method, timeout: this.timeoutMs, headers: { Connection: 'close' } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch (e) { /* not json */ }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(j || {});
          else reject(Object.assign(new Error((j && j.error) || `RaceVision answered ${res.statusCode}`), { status: res.statusCode }));
        });
      });
      req.on('timeout', () => req.destroy(new Error('RaceVision did not answer')));
      req.on('error', reject);
      req.end();
    });
  }

  state() { return this._call('GET', 'state'); }
  set(name, value) { return this._call('POST', 'set', { name, value: String(value) }); }
  focus(slot) { return this._call('POST', 'focus', { slot }); }
  cam(c) { return this._call('POST', 'cam', { c }); }
  auto() { return this._call('POST', 'auto', {}); }
  pause(on) { return this._call('POST', 'pause', { on: on ? 1 : 0 }); }
}

module.exports = { RaceVisionApi };
