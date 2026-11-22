// stage_shim.js — loaded first by every overlay that shows stages (scorebug, ticker, live standings …).
// All In One NR2003 works the stage state out itself (app/stages) because the compiled bridge only plans the stage ends once per
// race, so a stage a caution ended early kept its old number / length on screen. All In One NR2003 serves the corrected stage
// fields as a server-sent-event stream; this wraps the page's connection to the bridge (port 8765) and merges them over
// every frame before the overlay sees it. If All In One NR2003's feed is not running the frames pass through untouched.
(function () {
  'use strict';
  if (window.__stageShim || typeof window.WebSocket !== 'function' || typeof window.EventSource !== 'function') return;
  window.__stageShim = true;

  var params = new URLSearchParams(location.search);
  var host = location.hostname || 'localhost';
  var port = params.get('stageport') || '8772';
  var fields = null;

  function connect() {
    var es;
    try { es = new EventSource('http://' + host + ':' + port + '/stage'); } catch (e) { return; }
    es.onmessage = function (ev) { try { fields = JSON.parse(ev.data); } catch (e) { /* keep the last good one */ } };
    // EventSource reconnects by itself; if All In One NR2003's feed goes away the last fields would go stale, so drop them
    es.onerror = function () { if (es.readyState === 2) fields = null; };
  }
  connect();

  var Native = window.WebSocket;
  var nativeOnmessage = Object.getOwnPropertyDescriptor(Native.prototype, 'onmessage');

  function merge(data) {
    if (!fields || typeof data !== 'string') return data;
    try {
      var o = JSON.parse(data);
      if (o && typeof o === 'object' && !Array.isArray(o) && ('lapsTotal' in o || 'standings' in o || 'sessionFlag' in o)) {
        for (var k in fields) o[k] = fields[k];
        return JSON.stringify(o);
      }
    } catch (e) { /* not a frame */ }
    return data;
  }
  function wrap(ev) {
    var data = merge(ev.data);
    if (data === ev.data) return ev;
    return new MessageEvent('message', { data: data, origin: ev.origin, lastEventId: ev.lastEventId, source: ev.source, ports: ev.ports });
  }

  function Shim(url, protocols) {
    var ws = protocols === undefined ? new Native(url) : new Native(url, protocols);
    if (!/:8765(\/|$|\?)/.test(String(url))) return ws;

    var handler = null;
    Object.defineProperty(ws, 'onmessage', {
      configurable: true,
      get: function () { return handler; },
      set: function (fn) {
        handler = fn;
        nativeOnmessage.set.call(ws, typeof fn === 'function' ? function (ev) { return fn.call(ws, wrap(ev)); } : null);
      },
    });
    var wrapped = new Map();
    var add = ws.addEventListener, remove = ws.removeEventListener;
    ws.addEventListener = function (type, fn, opts) {
      if (type === 'message' && typeof fn === 'function') {
        var w = wrapped.get(fn);
        if (!w) { w = function (ev) { return fn.call(ws, wrap(ev)); }; wrapped.set(fn, w); }
        return add.call(ws, type, w, opts);
      }
      return add.call(ws, type, fn, opts);
    };
    ws.removeEventListener = function (type, fn, opts) {
      if (type === 'message' && wrapped.has(fn)) return remove.call(ws, type, wrapped.get(fn), opts);
      return remove.call(ws, type, fn, opts);
    };
    return ws;
  }
  // perf-shim.js (loaded after this) wraps WebSocket again and takes the frames from the native socket itself, so it applies this
  // merge when it hands a frame to the page
  window.__stageShimWrap = wrap;
  Shim.prototype = Native.prototype;
  ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) { Shim[k] = Native[k]; });
  window.WebSocket = Shim;
})();
