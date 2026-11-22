/*
 * PSF performance shim — loaded first in the <head> of every overlay.
 *
 * Every overlay used to JSON.parse and re-render *every* telemetry frame the
 * bridge sent (60 Hz, or 288 Hz in "Ultra" mode), in every open overlay window,
 * all competing for CPU with NR2003. Nobody can see more than one update per
 * display frame, so this shim keeps only the newest frame and hands it to the
 * overlay's own `ws.onmessage` handler at most once per frame (or at most
 * `maxHz` times per second for the text/list-heavy overlays).
 *
 * Because dropped frames are never parsed, both the JSON.parse and the DOM
 * work disappear. The overlay code itself is untouched.
 *
 * Safety rules:
 *   - Small messages (< SMALL chars: `{"reset":true}` and other control
 *     messages) and non-text messages are never dropped; any pending frame is
 *     flushed first so ordering is preserved.
 *   - Telemetry frames are full snapshots, so skipping intermediate ones is
 *     lossless for state-diffing overlays (lap changes, flags, positions...).
 *   - If the window is hidden/occluded and requestAnimationFrame stops, a
 *     50 ms timer delivers the frame anyway (beeps, lap logic keep working).
 *
 * Override per overlay with the URL parameter  ?maxhz=N  (0 = one per frame).
 */
/*
 * Frame-rate cap (added): overlays animate with requestAnimationFrame, which on a
 * 120/144/240 Hz monitor means every transparent overlay window forces the
 * compositor (and DWM, over the game) to redraw that many times per second for
 * motion nobody can tell apart from 60 fps. This caps rAF callbacks at ~60/s.
 * 60 Hz displays are unaffected. Override with the URL parameter ?maxfps=N
 * (0 = no cap).
 */
(function () {
  'use strict';
  if (window.__PSF_RAF_SHIM__ || !window.requestAnimationFrame) return;
  window.__PSF_RAF_SHIM__ = true;

  var fps = parseFloat(new URLSearchParams(location.search).get('maxfps'));
  if (!isFinite(fps) || fps < 0) fps = 60;
  window.__PSF_FPS = fps;          // read by the WebSocket shim below (0 = uncapped)
  if (fps === 0) return;
  // A 60 Hz display delivers frames ~16.7 ms apart, so only skip frames that
  // arrive much sooner than that (leave headroom for timing jitter).
  var minGap = Math.min(1000 / fps, 16.7) * 0.72;

  var nativeRAF = window.requestAnimationFrame.bind(window);
  var queue = [], scheduled = 0, seq = 0, lastRun = -1e9;

  function pump(ts) {
    scheduled = 0;
    if (ts - lastRun < minGap) { scheduled = nativeRAF(pump); return; }
    lastRun = ts;
    var q = queue; queue = [];
    for (var i = 0; i < q.length; i++) {
      var e = q[i];
      if (!e.cancelled) {
        try { e.cb(ts); } catch (err) { setTimeout(function (x) { return function () { throw x; }; }(err)); }
      }
    }
  }

  window.requestAnimationFrame = function (cb) {
    var e = { id: ++seq, cb: cb, cancelled: false };
    queue.push(e);
    if (!scheduled) scheduled = nativeRAF(pump);
    return e.id;
  };
  window.cancelAnimationFrame = function (id) {
    for (var i = 0; i < queue.length; i++) if (queue[i].id === id) { queue[i].cancelled = true; return; }
  };
})();

(function () {
  'use strict';

  var Native = window.WebSocket;
  if (!Native || window.__PSF_WS_SHIM__) return;
  window.__PSF_WS_SHIM__ = true;

  var SMALL = 1024;
  var STALE_MS = 15000;   // no frames for this long on an open socket = treat as dead

  var page = (location.pathname.split('/').pop() || '').toLowerCase();
  // Text/list-heavy overlays: 20 updates/s is visually indistinguishable.
  var HEAVY = /^nr2003_(ticker|fox2010|fox2016|fox2004|fox2022|fox2026|foxindy2026|foxpersonal|prime|espn2010|espn2017|nbc2012|nbc2014|floracing|cw_overlay|livestandings|relative|championship)\.html$/;
  var maxHz = HEAVY.test(page) ? 20 : 0;            // 0 = one per display frame

  var qHz = parseFloat(new URLSearchParams(location.search).get('maxhz'));
  if (isFinite(qHz) && qHz >= 0) maxHz = qHz;
  // A cap at or above the rAF cap (default 60) can't show anything extra, so deliver
  // once per display frame instead: no setTimeout per frame, and updates stay aligned
  // with the frame they will be painted in.
  if (maxHz > 0 && window.__PSF_FPS > 0 && maxHz >= window.__PSF_FPS) maxHz = 0;
  var minGap = maxHz > 0 ? 1000 / maxHz : 0;

  var NativeAdd = Native.prototype.addEventListener;

  class PSFWebSocket extends Native {
    constructor(url, protocols) {
      if (protocols === undefined) super(url); else super(url, protocols);

      var self    = this;
      var handler = null;     // the page's ws.onmessage
      var pending = null;     // newest undelivered telemetry event
      var rafId   = 0;
      var timerId = 0;
      var last    = 0;        // time of last delivery

      function clearSched() {
        if (rafId)   { cancelAnimationFrame(rafId); rafId = 0; }
        if (timerId) { clearTimeout(timerId);       timerId = 0; }
      }

      function deliver(ev) {
        if (!handler) return;
        // stage_shim.js's corrected stage fields: this subclass reads the native socket directly, past stage_shim's own wrapper
        if (window.__stageShimWrap) { try { ev = window.__stageShimWrap(ev); } catch (e) { /* the frame as it came */ } }
        handler.call(self, ev);
      }

      function run() {
        clearSched();
        var ev = pending;
        if (!ev) return;
        var wait = minGap ? last + minGap - performance.now() : 0;
        if (wait > 1) { schedule(wait); return; }
        pending = null;
        last = performance.now();
        deliver(ev);
      }

      function schedule(delay) {
        if (rafId || timerId) return;
        if (delay > 0) { timerId = setTimeout(run, delay); return; }
        rafId   = requestAnimationFrame(run);
        timerId = setTimeout(run, 50);   // fallback when rAF is paused
      }

      // Watchdog: a socket can stay "open" but silently stop delivering (bridge hiccup,
      // sleep/resume, GPU/driver stall). The overlays only reconnect on 'close', so the
      // ticker would stay frozen forever. If nothing arrives for STALE_MS, close the
      // socket: the page's own onclose handler then reconnects (2 s later).
      var lastMsg = performance.now();
      var openedAt = lastMsg;
      var wd = setInterval(function () {
        var now = performance.now();
        if (self.readyState === 1 && now - lastMsg > STALE_MS) {
          lastMsg = now;
          try { console.warn('[psf-shim] stale socket, reconnecting'); self.close(); } catch (e) {}
        } else if (self.readyState === 0 && now - openedAt > 10000) {
          openedAt = now;
          try { self.close(); } catch (e) {}
        } else if (self.readyState === 3) {
          clearInterval(wd);
        }
      }, 3000);

      NativeAdd.call(self, 'message', function (ev) {
        lastMsg = performance.now();
        var data = ev.data;
        if (typeof data !== 'string' || data.length < SMALL) {
          // control message (e.g. reset): never drop, keep ordering
          if (pending) { var p = pending; pending = null; deliver(p); }
          deliver(ev);
          return;
        }
        pending = ev;                     // newest frame wins
        schedule(minGap ? Math.max(0, last + minGap - performance.now()) : 0);
      });

      NativeAdd.call(self, 'close', function () { pending = null; clearSched(); clearInterval(wd); });

      Object.defineProperty(self, 'onmessage', {
        configurable: true,
        enumerable: true,
        get: function () { return handler; },
        set: function (fn) { handler = (typeof fn === 'function') ? fn : null; }
      });
    }
  }

  window.WebSocket = PSFWebSocket;
})();
