// Helpers StageGuard shares with the bridge feed: the Stage Racing window's breakpoints, and a read-only client for
// the bridge's websocket (the same feed the overlays use).
'use strict';

// Stage ends from the Stage Racing window's saved settings.
//   cfg = config.stageRacing = { numStages, inputMode: 'percent'|'laps', percentages: [], laps: [] }
function breakpointsFromConfig(raceTotal, cfg) {
  if (!cfg || !(cfg.numStages >= 2) || !(raceTotal > 0)) return [];
  const n = cfg.numStages - 1;
  const src = cfg.inputMode === 'laps' ? (cfg.laps || []) : (cfg.percentages || []);
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = Number(src[i]);
    if (!(v > 0)) return [];
    const lap = cfg.inputMode === 'laps' ? Math.round(v) : Math.ceil(raceTotal * v / 100);
    if (lap <= 0 || lap >= raceTotal || (out.length && lap <= out[out.length - 1])) return [];
    out.push(lap);
  }
  return out;
}

class BridgeClient {
  constructor(opts) {
    this.url = opts.url || 'ws://127.0.0.1:8765';
    this.onFrame = opts.onFrame || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.minIntervalMs = opts.minIntervalMs || 80;
    this.log = opts.log || (() => {});
    this.connected = false;
    this._ws = null; this._stopped = false; this._last = 0; this._timer = null;
  }
  start() { this._stopped = false; this._connect(); }
  stop() {
    this._stopped = true;
    clearTimeout(this._timer);
    try { if (this._ws) this._ws.close(); } catch (e) { /* ignore */ }
  }
  _connect() {
    if (this._stopped) return;
    if (typeof WebSocket === 'undefined') { this.log('[bridge] no global WebSocket in this runtime — stage feed disabled'); return; }
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._retry(); return; }
    this._ws = ws;
    ws.onopen = () => { this.connected = true; this.onStatus(true); };
    ws.onmessage = ev => {
      const now = Date.now();
      if (now - this._last < this.minIntervalMs) return;     // drop frames before paying for JSON.parse
      this._last = now;
      let d;
      try { d = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch (e) { return; }
      this.onFrame(d);
    };
    ws.onclose = () => { if (this._ws === ws) this._ws = null; if (this.connected) { this.connected = false; this.onStatus(false); } this._retry(); };
    ws.onerror = () => { /* onclose follows */ };
  }
  _retry() { if (!this._stopped) this._timer = setTimeout(() => this._connect(), 3000); }
}

module.exports = { breakpointsFromConfig, BridgeClient };
