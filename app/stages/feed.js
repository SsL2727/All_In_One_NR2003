// StageFeed — runs the StageEngine on the bridge's frames and gives the corrected stage fields to everything that shows
// or scores stages:
//   * overlays (scorebug, ticker, live standings …) get them as a server-sent-event stream on http://<host>:8772/stage;
//     app/stage_shim.js merges them over the bridge's own frames, so the displayed stage / lap / length follow the stage
//     that really ended (a caution can end a stage early; the compiled bridge never noticed);
//   * the season tracker gets them through mapFrame(), so stage points are scored on the real stage results.
// Also holds the "end the stage early on a caution" rule's settings (stageGuard) and the "stages off" master switch.
'use strict';
const http = require('http');
const { BridgeClient } = require('../stagebridge');
const { StageEngine } = require('./engine');

const GUARD_DEFAULTS = { enabled: false, laps: 5 };
const KEEPALIVE_MS = 15000;

class StageFeed {
  // opts: { getConfig, saveConfig, log, applyEarly(ends), rcEarly(), port (default 8772), bridge:false / listen:false (tests) }
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log || (() => {});
    this.port = opts.port || 8772;
    this.engine = new StageEngine({
      getConfig: () => this._effectiveConfig(),
      cautionFallback: true,
      applyEarly: ends => (this.opts.applyEarly ? this.opts.applyEarly(ends) : ends),
      rcEarly: () => (this.opts.rcEarly ? this.opts.rcEarly() : false),
      log: m => this.log(m),
    });
    this.fields = null;
    this.key = '';
    this.clients = new Set();
    this.server = null;
    this.timer = null;
    this.bridge = opts.bridge === false ? null : new BridgeClient({ log: m => this.log(m), onFrame: d => this.onFrame(d), minIntervalMs: 60 });
  }

  // ── settings ────────────────────────────────────────────────────────────────
  cfg() { const c = this.opts.getConfig(); c.stageGuard = Object.assign({}, GUARD_DEFAULTS, c.stageGuard || {}); return c.stageGuard; }
  setGuard(p) {
    const g = this.cfg();
    if (p && typeof p.enabled === 'boolean') g.enabled = p.enabled;
    if (p && Number(p.laps) >= 2) g.laps = Math.min(30, Math.floor(Number(p.laps)));
    this.opts.saveConfig();
    return g;
  }
  // RaceControl owns the stage caution: while it runs live, the display follows its "stage caution" setting (stages without cautions or not)
  _effectiveConfig() {
    const c = this.opts.getConfig(), rc = c && c.raceControl;
    if (!rc || !rc.enabled || rc.dryRun !== false) return c;
    return Object.assign({}, c, { stageRacing: Object.assign({}, c.stageRacing, { throwCaution: rc.StageThrowCaution !== false }) });
  }
  stageEnds() { return this.engine.currentEnds(); }
  stagesOff() { const sr = this.opts.getConfig().stageRacing; return !!(sr && sr.stagesOff); }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  start() {
    if (this.bridge) this.bridge.start();
    if (this.opts.listen !== false) this._listen();
  }
  stop() {
    if (this.bridge) this.bridge.stop();
    clearInterval(this.timer);
    for (const r of this.clients) { try { r.end(); } catch (e) { /* ignore */ } }
    this.clients.clear();
    if (this.server) { try { this.server.close(); } catch (e) { /* ignore */ } this.server = null; }
  }

  _listen() {
    const srv = http.createServer((req, res) => {
      if (req.url && req.url.split('?')[0] === '/stage') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write('retry: 2000\n\n');
        if (this.fields) res.write('data: ' + this.key + '\n\n');
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }
      if (req.url && req.url.split('?')[0] === '/stage.json') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(this.key || 'null');
        return;
      }
      res.writeHead(404); res.end();
    });
    // the port can still be held by the previous copy of the app while it shuts down: keep trying until it is free
    srv.on('error', e => {
      this.log('[stages] feed server: ' + (e && e.message));
      if (e && e.code === 'EADDRINUSE' && this.server === srv) { const t = setTimeout(() => { if (this.server === srv) srv.listen(this.port, '0.0.0.0'); }, 3000); if (t.unref) t.unref(); }
    });
    srv.on('listening', () => this.log(`[stages] stage feed on port ${this.port}`));
    srv.listen(this.port, '0.0.0.0');
    this.server = srv;
    this.timer = setInterval(() => { for (const r of this.clients) { try { r.write(': ping\n\n'); } catch (e) { /* ignore */ } } }, KEEPALIVE_MS);
    if (this.timer.unref) this.timer.unref();
  }

  // ── frames ──────────────────────────────────────────────────────────────────
  onFrame(d) {
    try {
      const f = this.engine.update(d);
      this.fields = f;
      const key = JSON.stringify(f);
      if (key !== this.key) {
        this.key = key;
        for (const r of this.clients) { try { r.write('data: ' + key + '\n\n'); } catch (e) { /* ignore */ } }
      }
    } catch (e) { this.log('[stages] error: ' + (e && e.stack || e)); }
  }

  // a bridge frame with the corrected stage fields merged over it (the season tracker's input)
  mapFrame(d) { return this.fields && d ? Object.assign({}, d, this.fields) : d; }

  getState() {
    return {
      guard: this.cfg(), stagesOff: this.stagesOff(), clients: this.clients.size, bridge: this.bridge ? this.bridge.connected : false,
      fields: this.fields,
    };
  }
}

module.exports = { StageFeed, GUARD_DEFAULTS };
