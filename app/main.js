const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, globalShortcut, Notification, nativeImage } = require('electron');
const { buildRaceHtml } = require('./race-export');
const { parseRaceHtml } = require('./race-import');
const path   = require('path');
const gameExe = require('./gameexe');   // the game's process names (RaceLab's builds too)
const fs     = require('fs');
const { spawn, execFile, execSync } = require('child_process');
const { SeasonService } = require('./season');
const { AIService } = require('./ai');
const { StageFeed } = require('./stages/feed');
const ext = require('./extmods');
const schedule = require('./schedule');
const { RaceControlService } = require('./racecontrol');
const { QualBoxWindow } = require('./qualboxwindow');
const { PlayerOverlayWindow } = require('./playeroverlaywindow');
const { RadioVoiceWindow } = require('./aimod/voicewindow');
const { RcGfxWindow } = require('./rcgfxwindow');
const { RaceVisionService } = require('./racevision');
const { AimodService } = require('./aimod/service');
const { AiEnhancedService } = require('./aie/service');
const Wtdc = require('./windtunnel/wtdc');
const WindTunnelPro = require('./windtunnel/protune');
const { WindTunnelControl } = require('./windtunnel/control');
const { FieldService } = require('./field/service');
const { DirectorService } = require('./director/service');
const { journal: crashJournal } = require('./crashjournal');
const { Win32Memory } = require('./ai/memory');
const { Background } = require('./background');
let windTunnelControl = null;

function killPid(pid) {
  if (!pid) return;
  try { execSync(`taskkill /PID ${pid} /F /T`, { windowsHide: true }); } catch(e) {}
}

// ── Paths ──────────────────────────────────────────────────────────────────
const IS_PACKAGED   = app.isPackaged;
const APP_DIR       = IS_PACKAGED ? app.getAppPath() : __dirname;
const RESOURCES_DIR = IS_PACKAGED ? process.resourcesPath : __dirname;
const INSTALL_DIR   = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const USER_DATA     = app.getPath('userData');
const CONFIG_PATH   = path.join(USER_DATA, 'config.json');
const CALIB_PATH    = path.join(USER_DATA, 'calibration.json');
const BRIDGE_EXE    = path.join(IS_PACKAGED ? process.resourcesPath : __dirname, 'nr2003_bridge.exe');
const SHIM_EXE      = path.join(IS_PACKAGED ? process.resourcesPath : __dirname, 'nr2003_shim.exe');
const SERIES_DIR    = path.join(USER_DATA, 'series');
const TRACKS_DIR    = path.join(USER_DATA, 'tracks');
const SOUNDS_DIR    = path.join(USER_DATA, 'sounds');
const IMAGES_DIR    = path.join(USER_DATA, 'images');

// ── Seed data on first run ─────────────────────────────────────────────────
// Copy bundled series/tracks/sounds/images from install dir to userData
// so all user data lives in one writable location (AppData)
function seedUserData() {
  const seedLog = [];
  const dirs        = ['series', 'tracks', 'sounds', 'images', 'fonts'];
  const overwriteDirs = ['extras'];  // app-owned files — always overwrite on update
  for (const dir of dirs) {
    // Try INSTALL_DIR first, then resourcesPath as fallback
    let src = path.join(INSTALL_DIR, dir);
    if (!fs.existsSync(src)) {
      src = path.join(process.resourcesPath, dir);
    }
    const dest = path.join(USER_DATA, dir);
    seedLog.push(`${dir}: src=${src} srcExists=${fs.existsSync(src)} destExists=${fs.existsSync(dest)}`);
    if (!fs.existsSync(src)) {
      seedLog.push(`  → SKIP: src missing`);
      continue;
    }
    if (!fs.existsSync(dest)) {
      try {
        copyDirRecursive(src, dest);
        seedLog.push(`  → COPIED OK (fresh)`);
      } catch(e) {
        seedLog.push(`  → COPY FAILED: ${e.message}`);
      }
    } else {
      // Dest folder already exists — still walk and fill in any missing files.
      // copyDirRecursive only copies files that don't already exist at the
      // destination, so this safely fills gaps without touching user data.
      try {
        copyDirRecursive(src, dest);
        seedLog.push(`  → MERGED (dest existed, filled missing files)`);
      } catch(e) {
        seedLog.push(`  → MERGE FAILED: ${e.message}`);
      }
    }
  }

  // NBC 2014: default editable logo -> <userData>/images/NBC2014/nbc_logo.png (never overwritten once it exists)
  try {
    const nbcDest = path.join(USER_DATA, 'images', 'NBC2014', 'nbc_logo.png');
    if (!fs.existsSync(nbcDest)) {
      fs.mkdirSync(path.dirname(nbcDest), { recursive: true });
      fs.copyFileSync(path.join(__dirname, 'static', 'images', 'NBC2014', 'nbc_logo.png'), nbcDest);
      seedLog.push('NBC2014/nbc_logo.png seeded');
    }
  } catch(e) { seedLog.push('NBC2014 logo seed failed: ' + e.message); }

  // App-owned folders — always overwrite (e.g. extras/racestats.html updates on reinstall)
  for (const dir of overwriteDirs) {
    let src = path.join(INSTALL_DIR, dir);
    if (!fs.existsSync(src)) src = path.join(process.resourcesPath, dir);
    const dest = path.join(USER_DATA, dir);
    seedLog.push(`${dir} (overwrite): src=${src} srcExists=${fs.existsSync(src)}`);
    if (!fs.existsSync(src)) { seedLog.push(`  → SKIP: src missing`); continue; }
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        if (!entry.isDirectory())
          fs.copyFileSync(path.join(src, entry.name), path.join(dest, entry.name));
      }
      seedLog.push(`  → OVERWRITTEN OK`);
    } catch(e) { seedLog.push(`  → OVERWRITE FAILED: ${e.message}`); }
  }

  // Seed video files — copied to resources/ since extraResources handles them there reliably
  const videoFiles = [
    { src: 'checkered.webm',      dest: path.join(USER_DATA, 'images', 'Fox2026', 'checkered.webm') },
    { src: 'greencheckered.webm', dest: path.join(USER_DATA, 'images', 'Fox2026', 'greencheckered.webm') },
  ];
  for (const vf of videoFiles) {
    const src = path.join(process.resourcesPath, vf.src);
    seedLog.push(`video ${vf.src}: src exists=${fs.existsSync(src)}`);
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(path.dirname(vf.dest), { recursive: true });
        fs.copyFileSync(src, vf.dest);
        seedLog.push(`  → ${vf.src} copied OK`);
      } catch(e) { seedLog.push(`  → ${vf.src} failed: ${e.message}`); }
    }
  }

  // Copy widget HTML files to AppData so the HTTP server can read them
  const widgetFiles = [
    'nr2003_dash.html', 'nr2003_input.html', 'nr2003_relative.html',
    'nr2003_trackmap.html', 'nr2003_deltabar.html', 'nr2003_livestandings.html',
    'nr2003_battle.html', 'nr2003_ticker.html', 'nr2003_radar.html',
    'nr2003_pitspeed.html', 'nr2003_fox2022.html', 'nr2003_foxpersonal.html',
    'nr2003_cw_overlay.html', 'nr2003_floracing.html', 'nr2003_espn2010.html', 'nr2003_espn2011.html', 'nr2003_espn2017.html', 'nr2003_nbc2012.html', 'nr2003_nbc2014.html', 'nr2003_nbc2016.html', 'nr2003_nbc2017shart.html', 'nr2003_fox2010.html', 'nr2003_fox2016.html', 'nr2003_fox2004.html', 'nr2003_prime.html', 'nr2003_fox2026.html', 'nr2003_foxindy2026.html', 'nr2003_tnt2026.html', 'nr2003_nbc2019.html',
    'nr2003_championship.html', 'nr2003_season.html', 'nr2003_results.html',
  ];
  // Try multiple source locations — packaged apps may have files in different places
  const srcRoots = [
    APP_DIR,
    path.join(process.resourcesPath || '', 'app'),
    path.join(process.resourcesPath || '', 'app.asar'),
    process.resourcesPath || '',
    INSTALL_DIR,
  ].filter(Boolean);

  try { fs.unlinkSync(path.join(USER_DATA, 'nr2003_startgrid.html')); } catch (e) {}   // removed widget

  for (const file of widgetFiles) {
    const dest = path.join(USER_DATA, file);
    let copied = false;
    for (const root of srcRoots) {
      const src = path.join(root, file);
      try {
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dest);
          copied = true;
          break;
        }
      } catch(e) {}
    }
    if (!copied) seedLog.push(`  Widget ${file}: no source found in any root`);
  }
  // Race Stats web page (bundled in the app): refresh every copy that already exists, and always keep extras/nr2003_racestats.html current
  try {
    const rsSrc = path.join(__dirname, 'nr2003_racestats.html');
    if (fs.existsSync(rsSrc)) {
      const rsTargets = [
        path.join(USER_DATA, 'extras', 'nr2003_racestats.html'),
        path.join(USER_DATA, 'extras', 'racestats.html'),
        path.join(USER_DATA, 'nr2003_racestats.html'),
        path.join(USER_DATA, 'racestats.html'),
        path.join(INSTALL_DIR, 'extras', 'nr2003_racestats.html'),
        path.join(INSTALL_DIR, 'extras', 'racestats.html'),
      ];
      // The page on :8766 is served by another process whose folder we don't know: also refresh any copy found near the app / user data
      const _found = [];
      const _scan = (dir, depth) => {
        if (depth < 0) return;
        let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const en of ents) {
          const f = path.join(dir, en.name);
          if (en.isDirectory()) { if (!/^(node_modules|\.git|series|tracks|sounds|images|fonts|Cache|Code Cache|GPUCache)$/i.test(en.name) && !/\.asar$/i.test(en.name)) _scan(f, depth - 1); }
          else if (/^(nr2003_)?racestats\.html$/i.test(en.name)) _found.push(f);
        }
      };
      [USER_DATA, INSTALL_DIR, path.dirname(INSTALL_DIR)].forEach(r => _scan(r, 3));
      _found.forEach(f => { if (!rsTargets.includes(f)) rsTargets.push(f); });
      rsTargets.forEach((t, i) => {
        try {
          if (i === 0) fs.mkdirSync(path.dirname(t), { recursive: true });
          if (i === 0 || fs.existsSync(t)) { fs.copyFileSync(rsSrc, t); seedLog.push('racestats page -> ' + t); }
        } catch (e) { seedLog.push('racestats page FAILED ' + t + ': ' + e.message); }
      });
    }
  } catch (e) {}
  return seedLog;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath  = path.join(src,  entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      // Don't overwrite existing user files (e.g. bestlap.json they recorded)
      if (!fs.existsSync(destPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}

// Debug log — written to userData so we can read it after launch
function writeDebugLog(seedLog) {
  try {
    const logPath = path.join(app.getPath('userData'), 'debug.log');
    const lines = [
      `IS_PACKAGED: ${IS_PACKAGED}`,
      `process.resourcesPath: ${process.resourcesPath}`,
      `process.execPath: ${process.execPath}`,
      `APP_DIR: ${APP_DIR}`,
      `RESOURCES_DIR: ${RESOURCES_DIR}`,
      `INSTALL_DIR: ${INSTALL_DIR}`,
      `USER_DATA: ${USER_DATA}`,
      `BRIDGE_EXE: ${BRIDGE_EXE}`,
      `BRIDGE exists: ${fs.existsSync(BRIDGE_EXE)}`,
      `SHIM_EXE: ${SHIM_EXE}`,
      `SHIM exists: ${fs.existsSync(SHIM_EXE)}`,
      `SERIES_DIR: ${SERIES_DIR}`,
      `SERIES exists: ${fs.existsSync(SERIES_DIR)}`,
      `INSTALL_DIR series: ${path.join(INSTALL_DIR, 'series')}`,
      `INSTALL_DIR series exists: ${fs.existsSync(path.join(INSTALL_DIR, 'series'))}`,
      `RESOURCES series: ${path.join(process.resourcesPath, 'series')}`,
      `RESOURCES series exists: ${fs.existsSync(path.join(process.resourcesPath, 'series'))}`,
      '',
      '--- SEED LOG ---',
      ...(seedLog || []),
    ];
    fs.writeFileSync(logPath, lines.join('\n'), 'utf8');
  } catch(e) {}
}

// ── State ──────────────────────────────────────────────────────────────────
let mainWindow   = null;   // control UI window
let companionsWindow = null;
const overlayWindows = {};  // { widgetId: BrowserWindow }
let bridgeProc   = null;   // nr2003_bridge.exe process
let shimProc     = null;   // nr2003_shim.exe process
let config       = {};
let deltabarHidden  = false;
let nr2003Running   = false;  // tracks NR2003.exe process state
let nr2003PollTimer = null;
let editModeActive  = false;  // live edit mode

// ── Edit mode constants ─────────────────────────────────────────────────────
const EDIT_MIN_SCALE = 0.3;
const EDIT_MAX_SCALE = 3.0;
const SNAP_THRESHOLD = 10;

// ── Edit mode injected script (runs inside each overlay BrowserWindow) ──────
// Built as a template string — JS that gets executeJavaScript'd into widgets
function buildEditModeScript(id, scale, opacity, baseW, baseH) {
  return `(function() {
  if (window.__psfEditMode) return;
  window.__psfEditMode = true;

  var BASE_W = ${baseW};
  var BASE_H = ${baseH};
  var curScale   = ${scale};
  var curOpacity = ${opacity};
  var MIN_SCALE  = ${EDIT_MIN_SCALE};
  var MAX_SCALE  = ${EDIT_MAX_SCALE};
  var MIN_OPACITY = 0.1;

  // Find the element that has the scale transform applied
  var widgetRoot = document.getElementById('scale-root') ||
                   document.getElementById('widget') ||
                   document.querySelector('.dash') ||
                   document.querySelector('.widget');

  // Hide scrollbars, allow overflow
  document.documentElement.style.overflow = 'hidden';
  document.documentElement.style.width    = '100vw';
  document.documentElement.style.height   = '100vh';
  document.body.style.overflow   = 'visible';
  document.body.style.width      = '0';
  document.body.style.height     = '0';
  document.body.style.cursor     = 'move';
  document.body.style.userSelect = 'none';
  document.body.style.position   = 'relative';

  // ── editWrap: overlay div on body, matches widgetRoot transform ───────
  // Lives on body so widget show/hide logic can't affect it.
  // Receives all mouse events for drag and resize.
  var editWrap = document.createElement('div');
  editWrap.id = '__psf_wrap';
  var initT = widgetRoot ? (widgetRoot.style.transform || 'scale(1)') : 'scale(1)';
  editWrap.style.cssText = 'position:absolute;top:0;left:0;box-sizing:border-box;' +
    'width:' + BASE_W + 'px;height:' + BASE_H + 'px;' +
    'transform-origin:top left;transform:' + initT + ';' +
    'z-index:999980;cursor:move;' +
    'outline:2px solid #3a7bd5;outline-offset:-2px;' +
    'background:repeating-linear-gradient(-45deg,' +
    'rgba(58,123,213,0.18) 0px,rgba(58,123,213,0.18) 2px,' +
    'rgba(10,15,30,0.3) 2px,rgba(10,15,30,0.3) 10px);';
  document.body.appendChild(editWrap);

  // ── Label ─────────────────────────────────────────────────────────────
  var lbl = document.createElement('div');
  lbl.id = '__psf_lbl';
  lbl.style.cssText = 'position:absolute;top:4px;left:50%;transform:translateX(-50%);' +
    'background:rgba(58,123,213,0.95);color:#fff;font-size:11px;font-weight:700;' +
    'padding:3px 10px;border-radius:3px;pointer-events:none;z-index:1000001;' +
    'letter-spacing:1px;font-family:sans-serif;white-space:nowrap;' +
    'box-shadow:0 1px 4px rgba(0,0,0,0.5);';
  lbl.textContent = '${id}'.toUpperCase();
  // label appended after handles below so it stacks on top

  // ── HUD ───────────────────────────────────────────────────────────────
  var hud = document.createElement('div');
  hud.id = '__psf_hud';
  hud.style.cssText = 'position:absolute;bottom:4px;left:50%;transform:translateX(-50%);' +
    'background:rgba(0,0,0,0.75);color:#fff;font-size:10px;font-weight:700;' +
    'padding:2px 8px;border-radius:3px;pointer-events:none;z-index:1000001;' +
    'font-family:sans-serif;white-space:nowrap;display:none;';
  editWrap.appendChild(hud);
  var hudTimer = null;
  function showHud(text) {
    hud.textContent = text;
    hud.style.display = 'block';
    if (hudTimer) clearTimeout(hudTimer);
    hudTimer = setTimeout(function() { hud.style.display='none'; }, 1200);
  }

  // ── Resize handles on editWrap ────────────────────────────────────────
  var SZ = 14;
  var handleDefs = [
    ['n',  'top:0;left:'+SZ+'px;right:'+SZ+'px;height:'+SZ+'px;cursor:n-resize;',    0, -1],
    ['s',  'bottom:0;left:'+SZ+'px;right:'+SZ+'px;height:'+SZ+'px;cursor:s-resize;',  0,  1],
    ['e',  'right:0;top:'+SZ+'px;bottom:'+SZ+'px;width:'+SZ+'px;cursor:e-resize;',    1,  0],
    ['w',  'left:0;top:'+SZ+'px;bottom:'+SZ+'px;width:'+SZ+'px;cursor:w-resize;',    -1,  0],
    ['ne', 'top:0;right:0;width:'+SZ+'px;height:'+SZ+'px;cursor:ne-resize;',           1, -1],
    ['nw', 'top:0;left:0;width:'+SZ+'px;height:'+SZ+'px;cursor:nw-resize;',           -1, -1],
    ['se', 'bottom:0;right:0;width:'+SZ+'px;height:'+SZ+'px;cursor:se-resize;',        1,  1],
    ['sw', 'bottom:0;left:0;width:'+SZ+'px;height:'+SZ+'px;cursor:sw-resize;',        -1,  1],
  ];
  handleDefs.forEach(function(def) {
    var h = document.createElement('div');
    h.className = '__psf_handle';
    h.style.cssText = 'position:absolute;z-index:999999;' +
      'background:rgba(58,123,213,0.9);border-radius:2px;' + def[1];
    h.addEventListener('mousedown', function(e) { onHandleDown(e, def[2], def[3]); });
    editWrap.appendChild(h);
  });

  // Append label after handles so it sits on top in DOM order
  editWrap.appendChild(lbl);

  // ── Drag to move ──────────────────────────────────────────────────────
  var dragging = false, offsetX = 0, offsetY = 0;

  editWrap.addEventListener('mousedown', function(e) {
    if (e.target.classList.contains('__psf_handle')) return;
    dragging = true;
    window.shl.getWindowPosition().then(function(pos) {
      offsetX = e.screenX - pos.x;
      offsetY = e.screenY - pos.y;
    });
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup',   onDragUp);
    e.preventDefault();
  });

  function onDragMove(e) {
    if (!dragging) return;
    window.shl.setWindowPosition(
      Math.round(e.screenX - offsetX),
      Math.round(e.screenY - offsetY)
    );
  }

  function onDragUp() {
    dragging = false;
    window.removeEventListener('mousemove', onDragMove);
    window.removeEventListener('mouseup',   onDragUp);
    window.shl.snapWindow();
  }

  // ── Scale via handles ─────────────────────────────────────────────────
  var resizing = false, resizeStartX = 0, resizeStartY = 0;
  var resizeStartScale = 1, resizeSignX = 1, resizeSignY = 0;

  function onHandleDown(e, signX, signY) {
    e.stopPropagation();
    resizing = true;
    resizeStartX = e.screenX; resizeStartY = e.screenY;
    resizeStartScale = curScale;
    resizeSignX = signX; resizeSignY = signY;
    window.addEventListener('mousemove', onResizeMove);
    window.addEventListener('mouseup',   onResizeUp);
    e.preventDefault();
  }

  function onResizeMove(e) {
    if (!resizing) return;
    var dx = (e.screenX - resizeStartX) * resizeSignX;
    var dy = (e.screenY - resizeStartY) * resizeSignY;
    var delta = (Math.abs(dx) >= Math.abs(dy)) ? dx : dy;
    var s = Math.min(MAX_SCALE, Math.max(MIN_SCALE,
      resizeStartScale + delta * 0.005));
    curScale = s;
    var t = 'scale(' + s + ')';
    if (widgetRoot) widgetRoot.style.transform = t;
    editWrap.style.transform = t;
    window.shl.setWindowSize(s, BASE_W, BASE_H);
    showHud('Scale: ' + s.toFixed(2));
  }

  function onResizeUp() {
    resizing = false;
    window.removeEventListener('mousemove', onResizeMove);
    window.removeEventListener('mouseup',   onResizeUp);
    window.shl.saveWidgetScale(curScale);
  }

  // ── Scroll wheel = opacity ────────────────────────────────────────────
  function applyLiveOpacityPreview(o) {
    // Widget-specific hook — takes priority if defined (e.g. radar bg-only opacity)
    if (typeof window.__psfApplyOpacity === 'function') {
      window.__psfApplyOpacity(o);
      return;
    }
    // Most widgets use a --bg-a CSS variable
    document.documentElement.style.setProperty('--bg-a', o);
    // dash/battle set an inline rgba(...) background directly — rewrite
    // just the alpha channel on whatever element actually has one set,
    // so text/data stays fully opaque like the real saved result.
    document.querySelectorAll('*').forEach(function(el) {
      var bg = el.style && el.style.background;
      if (bg && bg.indexOf('rgba(') === 0) {
        var m = bg.match(/rgba\(([^,]+),([^,]+),([^,]+),([^)]+)\)/);
        if (m) el.style.background = 'rgba(' + m[1] + ',' + m[2] + ',' + m[3] + ',' + o + ')';
      }
    });
  }

  window.addEventListener('wheel', function(e) {
    e.preventDefault();
    e.stopPropagation();
    var delta = e.deltaY > 0 ? -0.05 : 0.05;
    curOpacity = Math.min(1.0, Math.max(MIN_OPACITY,
      Math.round((curOpacity + delta) * 20) / 20));
    // Mirror how each widget actually applies opacity (background alpha
    // only, not the whole element) so the live preview matches the saved
    // result instead of fading text/data along with the background.
    applyLiveOpacityPreview(curOpacity);
    window.shl.saveWidgetOpacity(curOpacity);
    showHud('Opacity: ' + Math.round(curOpacity * 100) + '%');
  }, { passive: false, capture: true });

  // ── Exit ──────────────────────────────────────────────────────────────
  window.__psfExitEditMode = function() {
    document.documentElement.style.overflow = '';
    document.documentElement.style.width    = '';
    document.documentElement.style.height   = '';
    document.documentElement.style.opacity  = '';
    document.body.style.overflow   = '';
    document.body.style.width      = '';
    document.body.style.height     = '';
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    document.body.style.position   = '';
    var wrap = document.getElementById('__psf_wrap');
    if (wrap) wrap.remove();
    window.__psfEditMode = false;
  };

})();`;
}


// ── Global hotkeys only while the game is in front ──────────────────────────
// A registered global shortcut is taken away from EVERY other program (typing, Ctrl+Shift+R in the
// browser, Tab...). So the hotkeys are registered only while NR2003 is the foreground window (or an
// overlay is being edited) and released the moment you switch to any other app.
let hotkeysActive = false;
let fgState = { known: false, pid: 0, name: '' };
let fgProc = null;

function gameProcName() { return gameExe.procNames(config)[0]; }
function gameProcList() { return gameExe.psArray(config); }   // PowerShell @('nr2003','nr2003_racelabv2',...): RaceLab's game builds too
function hotkeysShouldBeActive() {
  if (process.platform !== 'win32') return true;               // no foreground detection: old behaviour
  if (!fgState.known) return !!shimProc;                        // watcher not available: only while a game session runs
  if (fgState.pid === process.pid) return !!editModeActive;     // our own windows: only while editing overlays
  return gameExe.procNames(config).includes(fgState.name.toLowerCase());
}
let tabHotkeyOn = false;
function registerTabHotkey() {
  if (tabHotkeyOn) { try { globalShortcut.unregister('Tab'); } catch (e) {} tabHotkeyOn = false; }
  if (!hotkeysActive) return;
  try {
    tabHotkeyOn = globalShortcut.register('Tab', () => {
      const win = overlayWindows['deltabar'];
      if (!win || win.isDestroyed()) return;
      deltabarHidden = !deltabarHidden;
      const opacity = deltabarHidden ? 0 : (getActiveWidgets().deltabar?.opacity ?? 1);
      win.webContents.executeJavaScript(
        `(function(){
          const r = document.querySelector('.widget') || document.getElementById('scale-root');
          if (r) r.style.opacity = '${opacity}';
        })()`
      ).catch(() => {});
    });
  } catch (e) { tabHotkeyOn = false; }
}
function applyHotkeyGate() {
  if (isQuitting) return;
  const want = hotkeysShouldBeActive();
  if (want === hotkeysActive) return;
  hotkeysActive = want;
  registerEditHotkey();
  registerReopenHotkey();
  registerResyncHotkey();
  registerPointsHotkey();
  registerTop3Hotkey();
  registerDriverInfoHotkey();
  registerTabHotkey();
}
function startForegroundWatcher() {
  if (process.platform !== 'win32' || fgProc) return;
  const script =
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class FG{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);}';" +
    "while($true){$h=[FG]::GetForegroundWindow();$p=[uint32]0;[void][FG]::GetWindowThreadProcessId($h,[ref]$p);$n='';try{$n=(Get-Process -Id $p -ErrorAction Stop).ProcessName}catch{};[Console]::WriteLine(\"$p|$n\");Start-Sleep -Milliseconds 400}";
  try {
    const { spawn } = require('child_process');
    fgProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
                   { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    fgProc.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        const m = line.match(/^(\d+)\|(.*)$/);
        if (!m) continue;
        fgState = { known: true, pid: parseInt(m[1], 10), name: m[2] || '' };
        applyHotkeyGate();
      }
    });
    const lost = () => { fgProc = null; fgState = { known: false, pid: 0, name: '' }; applyHotkeyGate(); };
    fgProc.on('exit', lost);
    fgProc.on('error', lost);
  } catch (e) { fgProc = null; }
}
function stopForegroundWatcher() {
  if (!fgProc) return;
  const p = fgProc; fgProc = null;
  try { killPid(p.pid); } catch (e) {}
  try { p.kill(); } catch (e) {}
}


// ── Observed-car reader ─────────────────────────────────────────────────────
// NR2003's telemetry never says which car the camera is on, but the game keeps the race position of the car being watched at a fixed
// address (nr2003.exe + 0x8B97B4, found with Cheat Engine). A hidden PowerShell polls it (read-only) and the Driver Info banner uses it.
let camProc = null;
let camCar = -1, camCarRaw = -1;      // carIdx of the car on screen (from a second memory address), -1 = unknown
const CAM_CAR_BASE = 35, CAM_CAR_STRIDE = 64;   // raw value = BASE + STRIDE * carIdx (checked on 6 cars)
let carNums = {};                      // carIdx -> car number, reported by the hidden recorder window from the telemetry
function camNumber() { return (camCar >= 0 && carNums[camCar] !== undefined) ? String(carNums[camCar]) : ''; }
let camPos = -1;                       // race position (1 = leader) of the car on screen, -1 = unknown / game not running
let _camBytesLast = '';
function logCamBytes(hex) {
  if (!hex || hex === _camBytesLast) return; _camBytesLast = hex;
  try {
    const f = path.join(USER_DATA, 'cam-bytes-log.txt');
    try { if (fs.statSync(f).size > 2 * 1024 * 1024) fs.writeFileSync(f, ''); } catch (e) {}
    const first = /^[0-9A-F]{2}/i.test(hex) ? parseInt(hex.slice(0, 2), 16) : -1;
    fs.appendFile(f, `${new Date().toISOString()}  first=${first}  bytes=${hex}  camPos=${camPos}  camCar=${camCar}\n`, () => {});
  } catch (e) {}
}
let _camSent = '';
function broadcastCam() {
  const msg = { pos: camPos, idx: camCar, raw: camCarRaw, num: camNumber() }, key = camPos + '|' + camCar + '|' + camCarRaw + '|' + msg.num;
  if (key === _camSent) return; _camSent = key;
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send('cam-changed', msg); } catch (e) {} }
}
function logCam(msg) {
  try { fs.appendFile(path.join(USER_DATA, 'cam-bytes-log.txt'), new Date().toISOString() + '  ' + msg + '\n', () => {}); } catch (e) {}
}
function startCamReader() {
  if (process.platform !== 'win32' || camProc) return;
  const procName = gameProcList();
  // Only address read: NR2003.exe+0x85C274 (offset from the module base, as Cheat Engine shows it), 4-byte value = carIdx << 8.
  // config.cam_idx_abs = true treats cam_idx_addr as an absolute address instead.
  const addr = (() => { const v = parseInt(String(config.cam_idx_addr || '0x85C274'), 16); return (v > 0 && v < 0x7FFFFFFF) ? v : 0x85C274; })();
  const absMode = (config.cam_idx_abs === true) ? 1 : 0;
  const script = `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MEM{[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(uint a,bool b,int p);[DllImport("kernel32.dll")]public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int n,out int r);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}'
$name=${procName};$off=[int64]${addr};$abs=${absMode};$addr=[IntPtr]::Zero;$h=[IntPtr]::Zero;$last=''
$b=New-Object byte[] 4;$r=0
while($true){
  if($h -eq [IntPtr]::Zero){
    $p=Get-Process -Name $name -ErrorAction SilentlyContinue|Select-Object -First 1
    if($p){$h=[MEM]::OpenProcess(0x410,$false,$p.Id)}
    if($h -ne [IntPtr]::Zero){if($abs -eq 1){$addr=[IntPtr]$off}else{$base=[int64]$p.MainModule.BaseAddress;if($base -le 0){[void][MEM]::CloseHandle($h);$h=[IntPtr]::Zero}else{$addr=[IntPtr]($base+$off)}};if($h -ne [IntPtr]::Zero){[Console]::WriteLine('A '+([int64]$addr).ToString('X'))}}
    if($h -eq [IntPtr]::Zero){if($last -ne '-1'){[Console]::WriteLine('-1');$last='-1'};Start-Sleep -Milliseconds 1000;continue}
  }
  if([MEM]::ReadProcessMemory($h,$addr,$b,4,[ref]$r) -and $r -eq 4){$cur=[string][BitConverter]::ToInt32($b,0)}else{$cur='-1';[void][MEM]::CloseHandle($h);$h=[IntPtr]::Zero}
  if($cur -ne $last){[Console]::WriteLine($cur);$last=$cur}
  Start-Sleep -Milliseconds 5
}`;
  try {
    const { spawn } = require('child_process');
    camProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
                    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    camProc.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line[0] === 'A') { logCam('addr ' + line.slice(2)); continue; }
        const v = parseInt(line, 10);
        camPos = -1;   // race position is no longer read: the banner uses the carIdx directly
        camCarRaw = Number.isFinite(v) ? v : -1;
        camCar = (Number.isFinite(v) && v >= 0 && (v & 0xFF) === 0 && (v >>> 16) === 0 && (v >> 8) <= 127) ? (v >> 8) : -1;
        logCam('raw=' + camCarRaw + ' hex=' + (camCarRaw >>> 0).toString(16) + ' carIdx=' + camCar);
        broadcastCam();
      }
    });
    const lost = () => { camProc = null; camPos = -1; camCar = -1; camCarRaw = -1; };
    camProc.on('exit', lost);
    camProc.on('error', lost);
  } catch (e) { camProc = null; camPos = -1; camCar = -1; camCarRaw = -1; }
}
function stopCamReader() {
  if (!camProc) return;
  const p = camProc; camProc = null; camPos = -1; camCar = -1; camCarRaw = -1;
  try { killPid(p.pid); } catch (e) {}
  try { p.kill(); } catch (e) {}
}
// Show a car on screen: writes carIdx << 8 to the address the observed-car reader polls.
// The game puts the camera back on its own car after a moment, so the value is re-written every ~30 ms by one hidden PowerShell until
// the user releases it (carIdx = -1, or clicking the same driver again), the game closes, or the app quits.
let watchProc = null, watchIdx = -1;
function stopWatch() {
  const p = watchProc; watchProc = null; watchIdx = -1;
  if (!p) return;
  try { killPid(p.pid); } catch (e) {}
  try { p.kill(); } catch (e) {}
}
function watchCar(idx) {
  return new Promise(resolve => {
    idx = parseInt(idx, 10);
    if (idx === -1) { stopWatch(); logCam('watchCar released'); return resolve(true); }
    if (process.platform !== 'win32' || !Number.isFinite(idx) || idx < 0 || idx > 127) return resolve(false);
    stopWatch();
    const procName = gameProcList();
    const addr = (() => { const v = parseInt(String(config.cam_idx_addr || '0x85C274'), 16); return (v > 0 && v < 0x7FFFFFFF) ? v : 0x85C274; })();
    const absMode = (config.cam_idx_abs === true) ? 1 : 0;
    const script = `$ErrorActionPreference='SilentlyContinue'
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MW{[DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(uint a,bool b,int p);[DllImport("kernel32.dll")]public static extern bool WriteProcessMemory(IntPtr h,IntPtr a,byte[] b,int n,out int w);[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);}'
$p=Get-Process -Name ${procName} -ErrorAction SilentlyContinue|Select-Object -First 1
if(-not $p){[Console]::WriteLine('nogame');exit}
$h=[MW]::OpenProcess(0x38,$false,$p.Id)
if($h -eq [IntPtr]::Zero){[Console]::WriteLine('noaccess');exit}
if(${absMode} -eq 1){$a=[IntPtr][int64]${addr}}else{$a=[IntPtr]([int64]$p.MainModule.BaseAddress+[int64]${addr})}
$b=[BitConverter]::GetBytes([int](${idx} -shl 8));$w=0
$first=$true
while($true){
  $ok=[MW]::WriteProcessMemory($h,$a,$b,4,[ref]$w)
  if($first){if($ok -and $w -eq 4){[Console]::WriteLine('ok')}else{[Console]::WriteLine('failed');exit};$first=$false}
  elseif(-not $ok){break}
  if($p.HasExited){break}
  Start-Sleep -Milliseconds 30
}
[void][MW]::CloseHandle($h)`;
    let done = false, out = '';
    const finish = ok => { if (done) return; done = true; clearTimeout(tm); logCam('watchCar idx=' + idx + ' -> ' + (out || 'no output')); if (!ok && watchProc === proc) stopWatch(); resolve(ok); };
    let proc;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
                   { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) { return resolve(false); }
    watchProc = proc; watchIdx = idx;
    const tm = setTimeout(() => finish(false), 6000);
    proc.stdout.on('data', c => { if (done) return; out += c.toString('utf8'); if (out.indexOf('\n') >= 0) { out = out.split(/\r?\n/)[0].trim(); finish(out === 'ok'); } });
    proc.on('exit', () => { if (watchProc === proc) { watchProc = null; watchIdx = -1; } finish(false); });
    proc.on('error', () => { if (watchProc === proc) { watchProc = null; watchIdx = -1; } finish(false); });
  });
}
// ── Pit-out message reader ──────────────────────────────────────────────────
// NR2003 prints "AIPIT OUT 84: 16.00" on screen when an AI car (84) leaves the pits (16.00 s = time on pit road). The text is not in the telemetry,
// so a hidden PowerShell scans the game's memory (read-only) for that text and reports every new message. Each message = one pit stop of that car.
let pitOutProc = null, pitOutConfirmed = false, pitOutSeq = 0;
const pitOutCarAt = {}, pitOutSeen = {};      // car -> time of the last accepted message; "car|time" -> time (messages can be copied in several places of the game's memory)
function logPitOut(msg) {
  try {
    const f = path.join(USER_DATA, 'pitout-log.txt');
    try { if (fs.statSync(f).size > 1024 * 1024) fs.writeFileSync(f, ''); } catch (e) {}
    fs.appendFile(f, new Date().toISOString() + '  ' + msg + '\n', () => {});
  } catch (e) {}
}
function broadcastPitOutStatus() {
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send('pitout-status', pitOutConfirmed); } catch (e) {} }
}
function onPitOutMessage(car, time) {
  const now = Date.now();
  if (!/^\d{1,4}$/.test(car)) return;
  const k = car + '|' + time;
  if (pitOutSeen[k] && now - pitOutSeen[k] < 5 * 60000) { logPitOut('dup ' + k); return; }
  pitOutSeen[k] = now;
  if (pitOutCarAt[car] && now - pitOutCarAt[car] < 45000) { logPitOut('ignored (same car within 45 s) ' + k); return; }   // a half-written copy of the same message
  pitOutCarAt[car] = now;
  const id = (++pitOutSeq) + '|' + k;
  logPitOut('PIT OUT car=' + car + ' time=' + time + ' id=' + id);
  if (!pitOutConfirmed) { pitOutConfirmed = true; broadcastPitOutStatus(); }
  const msg = { id, car, time: Number(time), at: now };
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send('pitout', msg); } catch (e) {} }
}
function startPitOutReader() {
  if (process.platform !== 'win32' || pitOutProc || config.pitout_reader === false) return;
  const procName = gameProcList();
  const script = String.raw`$ErrorActionPreference='SilentlyContinue'
try{[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass='BelowNormal'}catch{}
$src=@'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public class PO{
  [DllImport("kernel32.dll")]public static extern IntPtr OpenProcess(uint a,bool b,int p);
  [DllImport("kernel32.dll")]public static extern bool ReadProcessMemory(IntPtr h,IntPtr a,byte[] b,int n,out int r);
  [DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")]public static extern int VirtualQueryEx(IntPtr h,IntPtr a,out MBI m,int len);
  [StructLayout(LayoutKind.Sequential)]public struct MBI{public IntPtr BaseAddress;public IntPtr AllocationBase;public uint AllocationProtect;public IntPtr RegionSize;public uint State;public uint Protect;public uint Type;}
  static byte[] P=Encoding.ASCII.GetBytes("AIPIT OUT ");
  public static List<string> Scan(IntPtr h,long max){
    List<string> res=new List<string>();long addr=0x10000;byte[] buf=new byte[1<<20];MBI m;int sz=Marshal.SizeOf(typeof(MBI));
    while(addr<max){
      if(VirtualQueryEx(h,(IntPtr)addr,out m,sz)==0)break;
      long b=(long)m.BaseAddress,len=(long)m.RegionSize;
      if(len<=0)break;
      bool ok=m.State==0x1000&&(m.Protect&0x100)==0&&(m.Protect&0xEE)!=0;
      if(ok){
        long o=0;
        while(o<len){
          int want=(int)Math.Min((long)buf.Length,len-o);int r;
          if(!ReadProcessMemory(h,(IntPtr)(b+o),buf,want,out r)||r<=0)break;
          int last=r-P.Length-2;
          for(int i=0;i<=last;i++){
            if(buf[i]!=0x41)continue;
            bool hit=true;for(int k=1;k<P.Length;k++){if(buf[i+k]!=P[k]){hit=false;break;}}
            if(!hit)continue;
            int j=i+P.Length,s=j;
            while(j<r&&buf[j]>=48&&buf[j]<=57&&j-s<5)j++;
            if(j==s||j>=r)continue;
            string car=Encoding.ASCII.GetString(buf,s,j-s);
            while(j<r&&buf[j]==32)j++;
            if(j>=r||buf[j]!=58)continue;
            j++;while(j<r&&buf[j]==32)j++;
            int t=j;while(j<r&&((buf[j]>=48&&buf[j]<=57)||buf[j]==46)&&j-t<8)j++;
            if(j==t||j>=r)continue;
            res.Add((b+o+i).ToString()+"|"+car+"|"+Encoding.ASCII.GetString(buf,t,j-t));
          }
          if(o+want>=len)break;
          o+=want-64;
        }
      }
      addr=b+len;
    }
    return res;
  }
}
'@
Add-Type -TypeDefinition $src
$name=${procName};$h=[IntPtr]::Zero;$pid0=0;$first=$true
$known=New-Object 'System.Collections.Generic.HashSet[string]'
while($true){
  if($h -ne [IntPtr]::Zero){ if(-not (Get-Process -Id $pid0 -ErrorAction SilentlyContinue)){[void][PO]::CloseHandle($h);$h=[IntPtr]::Zero;[Console]::WriteLine('X')} }
  if($h -eq [IntPtr]::Zero){
    $p=Get-Process -Name $name -ErrorAction SilentlyContinue|Select-Object -First 1
    if($p){$h=[PO]::OpenProcess(0x0410,$false,$p.Id);$pid0=$p.Id}
    if($h -eq [IntPtr]::Zero){Start-Sleep -Milliseconds 1500;continue}
    $known.Clear();$first=$true;[Console]::WriteLine('A')
  }
  $t0=[Environment]::TickCount
  $list=[PO]::Scan($h,[int64]4294967295)
  foreach($e in $list){ if($known.Add($e) -and -not $first){ $a=$e.Split('|'); [Console]::WriteLine('E '+$a[1]+' '+$a[2]) } }
  $dt=[Environment]::TickCount-$t0
  if($first){$first=$false;[Console]::WriteLine('B '+$list.Count+' '+$dt)}
  Start-Sleep -Milliseconds ([Math]::Max(500,$dt*2))
}`;
  try {
    const { spawn } = require('child_process');
    pitOutProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
                       { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    pitOutProc.stdout.on('data', chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line === 'A') { logPitOut('attached to the game'); }
        else if (line === 'X') { logPitOut('game closed'); if (pitOutConfirmed) { pitOutConfirmed = false; broadcastPitOutStatus(); } }
        else if (line[0] === 'B') logPitOut('first scan done (baseline, nothing counted): ' + line.slice(2) + ' [matches, ms]');
        else if (line[0] === 'E') { const m = /^E (\d{1,4}) (\d+(?:\.\d+)?)$/.exec(line); if (m) onPitOutMessage(m[1], m[2]); }
      }
    });
    const lost = () => { pitOutProc = null; if (pitOutConfirmed) { pitOutConfirmed = false; broadcastPitOutStatus(); } };
    pitOutProc.on('exit', lost);
    pitOutProc.on('error', lost);
  } catch (e) { pitOutProc = null; }
}
function stopPitOutReader() {
  if (!pitOutProc) return;
  const p = pitOutProc; pitOutProc = null; pitOutConfirmed = false;
  try { killPid(p.pid); } catch (e) {}
  try { p.kill(); } catch (e) {}
}
ipcMain.handle('get-pitout-status', () => pitOutConfirmed);

ipcMain.handle('get-cam', () => ({ pos: camPos, idx: camCar, raw: camCarRaw, num: camNumber() }));
ipcMain.handle('report-car-map', (e, m) => {
  if (!m || typeof m !== 'object') return false;
  const clean = {};
  Object.keys(m).slice(0, 200).forEach(k => { const i = parseInt(k, 10), n = String(m[k] == null ? '' : m[k]).trim(); if (Number.isFinite(i) && i >= 0 && /^\d{1,4}$/.test(n)) clean[i] = n; });
  if (JSON.stringify(clean) !== JSON.stringify(carNums)) { carNums = clean; broadcastCam(); }
  return true;
});
// Starting order seen by the hidden recorder (qualifying table of this track + the grid seen before the green flag), for the Race Stats page
let startOrder = { key: '', track: '', qual: null, grid: null, start: null, src: '', dbg: '' };
ipcMain.handle('report-start-order', (e, m) => {
  if (!m || typeof m !== 'object') return false;
  const clean = o => { if (!o || typeof o !== 'object') return null; const r = {}; Object.keys(o).slice(0, 200).forEach(k => { const n = parseInt(o[k], 10); if (/^\d{1,4}$/.test(k) && n >= 1 && n <= 500) r[k] = n; }); return Object.keys(r).length ? r : null; };
  startOrder = { key: String(m.key || '').slice(0, 80), track: String(m.track || '').slice(0, 80), qual: clean(m.qual), grid: clean(m.grid), start: clean(m.start), src: String(m.src || '').slice(0, 24), dbg: String(m.dbg || '').slice(0, 2000) };
  return true;
});
ipcMain.handle('get-start-order', () => startOrder);   // read by the overlays (Prime Driver Info) so they show the same starting positions as Race Stats
ipcMain.handle('get-cam-pos', () => camPos);
ipcMain.handle('get-cam-car', () => ({ idx: camCar, raw: camCarRaw }));

// ── Edit mode enter/exit ────────────────────────────────────────────────────
function registerEditHotkey() {
  if (config._editHotkeyAccel) {
    try { globalShortcut.unregister(config._editHotkeyAccel); } catch(e) {}
    config._editHotkeyAccel = null;
  }
  if (!config.editHotkey || !hotkeysActive) return;
  const accel = config.editHotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/\s/g, '');
  try {
    const ok = globalShortcut.register(accel, () => toggleEditMode());
    if (ok) config._editHotkeyAccel = accel;
    else console.warn(`Edit hotkey ${accel} failed to register`);
  } catch(e) {
    console.error('Edit hotkey register error:', e);
  }
}

function registerReopenHotkey() {
  if (config._reopenHotkeyAccel) {
    try { globalShortcut.unregister(config._reopenHotkeyAccel); } catch(e) {}
    config._reopenHotkeyAccel = null;
  }
  if (!config.reopenHotkey || !hotkeysActive) return;
  const accel = config.reopenHotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/\s/g, '');
  try {
    const ok = globalShortcut.register(accel, () => { if (shimProc) reopenOverlays(); });
    if (ok) config._reopenHotkeyAccel = accel;
    else console.warn(`Reopen hotkey ${accel} failed to register`);
  } catch(e) {
    console.error('Reopen hotkey register error:', e);
  }
}

function registerResyncHotkey() {
  if (config._resyncHotkeyAccel) {
    try { globalShortcut.unregister(config._resyncHotkeyAccel); } catch(e) {}
    config._resyncHotkeyAccel = null;
  }
  if (!config.resyncHotkey || !hotkeysActive) return;
  const accel = config.resyncHotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/\s/g, '');
  try {
    const ok = globalShortcut.register(accel, () => resyncStandings());
    if (ok) config._resyncHotkeyAccel = accel;
    else console.warn(`Resync hotkey ${accel} failed to register`);
  } catch(e) {
    console.error('Resync hotkey register error:', e);
  }
}

function registerTop3Hotkey() {
  if (config._top3HotkeyAccel) {
    try { globalShortcut.unregister(config._top3HotkeyAccel); } catch(e) {}
    config._top3HotkeyAccel = null;
  }
  if (!config.top3Hotkey || !hotkeysActive) return;
  const accel = config.top3Hotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/\s/g, '');
  try {
    const ok = globalShortcut.register(accel, () => {
      Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.webContents.send('top3-cycle'); });
    });
    if (ok) config._top3HotkeyAccel = accel;
    else console.warn(`Top 3 hotkey ${accel} failed to register`);
  } catch(e) {
    console.error('Top 3 hotkey register error:', e);
  }
}

function registerDriverInfoHotkey() {
  if (config._driverInfoHotkeyAccel) {
    try { globalShortcut.unregister(config._driverInfoHotkeyAccel); } catch(e) {}
    config._driverInfoHotkeyAccel = null;
  }
  if (!config.driverInfoHotkey || !hotkeysActive) return;
  const accel = config.driverInfoHotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/\s/g, '');
  try {
    const ok = globalShortcut.register(accel, () => {
      Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.webContents.send('driverinfo-toggle'); });
    });
    if (ok) config._driverInfoHotkeyAccel = accel;
    else console.warn(`Driver Info hotkey ${accel} failed to register`);
  } catch(e) {
    console.error('Driver Info hotkey register error:', e);
  }
}

function registerPointsHotkey() {
  if (config._pointsHotkeyAccel) {
    try { globalShortcut.unregister(config._pointsHotkeyAccel); } catch(e) {}
    config._pointsHotkeyAccel = null;
  }
  if (!config.pointsHotkey || !hotkeysActive) return;
  const accel = config.pointsHotkey
    .replace(/Ctrl/gi, 'CommandOrControl')
    .replace(/\s/g, '');
  try {
    const ok = globalShortcut.register(accel, () => {
      Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.webContents.send('points-toggle'); });
    });
    if (ok) config._pointsHotkeyAccel = accel;
    else console.warn(`Points hotkey ${accel} failed to register`);
  } catch(e) {
    console.error('Points hotkey register error:', e);
  }
}

async function resyncStandings() {
  const port = config.httpPort || 8766;
  try {
    await fetch(`http://localhost:${port}/resync-standings`, { method: 'POST' });
  } catch(e) {}
}

function toggleEditMode() {
  if (Object.keys(overlayWindows).length === 0) return;
  editModeActive = !editModeActive;
  editModeActive ? enterEditMode() : exitEditMode();
}

function enterEditMode() {
  const widgets = getActiveWidgets();
  for (const [id, win] of Object.entries(overlayWindows)) {
    if (!win || win.isDestroyed()) continue;
    win.setIgnoreMouseEvents(false);
    const w     = widgets[id] || {};
    const skinW = (w.skins && w.activeSkin) ? (w.skins[w.activeSkin] || {}) : w;
    const scale = skinW.scale || 1.0;
    const [curW, curH] = win.getSize();
    const baseW = Math.round((curW - 4) / scale);
    const baseH = Math.round((curH - 4) / scale);
    win.webContents.executeJavaScript(
      buildEditModeScript(id, scale, skinW.opacity || 1.0, baseW, baseH)
    ).catch(e => console.error('enterEditMode error:', e));
  }
  mainWindow?.webContents.send('edit-mode-status', true);
}

// Same as enterEditMode but for one overlay: used after Save in the Championship window so the overlay can be dragged right away
function enterEditModeFor(id) {
  const win = overlayWindows[id];
  if (!win || win.isDestroyed()) return;
  const w     = getActiveWidgets()[id] || {};
  const skinW = (w.skins && w.activeSkin) ? (w.skins[w.activeSkin] || {}) : w;
  const scale = skinW.scale || 1.0;
  const [curW, curH] = win.getSize();
  win.setIgnoreMouseEvents(false);
  editModeActive = true;
  win.webContents.executeJavaScript(
    buildEditModeScript(id, scale, skinW.opacity || 1.0, Math.round((curW - 4) / scale), Math.round((curH - 4) / scale))
  ).catch(e => console.error('enterEditModeFor error:', e));
  mainWindow?.webContents.send('edit-mode-status', true);
}

let isQuitting = false;
function exitEditMode(quitting) {
  editModeActive = false;
  const widgets = getActiveWidgets();
  const { x: dispX, y: dispY } = screen.getPrimaryDisplay().bounds;
  for (const [id, win] of Object.entries(overlayWindows)) {
    if (!win || win.isDestroyed()) continue;
    win.setIgnoreMouseEvents(true, { forward: true });
    win.webContents.executeJavaScript(
      'if (window.__psfExitEditMode) window.__psfExitEditMode();'
    ).catch(() => {});
    const bounds = win.getBounds();
    const w = widgets[id];
    if (!w) continue;
    if (w.skins && w.activeSkin) {
      if (!w.skins[w.activeSkin]) w.skins[w.activeSkin] = {};
      w.skins[w.activeSkin].x = bounds.x - dispX;
      w.skins[w.activeSkin].y = bounds.y - dispY;
    } else {
      w.x = bounds.x - dispX;
      w.y = bounds.y - dispY;
    }
  }
  setActiveWidgets(widgets);
  saveConfig();
  notifyBridgeLayoutChanged();
  // Quitting: positions are saved above; do NOT reopen overlays (that kept the process alive after closing the app)
  if (quitting || isQuitting) return;
  // Reopen overlays, then focus NR2003 after windows have settled,
  // then reassert alwaysOnTop so NR2003's focus change can't push
  // overlays behind it.
  setTimeout(() => {
    if (isQuitting) return;
    reopenOverlays();
    setTimeout(() => {
      if (isQuitting) return;
      try {
        const { exec } = require('child_process');
        exec('powershell -WindowStyle Hidden -Command "$p=Get-Process NR2003 -ErrorAction SilentlyContinue | Select-Object -First 1; if($p){$h=$p.MainWindowHandle; if($h -ne 0){Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class W{[DllImport(\\\"user32.dll\\\")]public static extern bool SetForegroundWindow(IntPtr h);}\'; [W]::SetForegroundWindow($h)}}"');
      } catch(e) {}
      // Reassert alwaysOnTop after NR2003 gets focus — this must fire
      // after SetForegroundWindow or NR2003 will push overlays under it.
      setTimeout(() => {
        for (const win of Object.values(overlayWindows)) {
          if (!win || win.isDestroyed()) continue;
          win.setAlwaysOnTop(true, 'screen-saver');
        }
      }, 200);
    }, 500);
  }, 150);
  mainWindow?.webContents.send('edit-mode-status', false);
}



function isNR2003Running() {
  try {
    const result  = execSync('tasklist /NH /FO CSV', { windowsHide: true, timeout: 2000, encoding: 'utf8' }).toLowerCase();
    return gameExe.names(config).some(n => result.includes('"' + n.toLowerCase() + '"'));
  } catch(e) { return false; }
}

function startNR2003Monitor() {
  if (nr2003PollTimer) return;
  // Instead of polling tasklist (unreliable on slow/Intel systems),
  // just watch the bridge process — it exits when NR2003 exits.
  // The bridge's 'exit' event already handles cleanup via shimProc.on('exit').
  // This timer is kept minimal just to update the UI status indicator.
  nr2003PollTimer = setInterval(() => {
    applyHotkeyGate();
    const running = !!shimProc && !shimProc.killed;
    if (running !== nr2003Running) {
      nr2003Running = running;
      mainWindow?.webContents.send('nr2003-status', running);
      layoutWindow?.webContents.send('nr2003-status', running);
      if (!running) {
        closeAllOverlays();
        closeStageRaceWindow();
      }
    }
  }, 2000);
}

function stopNR2003Monitor() {
  if (nr2003PollTimer) { clearInterval(nr2003PollTimer); nr2003PollTimer = null; }
  if (nr2003Running) {
    nr2003Running = false;
    mainWindow?.webContents.send('nr2003-status', false);
    layoutWindow?.webContents.send('nr2003-status', false);
  }
}

// ── Default widget layout (1080p baseline) ─────────────────────────────────
function getDefaultWidgets() {
  return {
    dash:          { enabled: true,  x: 674,  y: 849, scale: 1.0,  opacity: 1.0, visibilityMode: 'in_car' },
    input:         { enabled: true,  x: 1360, y: 970, scale: 1.0,  opacity: 1.0, lineThickness: 1.5, steerInput: 'game', pitBeep: true, hasClutch: true, visibilityMode: 'in_car' },
    relative:      { enabled: true,  x: 0,    y: 794, scale: 1.0,  opacity: 1.0, visibilityMode: 'in_car' },
    trackmap:      { enabled: true,  x: 1420, y: 0,   scale: 1.0,  opacity: 1.0, visibilityMode: 'at_track' },
    deltabar:      { enabled: true,  x: 675,  y: 176, scale: 1.0,  opacity: 1.0, visibilityMode: 'in_car' },
    battle:        { enabled: true,  x: 780,  y: 88,  scale: 1.0,  opacity: 1.0, visibilityMode: 'in_car' },
    radar:         { enabled: false, x: 860,  y: 440, scale: 1.0,  opacity: 1.0, visibilityMode: 'in_car', radarMode: 'always' },
    pitspeed:      { enabled: false, x: 760,  y: 440, scale: 1.0,  opacity: 1.0, pitBeep: true },
    season:        { enabled: false, x: 20,   y: 120, scale: 1.0,  opacity: 1.0, visibilityMode: 'at_track', seasonMode: 'auto', seasonRows: 14 },
    championship:  { enabled: false, x: 1600, y: 520, scale: 1.0,  opacity: 1.0, visibilityMode: 'at_track' },
    // Slot: Vertical Tower
    tower: {
      activeSkin: 'livestandings',
      skins: {
        livestandings: { enabled: true,  x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' },
        fox2022:       { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        foxpersonal:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'in_car',   customName: '', sponsorRotationTime: 10 },
        prime:         { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        fox2026:       { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        foxindy2026:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        tnt2026:       { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        nbc2019:       { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' },
      }
    },
    // Slot: Horizontal Ticker
    ticker: {
      activeSkin: 'ticker',
      skins: {
        ticker:     { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, scrollSpeed: 70, visibilityMode: 'at_track', customName: '' },
        cw_overlay: { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' },
        floracing:  { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        espn2010:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' },
        espn2011:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' },
        espn2017:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10 },
        nbc2012:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', _hazeTop: true },
        nbc2014:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' },
        nbc2016:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', customName: '' },
        nbc2017shart: { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', customName: '' },
        fox2010:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10 },
        fox2016:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', sponsorRotationTime: 10, customName: '', columns: 2 },
        fox2004:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10, customName: '' },
      }
    },
  };
}

// ── Config ─────────────────────────────────────────────────────────────────
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    config = {};
  }
  // Migrate legacy flat widgets to profiles
  if (config.widgets && !config.profiles) {
    config.profiles     = { 'Default': { widgets: config.widgets } };
    config.activeProfile = 'Default';
    delete config.widgets;
    saveConfig();
  }
  if (!config.profiles)      config.profiles     = { 'Default': { widgets: getDefaultWidgets() } };
  if (!config.activeProfile) config.activeProfile = 'Default';
  if (!config.series)        config.series        = 'default';
  if (!config.championships || typeof config.championships !== 'object') config.championships = {};
  if (!config.profiles['Default']) config.profiles['Default'] = { widgets: getDefaultWidgets() };
  if (!fs.existsSync(CONFIG_PATH)) saveConfig();
  if (!config.profiles['Default'].widgets || !Object.keys(config.profiles['Default'].widgets).length) {
    config.profiles['Default'].widgets = getDefaultWidgets();
  }

  // Migrate old flat livestandings/fox2022/ticker to slot structure
  for (const profileKey of Object.keys(config.profiles)) {
    const w = config.profiles[profileKey].widgets;
    if (!w) continue;

    // Season standings overlay (added with season tracking) — off until the user enables it
    if (!w.season) {
      w.season = { enabled: false, x: 20, y: 120, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', seasonMode: 'auto', seasonRows: 14 };
    }
    // Add the championship widget to profiles created before it existed (off by default)
    if (!w.championship) {
      w.championship = { enabled: false, x: 1600, y: 520, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track' };
    }
    // The starting-grid widget was removed — drop any saved entry so no overlay tries to open it
    if (w.startgrid) delete w.startgrid;

    // Migrate tower slot
    if (!w.tower || !w.tower.skins) {
      const oldTower = w.tower && !w.tower.skins ? w.tower : null;
      w.tower = { activeSkin: 'livestandings', skins: {
        livestandings: { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' },
        fox2022:       { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        foxpersonal:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'in_car',   customName: '', sponsorRotationTime: 10 },
      }};
      if (oldTower) {
        w.tower.activeSkin = oldTower.activeSkin || 'livestandings';
        if (oldTower.skins) w.tower.skins = oldTower.skins;
      }
      if (w.livestandings) {
        w.tower.skins.livestandings = { ...w.tower.skins.livestandings, ...w.livestandings };
        w.tower.activeSkin = 'livestandings';
        delete w.livestandings;
      }
      if (w.fox2022) {
        w.tower.skins.fox2022 = { ...w.tower.skins.fox2022, ...w.fox2022 };
        if (w.fox2022.enabled) w.tower.activeSkin = 'fox2022';
        delete w.fox2022;
      }
    }

    // Migrate ticker slot
    if (!w.ticker || !w.ticker.skins) {
      const oldTicker = w.ticker && !w.ticker.skins ? w.ticker : null;
      w.ticker = { activeSkin: 'ticker', skins: {
        ticker:     { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, scrollSpeed: 70, visibilityMode: 'at_track', customName: '' },
        cw_overlay: { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' },
        floracing:  { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 },
        espn2010:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' },
        espn2011:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' },
        espn2017:   { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10 },
        nbc2012:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', _hazeTop: true },
        nbc2014:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' },
        nbc2016:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', customName: '' },
        nbc2017shart: { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', customName: '' },
        fox2010:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10 },
        fox2016:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', sponsorRotationTime: 10, customName: '', columns: 2 },
        fox2004:    { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10, customName: '' },
      }};
      if (oldTicker) w.ticker.skins.ticker = { ...w.ticker.skins.ticker, ...oldTicker };
    }

    // Add any missing ticker skins
    if (w.ticker?.skins) {
      if (!w.ticker.skins.cw_overlay) {
        w.ticker.skins.cw_overlay = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' };
      }
      // CW overlay: the ticker now sits at the bottom of its window (points panel above it).
      // One-time shift so existing layouts keep the ticker on screen exactly where it was.
      if (w.ticker.skins.cw_overlay && !w.ticker.skins.cw_overlay._ppAbove) {
        const cwS = w.ticker.skins.cw_overlay;
        cwS.y = (cwS.y || 0) - Math.round(368 * (cwS.scale || 1));
        cwS._ppAbove = true;
      }
      if (!w.ticker.skins.floracing) {
        w.ticker.skins.floracing = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 };
      }
      if (!w.ticker.skins.fox2004) {
        w.ticker.skins.fox2004 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10, customName: '' };
      }
      if (!w.ticker.skins.fox2010) {
        w.ticker.skins.fox2010 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10 };
      }
      if (!w.ticker.skins.fox2016) {
        w.ticker.skins.fox2016 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', sponsorRotationTime: 10, customName: '', columns: 2 };
      }
      if (!w.ticker.skins.espn2010) {
        w.ticker.skins.espn2010 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' };
      }
      if (!w.ticker.skins.espn2011) {
        w.ticker.skins.espn2011 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' };
      }
      if (!w.ticker.skins.espn2017) {
        w.ticker.skins.espn2017 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', sponsorRotationTime: 10 };
      }
      if (!w.ticker.skins.nbc2012) {
        w.ticker.skins.nbc2012 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason', _hazeTop: true };
      }
      if (!w.ticker.skins.nbc2014) {
        w.ticker.skins.nbc2014 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', scrollSpeed: 80, dnfDisplay: 'reason' };
      }
      if (!w.ticker.skins.nbc2016) {
        w.ticker.skins.nbc2016 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', customName: '' };
      }
      if (!w.ticker.skins.nbc2017shart) {
        w.ticker.skins.nbc2017shart = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', dnfDisplay: 'reason', customName: '' };
      }
      // NBC 2012 was removed from the skin list: whoever had it active moves to NBC 2014 (same canvas, same position/scale)
      if (w.ticker.activeSkin === 'nbc2012' && w.ticker.skins.nbc2012 && w.ticker.skins.nbc2014) {
        const o = w.ticker.skins.nbc2012;
        Object.assign(w.ticker.skins.nbc2014, { enabled: !!o.enabled, x: o.x || 0, y: o.y || 0, scale: o.scale ?? 1, opacity: o.opacity ?? 1,
          visibilityMode: o.visibilityMode || 'at_track', scrollSpeed: o.scrollSpeed ?? 80, dnfDisplay: o.dnfDisplay || 'reason' });
        o.enabled = false;
        w.ticker.activeSkin = 'nbc2014';
      }
      // NBC 2012 got 72px of haze above the bars: one-time shift so the bars stay where they were on screen
      if (w.ticker.skins.nbc2012 && !w.ticker.skins.nbc2012._hazeTop) {
        const nb = w.ticker.skins.nbc2012;
        nb.y = (nb.y || 0) - Math.round(72 * (nb.scale || 1));
        nb._hazeTop = true;
      }
    }

    // Add missing fox2022 tower skin
    if (w.tower?.skins && !w.tower.skins.fox2022) {
      w.tower.skins.fox2022 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 };
    }
    if (w.tower?.skins && !w.tower.skins.foxpersonal) {
      w.tower.skins.foxpersonal = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'in_car', customName: '', sponsorRotationTime: 10 };
    if (w.tower?.skins && !w.tower.skins.prime) {
      w.tower.skins.prime = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 };
    }
    if (w.tower?.skins && !w.tower.skins.fox2026) {
      w.tower.skins.fox2026 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 };
    }
    if (w.tower?.skins && !w.tower.skins.foxindy2026) {
      w.tower.skins.foxindy2026 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 };
    }
    if (w.tower?.skins && !w.tower.skins.tnt2026) {
      w.tower.skins.tnt2026 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '', sponsorRotationTime: 10 };
    }
    if (w.tower?.skins && !w.tower.skins.nbc2019) {
      w.tower.skins.nbc2019 = { enabled: false, x: 0, y: 0, scale: 1.0, opacity: 1.0, visibilityMode: 'at_track', customName: '' };
    }
    // AppleTV (Fictional) ticker was removed: drop its saved settings and move the slot to another skin if it was the active one
    if (w.tower?.skins && w.tower.skins.appletv) {
      delete w.tower.skins.appletv;
      if (w.tower.activeSkin === 'appletv') w.tower.activeSkin = 'livestandings';
    }
    }
  }
  saveConfig();
}

function getActiveWidgets() {
  const profile = config.profiles[config.activeProfile] || {};
  return profile.widgets || {};
}

function setActiveWidgets(widgets) {
  if (!config.profiles[config.activeProfile]) {
    config.profiles[config.activeProfile] = {};
  }
  config.profiles[config.activeProfile].widgets = widgets;
}

function saveConfig() {
  const tmp = CONFIG_PATH + '.tmp';
  const data = JSON.stringify(config, null, 2);
  try {
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, CONFIG_PATH);
  } catch(e) {
    // Rename failed (e.g. file locked by bridge polling) — fall back to direct write
    try {
      fs.writeFileSync(CONFIG_PATH, data, 'utf8');
      try { fs.unlinkSync(tmp); } catch(_) {}
    } catch(e2) {
      console.error('saveConfig failed:', e2);
    }
  }
}

// ── Series scanner ─────────────────────────────────────────────────────────
// Perf: scanSeries() does a readdir + a sync read of every seriesinfo.ini, and
// it is called from per-overlay creation and from a 3 s IPC poll. Cache it
// briefly; explicit user-driven refreshes (and series edits) bypass/invalidate.
let _seriesCache = null, _seriesCacheAt = 0;
function invalidateSeriesCache() { _seriesCache = null; }
function scanSeries(forceFresh) {
  const now = Date.now();
  if (!forceFresh && _seriesCache && now - _seriesCacheAt < 10000) {
    return _seriesCache.map(s => ({ ...s }));
  }
  const fresh = scanSeriesUncached();
  _seriesCache = fresh; _seriesCacheAt = now;
  return fresh.map(s => ({ ...s }));
}
function scanSeriesUncached() {
  const results = [{ id: 'default', name: 'NR2003 (Default)' }];
  if (!fs.existsSync(SERIES_DIR)) return results;
  for (const folder of fs.readdirSync(SERIES_DIR)) {
    const iniPath = path.join(SERIES_DIR, folder, 'seriesinfo.ini');
    if (!fs.existsSync(iniPath)) continue;
    // Read seriesname= from ini if present
    let name = folder;
    try {
      const ini = fs.readFileSync(iniPath, 'utf8');
      const m   = ini.match(/^seriesname\s*=\s*(.+)/mi);
      if (m) name = m[1].trim();
    } catch(e) {}
    results.push({ id: folder, name });
  }
  return results;
}

// ── Bridge process ─────────────────────────────────────────────────────────
function startBridge() {
  if (bridgeProc) return;

  // Player folder is required — it's how PSF identifies the local player
  // in both offline and online sessions. Without it, widgets like relative,
  // trackmap, and livestandings can't correctly highlight the player's car.
  if (!config.playerFolder) {
    console.warn('startBridge: no player folder configured — bridge will not start');
    mainWindow?.webContents.send('error',
      'Please select your NR2003 player profile in PSF settings before starting.\n\n' +
      'This is required to identify your car in the overlays.'
    );
    return;
  }

  console.log('startBridge - BRIDGE_EXE:', BRIDGE_EXE);
  console.log('startBridge - exists:', fs.existsSync(BRIDGE_EXE));
  if (!fs.existsSync(BRIDGE_EXE)) {
    console.error('Bridge exe not found:', BRIDGE_EXE);
    return;
  }
  bridgeProc = spawn(BRIDGE_EXE, [], {
    cwd:         IS_PACKAGED ? process.resourcesPath : APP_DIR,
    windowsHide: true,
    detached:    false,
    stdio:       'ignore',
    shell:       false,
    env: { ...process.env,
           PSF_PLAYER_FOLDER: config.playerFolder || '',
           PSF_NR2003_EXE:    path.basename(gameExe.launchExe(config) || 'NR2003.exe'),   // RaceLab's game build when it starts the game
           PSF_NR2003_DIR:    config.nr2003_exe ? path.dirname(config.nr2003_exe).replace(/\\/g, '/') : '',
           PSF_PHYSICS_RATE:  config.physicsRate ? '1' : '0',
           PSF_SERIES:        config.series || 'default',
    },
  });
  bridgeProc.on('error', (err) => {
    console.error('Bridge spawn error:', err);
    mainWindow?.webContents.send('error', `Failed to start bridge: ${err.message}\n\nMake sure Visual C++ Redistributable is installed.`);
    bridgeProc = null;
  });
  bridgeProc.on('exit', (code) => {
    console.log('Bridge exited:', code);
    bridgeProc = null;
    mainWindow?.webContents.send('bridge-status', false);
  });
  setTimeout(() => {
    if (bridgeProc) {
      mainWindow?.webContents.send('bridge-status', true);
      // Check if bridge is running as admin via HTTP health endpoint
      const http = require('http');
      http.get('http://127.0.0.1:8766/health', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const health = JSON.parse(data);
            mainWindow?.webContents.send('admin-status', !!health.isAdmin);
          } catch(e) {}
        });
      }).on('error', () => {
        // Bridge not ready yet — default to not admin for safety
        mainWindow?.webContents.send('admin-status', false);
      });
    }
  }, 500);
}

function stopBridge() {
  if (bridgeProc) {
    killPid(bridgeProc.pid);
    try { bridgeProc.kill(); } catch(e) {}
    bridgeProc = null;
    mainWindow?.webContents.send('bridge-status', false);
  }
}

function stopShim() {
  if (shimProc) {
    killPid(shimProc.pid);
    try { shimProc.kill(); } catch(e) {}
    shimProc = null;
    mainWindow?.webContents.send('shim-status', false);
    layoutWindow?.webContents.send('shim-status', false);
  }
}

function stopAll() {
  closeAllOverlays();
  stopShim();
  stopBridge();
}

// ── core.ini config check ──────────────────────────────────────────────────
// Ensures session_info_period and standings_period are set to 0.500000
// in core.ini. Without this, standings refresh every 10 seconds which
// breaks live standings, lap counting, and caution detection.
function ensureCoreIni(nr2003Dir) {
  // Diagnostics: set "skipCoreIniPatch": true in config.json to stop the app from touching core.ini
  if (config.skipCoreIniPatch === true) { console.log('[PSF] core.ini patch skipped (config.skipCoreIniPatch)'); return; }
  const coreIniPath = path.join(nr2003Dir, 'core.ini');
  if (!fs.existsSync(coreIniPath)) {
    console.warn('core.ini not found at', coreIniPath);
    return;
  }

  let content = fs.readFileSync(coreIniPath, 'utf8');
  let changed  = false;
  const log    = [];

  const patch = (key) => {
    // Match key = <anything> and replace value with 0.500000
    const regex = new RegExp(`(${key}\\s*=\\s*)([^\\r\\n]+)`, 'i');
    const match = content.match(regex);
    if (match) {
      const current = match[2].trim();
      if (current !== '0.500000') {
        content = content.replace(regex, `$1 0.500000`);
        log.push(`${key}: ${current} → 0.500000`);
        changed = true;
      }
    } else {
      // Key doesn't exist — need to add it under [SessionInfo]
      content = content.replace(
        /(\[SessionInfo\][^\[]*)/i,
        `$1${key} = 0.500000\n`
      );
      log.push(`${key}: added (was missing)`);
      changed = true;
    }
  };

  patch('session_info_period');
  patch('standings_period');

  if (changed) {
    fs.writeFileSync(coreIniPath, content, 'utf8');
    console.log('[PSF] core.ini patched:', log.join(', '));
    mainWindow?.webContents.send('launch-countdown', `Configured core.ini: ${log.join(', ')}`);
  } else {
    console.log('[PSF] core.ini already configured correctly');
  }
}

// ── shltv.ini sync ─────────────────────────────────────────────────────────
// nr2003_shim.exe and nr2003_bridge.exe read their rate settings
// (telemetry_divisor, physics_rate) from shltv.ini sitting next to the exes —
// NOT from config.json or environment variables. Without this, the
// "Performance mode" selector in the UI had no effect on the native side.
// Only keys the user actually chose are written; everything else in the file
// (ws_port, poll_ms, ...) is preserved.
function setIniKey(text, section, key, value) {
  const eol   = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.length ? text.split(/\r?\n/) : [];
  const keyRe = new RegExp('^\\s*' + key + '\\s*[=:]', 'i');
  let inSec = false, secIdx = -1, done = false;
  for (let i = 0; i < lines.length && !done; i++) {
    const m = lines[i].match(/^\s*\[(.+?)\]\s*$/);
    if (m) {
      if (inSec) { lines.splice(i, 0, `${key}=${value}`); done = true; break; }
      inSec = m[1].trim().toLowerCase() === section;
      if (inSec) secIdx = i;
      continue;
    }
    if (inSec && keyRe.test(lines[i])) { lines[i] = `${key}=${value}`; done = true; }
  }
  if (!done) {
    if (secIdx >= 0) lines.splice(secIdx + 1, 0, `${key}=${value}`);
    else {
      if (lines.length && lines[lines.length - 1] !== '') lines.push('');
      lines.push(`[${section}]`, `${key}=${value}`);
    }
  }
  return lines.join(eol);
}

function syncBridgeIni() {
  if (config.telemetryDivisor === undefined && config.physicsRate === undefined) return;
  const iniPath = path.join(path.dirname(BRIDGE_EXE), 'shltv.ini');
  try {
    let text = '';
    try { text = fs.readFileSync(iniPath, 'utf8'); } catch (_) {}
    let next = setIniKey(text, 'shltv', 'telemetry_divisor', Math.max(1, Math.min(1000, parseInt(config.telemetryDivisor) || 1)));
    next     = setIniKey(next,  'shltv', 'physics_rate', config.physicsRate ? 1 : 0);
    if (next !== text) fs.writeFileSync(iniPath, next, 'utf8');
  } catch (e) {
    // e.g. installed under Program Files without write access
    console.warn('[PSF] could not update shltv.ini (' + iniPath + '):', e.message);
  }
}

// ── Shim + NR2003 launch ───────────────────────────────────────────────────
function launchNR2003() {
  if (!config.nr2003_exe || !fs.existsSync(config.nr2003_exe)) {
    mainWindow?.webContents.send('error', 'NR2003 path not set or not found.');
    return;
  }

  const nr2003Dir = path.dirname(config.nr2003_exe);

  // Check and patch core.ini before launching
  ensureCoreIni(nr2003Dir);

  // Make the shim/bridge pick up the Performance mode chosen in the UI
  syncBridgeIni();

  // Kill anything leftover from previous session
  stopAll();

  // Step 1: Start shim
  mainWindow?.webContents.send('launch-countdown', 'STARTING SHIM...');
  shimProc = spawn(SHIM_EXE, [], {
    cwd:         nr2003Dir,
    windowsHide: true,
    detached:    false,
    stdio:       'ignore',
    shell:       false,
  });
  shimProc.on('spawn', () => {
    mainWindow?.webContents.send('shim-status', true);
    layoutWindow?.webContents.send('shim-status', true);
  });
  shimProc.on('exit', () => {
    shimProc = null;
    mainWindow?.webContents.send('shim-status', false);
    // NR2003 exited or crashed — kill bridge and close all overlays
    stopBridge();
    closeAllOverlays();
    closeStageRaceWindow();
  });

  // Step 2: Start bridge after 3s
  setTimeout(() => {
    mainWindow?.webContents.send('launch-countdown', 'STARTING BRIDGE...');
    startBridge();

    // Step 3: Launch NR2003 after another 3s with countdown
    let countdown = 3;
    setTimeout(() => {
      const timer = setInterval(() => {
        mainWindow?.webContents.send('launch-countdown', countdown);
        countdown--;
        if (countdown < 0) {
          clearInterval(timer);
          mainWindow?.webContents.send('launch-countdown', null);
          // NR2003 Background (built in): started suspended so the sound flags are set before the game makes a sound
          // RaceLab on: its injector starts the game with SpinMod.dll (RaceLab can't be loaded into a game something else started).
          // NR2003 Background, if on, then attaches to the running game at once (backgroundSoon) instead of starting it itself.
          const useRaceLab = !!(raceLab.cfg().enabled && raceLab.dir());
          let bgStarted = false;
          if (config.background && config.background.on && !useRaceLab) {
            try { const r = background.launch(config.nr2003_exe, nr2003Dir); bgStarted = true; if (!r.sound.ok) mainWindow?.webContents.send('launch-countdown', 'Background: ' + r.sound.msg); }
            catch (e) { backgroundLog('NR2003 Background: ' + e.message + ' - starting NR2003 the normal way'); }
          }
          let rlStarted = false;
          if (useRaceLab) {
            rlStarted = raceLab.launch(raceLab.exe(), (err, out) => {
              // every run of the injector goes to racelab.log; a failed run (it prints 'Version check passed' first, so that is no sign of success)
              // shows its reason on the launch button
              try { fs.appendFileSync(path.join(USER_DATA, 'racelab.log'), new Date().toISOString() + ' exit=' + (err ? (err.code != null ? err.code : err.message) : 0) + '\r\n' + (out || '') + '\r\n\r\n'); } catch (e) { /* read-only */ }
              if (err) {
                const why = String(out || '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !/^(EXE|SHA):|Version check passed|^Verified layout|^External ownership|^Scrape particle/i.test(s)).pop() || err.message;
                mainWindow?.webContents.send('launch-countdown', 'RaceLab: ' + why);
              }
            });
            if (rlStarted && config.background && config.background.on) backgroundSoon();
          }
          if (!bgStarted && !rlStarted) execFile(config.nr2003_exe, [], { cwd: nr2003Dir }, (err) => {
            if (err) console.error('NR2003 launch error:', err);
          });
          startNR2003Monitor();
          // AI Enhanced set to start with the app: make sure a working one is up for this game (a hung one from the last race is replaced)
          if (config.aieLaunch && config.aieLaunch.onStart) setTimeout(() => console.log('[aie] at launch', JSON.stringify(launchAiEnhanced())), 1000);
          // Wait for NR2003 + bridge to fully load before opening overlays
          const isFirstRun = !fs.existsSync(path.join(USER_DATA, 'config.json'));
          const delay = isFirstRun ? 15000 : 8000;
          setTimeout(() => {
            reopenOverlays();
            // On first run, reposition again after another 5s once NR2003 window is settled
            if (isFirstRun) {
              setTimeout(() => reopenOverlays(), 5000);
            }
          }, delay);
        }
      }, 1000);
    }, 500);
  }, 3000);
}

// ── Read NR2003 screen resolution from rend_dxg.ini ───────────────────────
function getNR2003Resolution() {
  try {
    const nr2003Dir = config.nr2003_exe ? path.dirname(config.nr2003_exe) : null;
    if (!nr2003Dir) return { width: 1920, height: 1080 };
    const iniPath = path.join(nr2003Dir, 'rend_dxg.ini');
    if (!fs.existsSync(iniPath)) return { width: 1920, height: 1080 };
    const ini    = fs.readFileSync(iniPath, 'utf8');
    const wMatch = ini.match(/^Width\s*=\s*(\d+)/m);
    const hMatch = ini.match(/^Height\s*=\s*(\d+)/m);
    const width  = wMatch ? parseInt(wMatch[1]) : 1920;
    const height = hMatch ? parseInt(hMatch[1]) : 1080;
    return { width, height };
  } catch(e) {
    return { width: 1920, height: 1080 };
  }
}

// ── Reopen all overlays with updated config ────────────────────────────────
function closeAllOverlays() {
  if (global._alwaysOnTopTimer) {
    clearInterval(global._alwaysOnTopTimer);
    global._alwaysOnTopTimer = null;
  }
  for (const [id, win] of Object.entries(overlayWindows)) {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch(e) {}
    delete overlayWindows[id];
  }
}

function reopenOverlays() {
  if (isQuitting) return;
  // New overlay windows grab keyboard focus when they are created; remember which panel window had it and give it back
  const _focusBack = BrowserWindow.getAllWindows().find(w => w && !w.isDestroyed() && w.isFocused() && !Object.values(overlayWindows).includes(w));
  if (_focusBack) setTimeout(() => { try { if (!_focusBack.isDestroyed()) { _focusBack.focus(); _focusBack.webContents.focus(); } } catch (e) {} }, 400);
  closeAllOverlays();
  deltabarHidden = false;
  // Notify bridge to reload series data for current series
  const port = config.httpPort || 8766;
  fetch(`http://localhost:${port}/reload-series?series=${encodeURIComponent(config.series || '')}`, { method: 'POST' }).catch(() => {});
  const widgets = getActiveWidgets();
  for (const [id, w] of Object.entries(widgets)) {
    if (!w) continue;
    if (w.skins && w.activeSkin) {
      const skin = w.skins[w.activeSkin];
      if (skin?.enabled) createOverlayWindow(id);
    } else if (w.enabled) {
      createOverlayWindow(id);
    }
  }
  // Reassert alwaysOnTop after a short delay — newly created windows need
  // time to paint before Windows will honor their Z-order above NR2003.
  // Without this, some overlays can end up behind NR2003's window.
  setTimeout(() => {
    for (const win of Object.values(overlayWindows)) {
      if (!win || win.isDestroyed()) continue;
      win.setAlwaysOnTop(true, 'screen-saver');
    }
  }, 300);

  // Periodic reassertion — Intel iGPU and some GPU drivers cause NR2003
  // to periodically steal focus, pushing overlays behind it every few seconds.
  // Use moveTop() instead of setAlwaysOnTop() — moveTop just reorders the Z stack
  // without triggering a full window repaint, avoiding WebSocket drops on Intel iGPU.
  if (global._alwaysOnTopTimer) clearInterval(global._alwaysOnTopTimer);
  // Perf: every moveTop() is a SetWindowPos per overlay that makes DWM re-evaluate the
  // Z-order / recomposite over the game, which shows up as a periodic hitch in NR2003.
  // 1500 ms keeps the overlays on top just as reliably; override with
  // config.alwaysOnTopIntervalMs (min 250).
  const _aotMs = Math.max(250, Number(config.alwaysOnTopIntervalMs) || 1500);
  // Perf: instead of moving every overlay in the same instant (N SetWindowPos calls back to
  // back = one DWM recomposite burst over the game), spread them across short ticks. Each
  // overlay is still raised once every _aotMs.
  const _aotSlices = Math.max(1, Math.round(_aotMs / 250));
  let _aotTick = 0;
  global._alwaysOnTopTimer = setInterval(() => {
    _aotTick = (_aotTick + 1) % _aotSlices;
    const wins = Object.values(overlayWindows);
    for (let j = 0; j < wins.length; j++) {
      if (j % _aotSlices !== _aotTick) continue;
      const win = wins[j];
      if (!win || win.isDestroyed() || !win.isVisible()) continue;
      // a window that lost its topmost flag (whatever took it) gets it back; checking reads the window style only, no repaint
      try { if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, 'screen-saver'); } catch(e) {}
      try { win.moveTop(); } catch(e) {}
    }
  }, Math.round(_aotMs / _aotSlices));
  scheduleLowerPriority();
}

// ── Process priority ───────────────────────────────────────────────────────
// Perf: Electron's browser, GPU and renderer processes (one per overlay) run at
// Normal priority and compete with NR2003 for CPU. Dropping them to Below Normal
// lets the game always win the scheduler while the overlays still get the idle
// time. Opt out with config.lowerPriority = false.
let _prioTimer = null;
function lowerElectronPriority() {
  if (config.lowerPriority === false) return;
  try {
    const os = require('os');
    const level = os.constants.priority.PRIORITY_BELOW_NORMAL;
    for (const m of app.getAppMetrics()) {
      try { os.setPriority(m.pid, level); } catch (e) { /* process gone / access denied */ }
    }
  } catch (e) {}
}
function scheduleLowerPriority() {
  // Renderer/GPU processes are spawned lazily, so apply a few times after the
  // windows open and then keep a slow sweep for windows opened later.
  [1500, 5000, 12000].forEach(ms => setTimeout(lowerElectronPriority, ms));
  if (!_prioTimer) {
    // app.getAppMetrics() polls every Electron process; the 1.5/5/12 s sweeps after each
    // (re)open already catch new renderers, so this slow sweep can be rare.
    _prioTimer = setInterval(lowerElectronPriority, 60000);
    if (_prioTimer.unref) _prioTimer.unref();
  }
}

// ── Generic overlay window ─────────────────────────────────────────────────
function createOverlayWindow(id) {
  const widgets  = getActiveWidgets();
  const w        = widgets[id];
  if (!w) return null;
  // For slots, check the active skin's enabled flag
  const isSlotCheck = w.skins && w.activeSkin;
  if (isSlotCheck) {
    if (!w.skins[w.activeSkin]?.enabled) return null;
  } else if (!w.enabled) {
    return null;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { x: dispX, y: dispY } = primaryDisplay.bounds;

  // Slot support — tower and ticker are slot containers
  const isSlot = w && w.skins && w.activeSkin;
  const skinId = isSlot ? w.activeSkin : id;
  const skinW  = isSlot ? (w.skins[skinId] || {}) : w;

  // Widget sizes
  const SIZES = {
    dash:          { w: 572,  h: 231 },
    input:         { w: 560,  h: 110 },
    relative:      { w: 460,  h: 286 },
    trackmap:      { w: 500,  h: 500 },
    deltabar:      { w: 570,  h: 80  },
    livestandings: { w: 290,  h: 720 },
    battle:        { w: 360,  h: 88  },
    ticker:        { w: 1920, h: 145 },
    cw_overlay:    { w: 1920, h: 548 },   // 180 bar + points panel (368) that stacks above the CW block
    floracing:     { w: 1842, h: 129 },
    espn2010:      { w: 1920, h: 208 },   // 165 ticker + points bar row below
    espn2011:      { w: 1920, h: 215 },   // 165 ticker + points bar row below
    espn2017:      { w: 1728, h: 540 },   // 97 ticker + room for the post-race top-5 cards (to 140) + live points column below
    nbc2014:       { w: 1920, h: 532 },   // same canvas as NBC 2012; finish cards (to y~225) replace the interval bar after the flag
    nbc2017shart:  { w: 1166, h: 326 },  // NBC 2017 Shart Edition: lap box + series logo + INTERVALS on the left, TOP 3 + 5 cars on the right; 'As they run' points column below the left block
    nbc2016:       { w: 1166, h: 98 },   // top row (series logo, TOP 3, lap box) + 5 cars with intervals
    nbc2012:       { w: 1920, h: 560 },   // 72 blue haze above + 120 two-row bar + post-race top-5 cards + live points column below
    fox2010:       { w: 1456, h: 176 },
    fox2016:       { w: 1184, h: 388 },   // 132 ticker + 'As they run' points column below the plate
    fox2004:       { w: 1456, h: 516 },   // 129 ticker + semáforo de bandera + tablero de resultados (top 10) debajo
    radar:         { w: 200,  h: 200 },
    pitspeed:      { w: 220,  h: 90  },
    fox2022:       { w: 409,  h: 1080 },
    foxpersonal:   { w: 409,  h: 1080 },
    prime:         { w: 399,  h: 1080 },
    fox2026:       { w: 327,  h: 1013 },
    season:        { w: 460,  h: 112 + (skinW.seasonRows || 14) * 30 },
    foxindy2026:   { w: 450,  h: 986  },
    tnt2026:       { w: 321,  h: 967  },
    nbc2019:       { w: 336,  h: 963  },
    championship:  { w: champWidth(getChampionship(config.series || 'default')),  h: championshipWindowHeight(getChampionship(config.series || 'default').visibleRows, champCutExtra(getChampionship(config.series || 'default'))) },
  };
  let size = { ...SIZES[skinId] } || { w: 400, h: 300 };
  // Fox 2016 ticker: 3 modules -> wider window
  if (skinId === 'fox2016' && Number(skinW.columns) === 3) size.w = 1628;
  // Input widget shrinks when trace is hidden
  if (skinId === 'input') {
    if (skinW.hasClutch === false) size.w -= 40;
    if (skinW.showTrace === false) size.w -= 260;
    if (skinW.showSteer === false) size.w -= 96;
  }

  const win = new BrowserWindow({
    width:          Math.round(size.w * (skinW.scale || 1)) + 4,
    height:         Math.round(size.h * (skinW.scale || 1)) + 4,
    x:              dispX + (skinW.x || 0),
    y:              dispY + (skinW.y || 0),
    transparent:    true,
    frame:          false,
    alwaysOnTop:    true,
    skipTaskbar:    true,
    resizable:      false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
      backgroundThrottling: false,   // overlays sit over a fullscreen game: never let Chromium throttle/pause them
    },
  });
  // Shown again after being hidden (RaceVision hides these widgets during a replay), a window can come back without its topmost flag on
  // Windows, and the periodic moveTop below can't lift a window that isn't topmost above the game: put it back on top whenever it shows.
  win.on('show', () => { try { if (!win.isDestroyed()) { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop(); } } catch (e) { /* closing */ } });

  const series      = config.series || 'default';
  const seriesList  = scanSeries();
  const seriesEntry = seriesList.find(s => s.id === series);
  const seriesName  = seriesEntry?.name || series;
  const installDir  = USER_DATA.replace(/\\/g, '/');

  const params = new URLSearchParams({
    series,
    seriesname: seriesName,
    installdir: installDir,
    scale:      skinW.scale   || 1,
    opacity:    skinW.opacity || 1,
  });
  // Optional: config.overlayMaxHz (number, 0 = one update per display frame)
  // overrides perf-shim.js's default update-rate cap for every overlay.
  // Default is now 60 Hz for every overlay; config.overlayMaxHz still overrides it.
  const _maxHz = (typeof config.overlayMaxHz === 'number' && config.overlayMaxHz >= 0) ? config.overlayMaxHz : 60;
  params.set('maxhz', _maxHz);
  if (skinW.lineThickness !== undefined) params.set('linethickness', skinW.lineThickness);
  if (skinW.steerInput) params.set('steerinput', skinW.steerInput);
  if (skinW.pitBeep === false) params.set('pitbeep', '0');
  if (skinW.hasClutch === false) params.set('clutch', '0');
  if (skinW.scrollSpeed !== undefined) params.set('scrollspeed', skinW.scrollSpeed);
  if (skinW.customName) params.set('customname', encodeURIComponent(skinW.customName));
  if (skinW.chaseColor) params.set('chasecolor', encodeURIComponent(skinW.chaseColor));
  if (skinW.nameColor) params.set('namecolor', encodeURIComponent(skinW.nameColor));
  if (skinW.finalLapColor) params.set('finallapcolor', encodeURIComponent(skinW.finalLapColor));
  if (skinW.finalLapSponsorColor) params.set('finallapsponsorcolor', encodeURIComponent(skinW.finalLapSponsorColor));
  if (skinW.officialMode) params.set('officialmode', '1');
  if (skinW.visibilityMode) params.set('visibilitymode', skinW.visibilityMode);
  if (skinW.showTrackName === false) params.set('showtrackname', '0');
  if (skinW.showTrace     === false) params.set('showtrace',     '0');
  if (skinW.showSteer     === false) params.set('showsteer',     '0');
  if (skinW.radarMode) params.set('radarmode', skinW.radarMode);
  if (skinW.sponsorRotationTime) params.set('sponsorrotationtime', skinW.sponsorRotationTime);
  if (skinW.dnfDisplay && skinW.dnfDisplay !== 'reason') params.set('dnfdisplay', skinW.dnfDisplay);
  if (Number(skinW.columns) === 3) params.set('columns', '3');
  if (skinW.stripZeros)          params.set('stripzeros', 'true');
  if (skinW.showManu === false)  params.set('showmanu',   '0');
  params.set('seasonport', (config.season && config.season.port) || 8769);
  if (skinW.seasonMode) params.set('seasonmode', skinW.seasonMode);
  if (skinW.seasonPts && skinW.seasonPts !== 'off') params.set('seasonpts', skinW.seasonPts);
  if (skinW.seasonRows) params.set('seasonrows', skinW.seasonRows);
  if (skinW.resultsMode) params.set('resultsmode', skinW.resultsMode);
  if (skinW.showCar  === false)  params.set('showcar',    '0');
  if (skinW.yellowSound === false) params.set('yellowsound', '0');
  if (skinW.startGrid) params.set('startgrid', '1');
  if (skinW.startGridTime) params.set('startgridtime', skinW.startGridTime);
  if (skinW.startGridSkipSelf) params.set('startgridskip', '1');
  // Read wheel calibration from file if available
  let wheelInput = config.wheelInput || null;
  try {
    if (fs.existsSync(CALIB_PATH)) wheelInput = JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
  } catch(e) {}

  if (skinW.steerInput === 'wheel' && wheelInput) {
    const wi = wheelInput;
    params.set('wheelaxis',      wi.axisIndex);
    params.set('wheelleft',      wi.leftVal);
    params.set('wheelright',     wi.rightVal);
    params.set('wheelcenter',    wi.centerVal);
    params.set('wheeldevice',    wi.deviceIndex);
    params.set('wheelrot',       wi.rotation || 900);
    params.set('pedaldevice',    wi.pedalDeviceIndex ?? wi.deviceIndex);
    params.set('throttleaxis',   wi.throttleAxis ?? 1);
    params.set('throttlepress',  wi.throttlePress ?? 1);
    params.set('throttlerest',   wi.throttleRest  ?? 0);
    if (wi.throttleInvert) params.set('throttleinvert', '1');
    params.set('brakeaxis',      wi.brakeAxis ?? 2);
    params.set('brakepress',     wi.brakePress ?? 1);
    params.set('brakerest',      wi.brakeRest  ?? 0);
    if (wi.brakeInvert) params.set('brakeinvert', '1');
    if (wi.hasClutch) {
      params.set('clutchaxis',   wi.clutchAxis ?? 3);
      params.set('clutchpress',  wi.clutchPress ?? 1);
      params.set('clutchrest',   wi.clutchRest  ?? 0);
      if (wi.clutchInvert) params.set('clutchinvert', '1');
    } else {
      params.set('clutch', '0');
    }
  }
  const url = `file://${path.join(APP_DIR, `nr2003_${skinId}.html`)}?${params}`;
  console.log(`[overlay] ${id}(${skinId}):`, url);
  win.loadURL(url);
  win.setIgnoreMouseEvents(true);

  overlayWindows[id] = win;
  win.on('closed', () => { delete overlayWindows[id]; });
  return win;
}

// ── Overlay window ─────────────────────────────────────────────────────────
function createDashWindow(series) {
  closeAllOverlays();
  const widgets = getActiveWidgets();
  for (const [id, w] of Object.entries(widgets)) {
    if (!w) continue;
    // Slot: check active skin's enabled flag
    if (w.skins && w.activeSkin) {
      const skin = w.skins[w.activeSkin];
      if (skin?.enabled) createOverlayWindow(id);
    } else if (w.enabled) {
      createOverlayWindow(id);
    }
  }
}

// ── Main UI window ─────────────────────────────────────────────────────────
function createMainWindow() {
  // Restore saved window bounds
  const savedBounds = config.windowBounds || {};
  const winW = savedBounds.width  || 400;
  const winH = savedBounds.height || 560;
  const winX = savedBounds.x;
  const winY = savedBounds.y;

  mainWindow = new BrowserWindow({
    width:          winW,
    height:         winH,
    x:              winX,
    y:              winY,
    resizable:      true,
    minWidth:       360,
    minHeight:      500,
    title:          'All In One NR2003',
    icon:           path.join(__dirname, 'static', 'images', 'app_icon.ico'),
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  mainWindow.maximize();

  const logRendererDiagnostic = (label, details) => {
    try {
      fs.appendFileSync(
        path.join(USER_DATA, 'debug.log'),
        `\n${new Date().toISOString()} [${label}] ${details}\n`,
        'utf8',
      );
    } catch (_) {}
  };
  const mainContents = mainWindow.webContents;
  mainContents.on('preload-error', (_event, preloadPath, error) => {
    logRendererDiagnostic('preload-error', `${preloadPath}: ${error?.stack || error}`);
  });
  mainContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) logRendererDiagnostic('load-error', `code=${code} ${description} url=${url}`);
  });
  mainContents.on('render-process-gone', (_event, details) => {
    logRendererDiagnostic('renderer-gone', JSON.stringify(details));
  });
  mainContents.on('console-message', (...args) => {
    // Electron 25 uses (event, level, message, line, source); newer versions
    // may provide a single details object after the event.
    const item = args[1];
    const level = typeof item === 'object' ? item?.level : item;
    if (Number(level) < 2) return;
    const message = typeof item === 'object' ? item?.message : args[2];
    const line = typeof item === 'object' ? item?.lineNumber : args[3];
    const source = typeof item === 'object' ? item?.sourceId : args[4];
    logRendererDiagnostic('renderer-console', `${message} (${source || 'unknown'}:${line || '?'})`);
  });
  // Links of the app (social icons in the header) open in the user's browser, never inside the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (e, url) => { if (/^https?:\/\//i.test(url)) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });

  mainWindow.loadFile('index.html');
  mainWindow.webContents.on('did-finish-load', () => {
    logRendererDiagnostic('renderer-loaded', `config has NR2003 path=${!!config.nr2003_exe}; path exists=${!!(config.nr2003_exe && fs.existsSync(config.nr2003_exe))}`);
    mainWindow.webContents.send('bridge-status', !!bridgeProc);
    mainWindow.webContents.send('shim-status', !!shimProc);
  });

  // Restore maximized state
  if (config.windowBounds?.maximized) mainWindow.maximize();

  // Save window bounds and maximized state — debounced to avoid
  // rapid concurrent saveConfig calls while dragging the window
  let _saveBoundsTimer = null;
  const saveBounds = () => {
    if (!mainWindow) return;
    config.windowBounds = {
      ...mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
    };
    if (_saveBoundsTimer) clearTimeout(_saveBoundsTimer);
    _saveBoundsTimer = setTimeout(() => {
      saveConfig();
      _saveBoundsTimer = null;
    }, 300);
  };
  mainWindow.on('resize',     saveBounds);
  mainWindow.on('move',       saveBounds);
  mainWindow.on('maximize',   saveBounds);
  mainWindow.on('unmaximize', saveBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// ── IPC handlers ───────────────────────────────────────────────────────────
ipcMain.handle('open-data-folder', () => {
  shell.openPath(USER_DATA);
  return true;
});

ipcMain.handle('set-stream-ip', (_, ip) => {
  config.streamIp = ip || '';
  saveConfig();
  return true;
});

ipcMain.handle('set-live-standings', (_, enabled) => {
  config.liveStandingsEnabled = !!enabled;
  saveConfig();
  return true;
});

ipcMain.handle('set-telemetry-divisor', (_, n) => {
  const divisor = Math.max(1, Math.min(1000, parseInt(n) || 1));
  config.telemetryDivisor = divisor;
  // physics_rate=1 enables 288Hz in shim (Ultra mode = divisor 1 with physics rate)
  const physicsRate = config.physicsRate ? 1 : 0;
  saveConfig();
  return divisor;
});

ipcMain.handle('set-physics-rate', (_, enabled) => {
  config.physicsRate = !!enabled;
  saveConfig();
  return true;
});

ipcMain.handle('reopen-overlays', () => {
  reopenOverlays();
  return true;
});

// ── Live edit mode IPC handlers ────────────────────────────────────────────
ipcMain.handle('set-edit-hotkey', (_, combo) => {
  config.editHotkey = combo;
  saveConfig();
  registerEditHotkey();
  return true;
});

ipcMain.handle('clear-edit-hotkey', () => {
  if (config._editHotkeyAccel) {
    try { globalShortcut.unregister(config._editHotkeyAccel); } catch(e) {}
    config._editHotkeyAccel = null;
  }
  config.editHotkey = '';
  saveConfig();
  return true;
});

ipcMain.handle('set-reopen-hotkey', (_, combo) => {
  config.reopenHotkey = combo;
  saveConfig();
  registerReopenHotkey();
  return true;
});

ipcMain.handle('clear-reopen-hotkey', () => {
  if (config._reopenHotkeyAccel) {
    try { globalShortcut.unregister(config._reopenHotkeyAccel); } catch(e) {}
    config._reopenHotkeyAccel = null;
  }
  config.reopenHotkey = '';
  saveConfig();
  return true;
});

ipcMain.handle('set-top3-hotkey', (_, combo) => {
  config.top3Hotkey = combo;
  saveConfig();
  registerTop3Hotkey();
  return true;
});

ipcMain.handle('clear-top3-hotkey', () => {
  if (config._top3HotkeyAccel) {
    try { globalShortcut.unregister(config._top3HotkeyAccel); } catch(e) {}
    config._top3HotkeyAccel = null;
  }
  config.top3Hotkey = '';
  saveConfig();
  return true;
});

// An overlay asks to stretch its window down to a screen Y (so a banner can sit near the bottom of the screen) and, optionally,
// right to a screen X (so it can reach the right edge); null puts the window back to its original size.
ipcMain.handle('overlay-extend', (e, bottomY, rightX) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return false;
  const b = win.getBounds();
  if (win._psfOrigH === undefined) win._psfOrigH = b.height;
  if (win._psfOrigW === undefined) win._psfOrigW = b.width;
  const reset = (bottomY === null || bottomY === undefined);
  const h = reset ? win._psfOrigH : Math.max(win._psfOrigH, Math.round(bottomY) - b.y);
  const w = (reset || !Number.isFinite(rightX)) ? win._psfOrigW : Math.max(win._psfOrigW, Math.round(rightX) - b.x);
  if (h !== b.height || w !== b.width) win.setBounds({ x: b.x, y: b.y, width: w, height: h });
  if (reset) { delete win._psfOrigH; delete win._psfOrigW; }
  return true;
});

// Writes a small snapshot of the telemetry frame next to config.json so we can see which fields the bridge sends
ipcMain.handle('write-debug-dump', (e, obj) => {
  try {
    const f = path.join(USER_DATA, 'driverinfo-debug.json');
    let list = [];
    try { const old = JSON.parse(fs.readFileSync(f, 'utf8')); if (Array.isArray(old)) list = old; } catch (err) {}
    list.push(obj);
    if (list.length > 8) list = list.slice(-8);
    fs.writeFileSync(f, JSON.stringify(list, null, 1), 'utf8');
    return true;
  } catch (err) { console.error('write-debug-dump failed:', err); return false; }
});

ipcMain.handle('set-driverinfo-hotkey', (_, combo) => {
  config.driverInfoHotkey = combo;
  saveConfig();
  registerDriverInfoHotkey();
  return true;
});

ipcMain.handle('clear-driverinfo-hotkey', () => {
  if (config._driverInfoHotkeyAccel) {
    try { globalShortcut.unregister(config._driverInfoHotkeyAccel); } catch(e) {}
    config._driverInfoHotkeyAccel = null;
  }
  config.driverInfoHotkey = '';
  saveConfig();
  return true;
});

ipcMain.handle('set-points-hotkey', (_, combo) => {
  config.pointsHotkey = combo;
  saveConfig();
  registerPointsHotkey();
  return true;
});

ipcMain.handle('clear-points-hotkey', () => {
  if (config._pointsHotkeyAccel) {
    try { globalShortcut.unregister(config._pointsHotkeyAccel); } catch(e) {}
    config._pointsHotkeyAccel = null;
  }
  config.pointsHotkey = '';
  saveConfig();
  return true;
});

ipcMain.handle('set-resync-hotkey', (_, combo) => {
  config.resyncHotkey = combo;
  saveConfig();
  registerResyncHotkey();
  return true;
});

ipcMain.handle('clear-resync-hotkey', () => {
  if (config._resyncHotkeyAccel) {
    try { globalShortcut.unregister(config._resyncHotkeyAccel); } catch(e) {}
    config._resyncHotkeyAccel = null;
  }
  config.resyncHotkey = '';
  saveConfig();
  return true;
});

ipcMain.handle('trigger-resync-standings', async () => {
  await resyncStandings();
  return true;
});

ipcMain.handle('exit-edit-mode', () => {
  if (editModeActive) exitEditMode();
  return true;
});


ipcMain.handle('get-widget-id', (e) => {
  // Find which overlay window sent this
  for (const [id, win] of Object.entries(overlayWindows)) {
    if (win && !win.isDestroyed() && win.webContents.id === e.sender.id) {
      return id;
    }
  }
  return null;
});

ipcMain.handle('snap-window', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const [x, y]     = win.getPosition();
  const [w, h]      = win.getSize();
  const disp        = screen.getPrimaryDisplay().bounds;
  let nx = x, ny = y;
  // Only snap if the edge is close to the screen boundary
  if (Math.abs(x - disp.x)                       < SNAP_THRESHOLD) nx = disp.x;
  if (Math.abs(x + w - (disp.x + disp.width))    < SNAP_THRESHOLD) nx = disp.x + disp.width - w;
  if (Math.abs(y - disp.y)                       < SNAP_THRESHOLD) ny = disp.y;
  if (Math.abs(y + h - (disp.y + disp.height))   < SNAP_THRESHOLD) ny = disp.y + disp.height - h;
  if (nx !== x || ny !== y) win.setPosition(nx, ny);
});





ipcMain.handle('save-widget-scale', (e, scale) => {
  for (const [id, w] of Object.entries(overlayWindows)) {
    if (w && !w.isDestroyed() && w.webContents.id === e.sender.id) {
      const widgets = getActiveWidgets();
      const ww = widgets[id];
      if (ww) {
        const target = (ww.skins && ww.activeSkin) ? ww.skins[ww.activeSkin] : ww;
        if (target) target.scale = Math.min(EDIT_MAX_SCALE, Math.max(EDIT_MIN_SCALE, scale));
      }
      setActiveWidgets(widgets);
      saveConfig();
      break;
    }
  }
});

ipcMain.handle('save-widget-opacity', (e, opacity) => {
  for (const [id, w] of Object.entries(overlayWindows)) {
    if (w && !w.isDestroyed() && w.webContents.id === e.sender.id) {
      const widgets = getActiveWidgets();
      const ww = widgets[id];
      if (ww) {
        const target = (ww.skins && ww.activeSkin) ? ww.skins[ww.activeSkin] : ww;
        if (target) target.opacity = Math.min(1.0, Math.max(0.1, opacity));
      }
      setActiveWidgets(widgets);
      saveConfig();
      break;
    }
  }
});

ipcMain.handle('switch-slot-skin', (e, { slotId, skinId }) => {
  const widgets = getActiveWidgets();
  const slot = widgets[slotId];
  if (!slot || !slot.skins || !slot.skins[skinId]) return false;
  slot.activeSkin = skinId;
  setActiveWidgets(widgets);
  saveConfig();
  // Close and reopen overlay only if NR2003 is running
  if (shimProc) {
    if (overlayWindows[slotId] && !overlayWindows[slotId].isDestroyed()) {
      overlayWindows[slotId].destroy();
      delete overlayWindows[slotId];
    }
    const skin = slot.skins[skinId];
    if (skin?.enabled) createOverlayWindow(slotId);
  }
  return true;
});

ipcMain.handle('set-slot-skin-enabled', (e, { slotId, enabled }) => {
  const widgets = getActiveWidgets();
  const slot = widgets[slotId];
  if (!slot || !slot.skins || !slot.activeSkin) return false;
  slot.skins[slot.activeSkin].enabled = enabled;
  setActiveWidgets(widgets);
  saveConfig();
  if (shimProc) {
    if (enabled) {
      if (!overlayWindows[slotId] || overlayWindows[slotId].isDestroyed()) {
        createOverlayWindow(slotId);
      }
    } else {
      if (overlayWindows[slotId] && !overlayWindows[slotId].isDestroyed()) {
        overlayWindows[slotId].destroy();
        delete overlayWindows[slotId];
      }
    }
  }
  return true;
});

ipcMain.handle('get-window-position', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return { x: 0, y: 0 };
  const [x, y] = win.getPosition();
  return { x, y };
});

ipcMain.handle('set-window-position', (e, x, y) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  win.setPosition(Math.round(x), Math.round(y));
});

// ── Layout editor window ───────────────────────────────────────────────────
let layoutWindow = null;

function openLayoutEditor() {
  if (layoutWindow) { layoutWindow.focus(); return; }
  const layoutBounds = config.layoutWindowBounds || {};
  const lyW = layoutBounds.width  || 1300;
  const lyH = layoutBounds.height || 720;
  const lyX = layoutBounds.x;
  const lyY = layoutBounds.y;

  layoutWindow = new BrowserWindow({
    width:          lyW,
    height:         lyH,
    x:              lyX,
    y:              lyY,
    title:          'All In One NR2003 — Layout Editor',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  layoutWindow.loadFile('layout.html', { query: {
    series:       config.series   || '',
    installdir:   USER_DATA.replace(/\\/g, '/'),
    streamip:     config.streamIp || 'localhost',
    httpport:     '8766',
    seasonport:   String((config.season && config.season.port) || 8769),
    nr2003running: nr2003Running ? '1' : '0',
  } });
  layoutWindow.maximize();

  const saveLayoutBounds = () => {
    if (!layoutWindow) return;
    config.layoutWindowBounds = {
      ...layoutWindow.getBounds(),
      maximized: layoutWindow.isMaximized(),
    };
    saveConfig();
  };
  layoutWindow.on('resize',     saveLayoutBounds);
  layoutWindow.on('move',       saveLayoutBounds);
  layoutWindow.on('maximize',   saveLayoutBounds);
  layoutWindow.on('unmaximize', saveLayoutBounds);
  layoutWindow.on('closed', () => { layoutWindow = null; });
}

ipcMain.handle('get-nr2003-resolution', () => getNR2003Resolution());
ipcMain.handle('set-window-size', (e, scale, baseW, baseH) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed()) return;
  const clamp = Math.min(EDIT_MAX_SCALE, Math.max(EDIT_MIN_SCALE, scale));
  const w = Math.round(baseW * clamp) + 4, h = Math.round(baseH * clamp) + 4;
  // Perf: a native resize on a transparent window forces a relayout/recomposite
  // — skip it when the size is already right.
  const [curW, curH] = win.getSize();
  if (curW === w && curH === h) return;
  win.setSize(w, h);
});

ipcMain.handle('get-config',         () => config);

// ── Stage Racing ─────────────────────────────────────────────────────────
ipcMain.handle('get-stage-racing-config', () => {
  return config.stageRacing || { enabled: false, numStages: 0, inputMode: 'percent', percentages: [], laps: [] };
});

ipcMain.handle('save-stage-racing-config', (e, sr) => {
  const prev = config.stageRacing || {};
  const keep = (k, d) => (sr[k] !== undefined ? sr[k] : (prev[k] !== undefined ? prev[k] : d));
  const stagesOff = !!keep('stagesOff', false);
  let next = {
    enabled:     !!sr.enabled && !stagesOff,
    stagesOff,
    numStages:   sr.numStages   || 0,
    inputMode:   sr.inputMode   || 'percent',
    percentages: Array.isArray(sr.percentages) ? sr.percentages : [],
    laps:        Array.isArray(sr.laps)        ? sr.laps        : [],
    gwcEnabled:              !!keep('gwcEnabled', false),
    throwCaution:            keep('throwCaution', true) !== false,
    bcRaceBackToCautions:    !!keep('bcRaceBackToCautions', false),
    bcDisableCollisionsCaution: !!keep('bcDisableCollisionsCaution', false),
    bcDisableCollisionsPitRoad: !!keep('bcDisableCollisionsPitRoad', false),
    bcSendLappedToBack:      !!keep('bcSendLappedToBack', false),
    bcDoubleFile:            !!keep('bcDoubleFile', false),
  };
  next = ext.applyRaceControlMode(next);   // RaceControl owns cautions / GWC / restarts; Better Cautions is not used
  config.stageRacing = next;
  saveConfig();
  return true;
});

ipcMain.handle('set-stage-racing-enabled', (e, enabled) => {
  config.stageRacing = config.stageRacing || { enabled: false, numStages: 0, inputMode: 'percent', percentages: [], laps: [] };
  config.stageRacing.enabled = !!enabled && !config.stageRacing.stagesOff;
  saveConfig();
  return true;
});

ipcMain.handle('open-stage-race-window', () => { openStageRaceWindow(); return true; });

// ── Bundled and user-selected companion apps ──────────────────────────────────────────────────────────────
// The integrated services stand down while their standalone companion is running.
function prepareBundledMod(key) {
  return '';                  // All In One NR2003 ships no companion apps
  config.extMods = config.extMods || {};
  const saved = config.extMods[key] || {};
  const mod = ext.MODS[key];
  if (!mod || !mod.bundled || !mod.bundleId) return '';
  const currentRoot = path.resolve(USER_DATA, 'external-mods', mod.bundleId) + path.sep;
  const isCurrentBundle = saved.exe && path.resolve(saved.exe).toLowerCase().startsWith(currentRoot.toLowerCase());
  if (saved.exe && fs.existsSync(saved.exe) && (!ext.isManagedPath(saved.exe, USER_DATA) || isCurrentBundle)) return saved.exe;
  const exe = ext.installBundled(key, USER_DATA);
  if (!exe) return '';
  config.extMods[key] = Object.assign({}, saved, { exe, bundleId: mod.bundleId });
  saveConfig();
  console.log('[extmods] installed bundled beta', key, 'to', exe);
  return exe;
}
function adoptExternalMods() {
  let changed = false;
  try {
    if (config.stageRacing) {
      const next = ext.applyRaceControlMode(config.stageRacing);
      if (JSON.stringify(next) !== JSON.stringify(config.stageRacing)) { config.stageRacing = next; changed = true; }
    }
    if (config.cautions) { delete config.cautions; changed = true; }      // the old built-in caution extras
    if (changed) saveConfig();
  } catch (e) { console.warn('[extmods] startup check failed:', e.message); }
}
ipcMain.handle('extmods:get', () => ext.status(config));
ipcMain.handle('extmods:set-autostart', (e, key, on) => {
  if (!ext.MODS[key]) return false;
  config.extMods = config.extMods || {};
  config.extMods[key] = Object.assign({}, config.extMods[key], { autoStart: !!on });
  saveConfig();
  return true;
});

// ── Championship ─────────────────────────────────────────────────────────
// Points are stored per series (config.championships[seriesId]) because each
// series has its own field and its own standings.
//
// Overlay window height — keep in sync with --header-h / --row-h in
// nr2003_championship.html and the matching line in layout.html.
const CHAMP_HEADER_H = 52, CHAMP_ROW_H = 30, CHAMP_PIN_H = 36;
// the cutoff band takes its own space (gap above + band + gap below) when it falls inside the shown positions
function champCutExtra(c) {
  return (c && c.cutoffEnabled && c.cutoffPos >= (c.rowFrom || 1) && c.cutoffPos <= (c.rowTo || 0)) ? 22 : 0;
}
// the points-gap column widens the overlay
function champWidth(c) { return 384 + (c && c.gapEnabled !== false ? 54 : 0); }
function championshipWindowHeight(rows, extra) {
  return CHAMP_HEADER_H + rows * CHAMP_ROW_H + CHAMP_PIN_H + (extra || 0);
}

// NASCAR points since 2017: 40 for the win, 35 for 2nd, then one less per
// place down to 1 point (36th and below).
function nascarPoints() {
  const t = [40];
  for (let p = 2; p <= 40; p++) t.push(Math.max(1, 35 - (p - 2)));
  return t;
}

function sanitizeChampionship(raw) {
  raw = (raw && typeof raw === 'object') ? raw : {};
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

  const pointsTable = Array.isArray(raw.pointsTable)
    ? raw.pointsTable.slice(0, 100).map(v => Math.max(0, Math.round(num(v) * 100) / 100))
    : nascarPoints();

  // Stage points: separate table, any number of scoring positions (default 10 → 1)
  const stagePointsTable = Array.isArray(raw.stagePointsTable)
    ? raw.stagePointsTable.slice(0, 1000).map(v => Math.max(0, Math.round(num(v) * 100) / 100))
    : [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

  const seen = new Set();
  const drivers = [];
  for (const d of (Array.isArray(raw.drivers) ? raw.drivers.slice(0, 200) : [])) {
    if (!d || typeof d !== 'object') continue;
    const number = String(d.number == null ? '' : d.number).trim().slice(0, 4);
    if (!number || seen.has(number)) continue;   // car number is the key
    seen.add(number);
    drivers.push({
      number,
      name:   String(d.name == null ? '' : d.name).trim().slice(0, 40),
      points: Math.round(num(d.points) * 100) / 100,
      playoff: d.playoff === true,
    });
  }

  // Positions shown: rowFrom..rowTo (3-20 rows). visibleRows stays the row COUNT (window height uses it); old configs just start at 1.
  const rowFrom = Math.max(1, Math.min(99, parseInt(raw.rowFrom, 10) || 1));
  const rowToRaw = parseInt(raw.rowTo, 10) || (rowFrom - 1 + (parseInt(raw.visibleRows, 10) || 10));
  const rowTo = Math.max(rowFrom + 2, Math.min(rowFrom + 19, rowToRaw));
  const visibleRows = rowTo - rowFrom + 1;
  const cutoffEnabled = raw.cutoffEnabled === true;
  const cutoffPos = Math.max(1, Math.min(99, parseInt(raw.cutoffPos, 10) || 16));
  const gapEnabled = raw.gapEnabled !== false;
  const cutoffText = raw.cutoffText == null ? 'CUTOFF LINE' : String(raw.cutoffText).slice(0, 40);
  const cutoffTextColor = /^#[0-9a-fA-F]{6}$/.test(String(raw.cutoffTextColor || '')) ? String(raw.cutoffTextColor).toLowerCase() : '#ffffff';
  const cutoffColor = /^#[0-9a-fA-F]{6}$/.test(String(raw.cutoffColor || '')) ? String(raw.cutoffColor).toLowerCase() : '#e8232a';
  const bonus = (v) => Math.max(0, Math.min(1000, Math.round(num(v) * 100) / 100));
  const chaseSize = Math.max(1, Math.min(60, parseInt(raw.chaseSize, 10) || 10));
  return { pointsTable, stagePointsTable, drivers, visibleRows, rowFrom, rowTo, cutoffEnabled, cutoffPos, cutoffColor, cutoffText, cutoffTextColor, gapEnabled, pinPlayer: raw.pinPlayer !== false,
           bonusLedLap: bonus(raw.bonusLedLap), bonusMostLed: bonus(raw.bonusMostLed),
           chaseEnabled: raw.chaseEnabled === true, chaseSize,
           chaseWithin: Math.max(0, Math.min(100000, num(raw.chaseWithin))),
           chaseBasis: raw.chaseBasis === 'pre' ? 'pre' : 'live',
           chaseMode:  raw.chaseMode === 'manual' ? 'manual' : 'top',
           // car numbers from the Series data that were already offered to the user
           lastApplied: (raw.lastApplied && typeof raw.lastApplied === 'object' && Array.isArray(raw.lastApplied.deltas)) ? {
             key:  String(raw.lastApplied.key || '').slice(0, 120),
             at:   Number(raw.lastApplied.at) || 0,
             file: String(raw.lastApplied.file || '').slice(0, 200),
             live: raw.lastApplied.live === true,
             raceId: String(raw.lastApplied.raceId || '').slice(0, 40),
             deltas: raw.lastApplied.deltas.slice(0, 200)
               .map(d => ({ number: String((d && d.number) == null ? '' : d.number).trim().slice(0, 4), pts: Math.round(num(d && d.pts) * 100) / 100 }))
               .filter(d => d.number),
           } : null,
           seriesKnown: Array.isArray(raw.seriesKnown)
             ? [...new Set(raw.seriesKnown.map(x => String(x).trim()).filter(x => /^\d{1,4}$/.test(x)))].slice(0, 1000)
             : [] };
}

function getChampionship(seriesId) {
  return sanitizeChampionship((config.championships || {})[seriesId]);
}

function resolveSeriesId(seriesId) {
  return (typeof seriesId === 'string' && seriesId) ? seriesId : (config.series || 'default');
}

// ── Drivers from the Series Editor ───────────────────────────────────────
// A car number counts as a "driver with data" if the Series tab has a
// headshot, car photo, colour, rookie flag or name override for it. (Number PNGs and
// manufacturer logos exist for ~100 numbers in every series, so they don't count.)
function seriesDriverCandidates(id) {
  const dir = path.join(SERIES_DIR, id);
  const rd  = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) { return {}; } };
  const colors = rd('colors.json'), rookies = rd('rookies.json'), names = rd('names.json');
  const found = new Set();
  const add = (n) => { n = String(n).trim(); if (/^\d{1,4}$/.test(n)) found.add(n); };
  ['headshots', 'cars'].forEach(sub => {
    try { fs.readdirSync(path.join(dir, sub)).forEach(f => { const m = f.match(/^(\d{1,4})\.png$/i); if (m) add(m[1]); }); } catch (e) {}
  });
  Object.keys(colors).forEach(k  => { if (colors[k])  add(k); });
  Object.keys(rookies).forEach(k => { if (rookies[k]) add(k); });
  Object.keys(names).forEach(k   => { const v = names[k]; if (v && (v.first || v.last)) add(k); });
  return [...found]
    .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))
    .map(n => {
      const v = names[n];
      return { number: n, name: v ? `${v.first || ''} ${v.last || ''}`.trim().slice(0, 40) : '' };
    });
}

// Adds drivers that appeared in the Series data since last time (never ones
// the user has already seen and removed) and remembers everything it has offered.
function syncSeriesDrivers(id) {
  const stored = getChampionship(id);
  const have   = new Set(stored.drivers.map(d => d.number));
  const known  = new Set(stored.seriesKnown);
  const before = known.size;
  let added = 0;
  for (const c of seriesDriverCandidates(id)) {
    if (!have.has(c.number) && !known.has(c.number) && stored.drivers.length < 200) {
      stored.drivers.push({ number: c.number, name: c.name, points: 0, playoff: false });
      have.add(c.number); added++;
    }
    known.add(c.number);
  }
  stored.seriesKnown = [...known];
  if (added || known.size !== before) {
    if (!config.championships) config.championships = {};
    config.championships[id] = stored;
    saveConfig();
  }
  return { added, data: stored };
}

// Tell every overlay (skins, tower, ticker, championship widget) and the recorder to re-read the championship config
function broadcastChampionshipUpdated() {
  try { broadcastPointsView(); } catch (e) {}   // the cutoff line may have changed: the phone / overlays re-read it
  Object.values(overlayWindows).forEach(w => { try { if (w && !w.isDestroyed()) w.webContents.send('championship-updated'); } catch (e) {} });
  if (recorderWindow && !recorderWindow.isDestroyed()) recorderWindow.webContents.send('championship-updated');
}

ipcMain.handle('sync-championship-series', (e, seriesId) => {
  const id    = resolveSeriesId(seriesId);
  const r     = syncSeriesDrivers(id);
  const entry = scanSeries().find(s => s.id === id);
  if (r.added) {
    broadcastChampionshipUpdated();
  }
  return { seriesId: id, seriesName: (entry && entry.name) || id, data: r.data, added: r.added };
});

// For the "Add from Series" button: every driver the Series tab has data for
ipcMain.handle('get-series-drivers', (e, seriesId) => {
  const id   = resolveSeriesId(seriesId);
  const list = seriesDriverCandidates(id);
  syncSeriesDrivers(id);          // they've now been offered — deleting one afterwards sticks
  return list;
});

ipcMain.handle('get-championship', (e, seriesId) => {
  const id    = resolveSeriesId(seriesId);
  const entry = scanSeries().find(s => s.id === id);
  return { seriesId: id, seriesName: (entry && entry.name) || id, data: getChampionship(id) };
});

ipcMain.handle('save-championship', (e, seriesId, data) => {
  const id    = resolveSeriesId(seriesId);
  const clean = sanitizeChampionship(data);
  const prev = getChampionship(id);
  clean.seriesKnown = prev.seriesKnown;
  clean.lastApplied = prev.lastApplied;
  // If the points system changed, the points of the races already in the seasons follow it
  const sameSystem = JSON.stringify(prev.pointsTable) === JSON.stringify(clean.pointsTable)
    && JSON.stringify(prev.stagePointsTable) === JSON.stringify(clean.stagePointsTable)
    && prev.bonusLedLap === clean.bonusLedLap && prev.bonusMostLed === clean.bonusMostLed;
  let rescored = null;
  if (!sameSystem) rescored = rescoreRaces(id, clean);
  if (!config.championships) config.championships = {};
  config.championships[id] = clean;
  saveConfig();
  if (rescored && rescored.races) notifySeasonUpdated();

  // Live-update the overlay if it's on screen (no need to reopen overlays)
  const win = overlayWindows['championship'];
  if (win && !win.isDestroyed()) {
    const sc = (getActiveWidgets().championship || {}).scale || 1;
    win.setSize(Math.round(champWidth(clean) * sc) + 4, Math.round(championshipWindowHeight(clean.visibleRows, champCutExtra(clean)) * sc) + 4);
    // (Removed) Save used to force the overlay into edit mode (blue frame). Edit mode now only starts from the edit-mode hotkey.
  }
  broadcastChampionshipUpdated();
  return true;
});

// ── Chase: the recorder works out who is in it; we forward it to every overlay ──
let lastChase = [];
ipcMain.handle('chase-update', (e, list) => {
  lastChase = Array.isArray(list) ? list.slice(0, 100).map(x => String(x).slice(0, 8)) : [];
  Object.values(overlayWindows).forEach(w => { if (w && !w.isDestroyed()) w.webContents.send('chase-set', lastChase); });
  return true;
});
ipcMain.handle('get-chase-set', () => lastChase);

let championshipWindow = null;
let championshipDirty  = false;

function openChampionshipWindow() {
  if (championshipWindow && !championshipWindow.isDestroyed()) {
    if (championshipWindow.isMinimized()) championshipWindow.restore();
    championshipWindow.focus();
    return;
  }
  championshipDirty = false;
  championshipWindow = new BrowserWindow({
    width:     860,
    height:    900,
    minWidth:  600,
    minHeight: 600,
    resizable: true,
    title:     'Championship — All In One NR2003',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  championshipWindow.setMenuBarVisibility(false);
  championshipWindow.loadFile('championship.html');

  // Don't silently throw away a half-typed driver list
  championshipWindow.on('close', (ev) => {
    if (!championshipDirty) return;
    const choice = dialog.showMessageBoxSync(championshipWindow, {
      type:      'question',
      buttons:   ['Keep editing', 'Discard changes'],
      defaultId: 0,
      cancelId:  0,
      title:     'Unsaved changes',
      message:   'You have unsaved championship changes.',
      detail:    'Close anyway and discard them?',
    });
    if (choice === 0) ev.preventDefault();
  });
  // Keep keyboard focus inside the page (fixes inputs that show a selection but ignore typing after dialogs / overlay windows steal focus)
  championshipWindow.on('focus', () => { try { championshipWindow.webContents.focus(); } catch (e) {} });
  championshipWindow.on('closed', () => { championshipWindow = null; championshipDirty = false; });
}

ipcMain.handle('open-championship-window', () => { openChampionshipWindow(); return true; });
ipcMain.handle('set-championship-dirty',   (e, dirty) => { championshipDirty = !!dirty; return true; });

// ── Race results auto-save ───────────────────────────────────────────────
// A hidden window (race-recorder.html) watches the telemetry and, when a race
// ends, sends its summary here. We add championship points from the points
// table in the Championship window and write an NR2003-style HTML file:
//   <results folder>/<series>/R<n>.html
let recorderWindow = null;
function createRecorderWindow() {
  if (recorderWindow && !recorderWindow.isDestroyed()) return;
  recorderWindow = new BrowserWindow({
    show: false, width: 300, height: 200, skipTaskbar: true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
      backgroundThrottling: false,
    },
  });
  recorderWindow.loadFile('race-recorder.html');
  recorderWindow.on('closed', () => { recorderWindow = null; });
}

function raceResultsBaseDir() {
  const s = config.raceResults || {};
  return s.dir || path.join(app.getPath('documents'), 'All In One NR2003 Race Results');
}
function safeFileName(s) { return String(s || 'default').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60); }
function dmy(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
}

function round2(n) { return Math.round(n * 100) / 100; }

// Adds the points each listed driver earned to their championship total and
// remembers exactly what was added (for "Undo last race" and so the overlays
// don't count the same race twice while the session is still on screen).
function applyRacePoints(id, rows, key, file, raceId) {
  const stored = getChampionship(id);
  const last   = stored.lastApplied;
  if (last && key && last.key === key && Date.now() - last.at < 10 * 60 * 1000) return { duplicate: true };

  const byNum = new Map(stored.drivers.map(d => [d.number, d]));
  const deltas = [];
  rows.forEach(r => {
    const d = byNum.get(String(r.number).trim());
    const pts = Number(r.points) || 0;
    if (!d) return;
    d.points = round2(d.points + pts);
    deltas.push({ number: d.number, pts });          // 0-point drivers too (see reconcileRace)
  });
  if (!deltas.length) return { drivers: 0 };

  stored.lastApplied = { key: String(key || ''), at: Date.now(), file: file ? path.basename(file) : '', live: true, raceId: String(raceId || ''), deltas };
  if (!config.championships) config.championships = {};
  config.championships[id] = stored;
  saveConfig();
  notifyChampionshipChanged();
  return { drivers: deltas.filter(x => x.pts).length, deltas };
}

// Tell everything that shows championship data to re-read it
function notifyChampionshipChanged() {
  broadcastChampionshipUpdated();
  if (championshipWindow && !championshipWindow.isDestroyed()) championshipWindow.webContents.send('championship-points-applied');
}


// ── Seasons ──────────────────────────────────────────────────────────────
// One JSON file per series: <data folder>/seasons/<series>.json
//   { version, activeId, seasons: [ { id, name, createdAt, closedAt, finalStandings, races: [ … ] } ] }
// Every finished race is appended to the active season (see saveRaceResult).
// Written atomically (temp file + rename) so a crash can never leave half a season behind.
const SEASONS_DIR = path.join(USER_DATA, 'seasons');
function seasonsPath(id) { return path.join(SEASONS_DIR, safeFileName(id) + '.json'); }
function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function loadSeasons(id) {
  try {
    const j = JSON.parse(fs.readFileSync(seasonsPath(id), 'utf8'));
    if (j && Array.isArray(j.seasons)) return j;
  } catch (e) {}
  return { version: 1, activeId: null, seasons: [] };
}
function saveSeasons(id, data) {
  fs.mkdirSync(SEASONS_DIR, { recursive: true });
  const p = seasonsPath(id), tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, p);
}
function makeSeason(name) {
  return { id: newId(), name: String(name || '').trim().slice(0, 60) || `${new Date().getFullYear()} Season`,
           createdAt: Date.now(), closedAt: null, finalStandings: null, races: [] };
}
function ensureActiveSeason(data) {
  let s = data.seasons.find(x => x.id === data.activeId);
  if (!s) { s = makeSeason(''); data.seasons.push(s); data.activeId = s.id; }
  return s;
}
function notifySeasonUpdated() {
  if (championshipWindow && !championshipWindow.isDestroyed()) championshipWindow.webContents.send('season-updated');
}
function snapshotStandings(id) {
  return getChampionship(id).drivers
    .map(d => ({ number: d.number, name: d.name, points: d.points }))
    .sort((a, b) => b.points - a.points);
}

// Appends a finished race to the active season (creating "<year> Season" the first time)
function addRaceToSeason(id, race, seasonId) {
  const data   = loadSeasons(id);
  const season = (seasonId && data.seasons.find(x => x.id === seasonId)) || ensureActiveSeason(data);
  // "Next race name": the name typed in before the race goes to the race that finishes next
  if (!race.imported && season.id === data.activeId) {
    if (!race.name && season.nextName) race.name = season.nextName;
    season.nextName = '';                              // used up
  }
  race.name = race.name || '';
  const last   = season.races[season.races.length - 1];
  if (last && race.key && last.key === race.key && race.at - last.at < 10 * 60 * 1000) return { duplicate: true };
  season.races.push(race);
  saveSeasons(id, data);
  notifySeasonUpdated();
  return { seasonId: season.id, seasonName: season.name, number: season.races.length, raceId: race.id };
}

// Name typed in for the next race (used by the file written at the end of a race too)
function peekNextRaceName(id) {
  const data = loadSeasons(id);
  const s = data.seasons.find(x => x.id === data.activeId);
  return (s && s.nextName) || '';
}

// Same row shape the live recorder produces
function seasonRows(rows) {
  return rows.map(r => ({
    finish: r.finish, start: r.start == null ? null : r.start, number: String(r.number), name: String(r.name || '').slice(0, 40),
    interval: String(r.interval || ''), laps: r.laps, led: r.led, mostLed: !!r.mostLed, points: r.points, status: String(r.status || ''),
    ...(r.dq ? { dq: true } : {}),
    ...((Array.isArray(r.stages) && r.stages.some(p => p >= 1)) ? { stages: r.stages.map(p => Math.max(0, Math.round(Number(p) || 0))), stagePts: r.stagePts || 0 } : {}),
    ...(Number(r.penaltyPts) ? { penaltyPts: round2(Number(r.penaltyPts)) } : {}),
    ...(Number(r.bonusPts) ? { bonusPts: round2(Number(r.bonusPts)) } : {}),
    ...(r.note ? { note: String(r.note).slice(0, 120) } : {}),
    ...(r.origFinish != null ? { origFinish: r.origFinish } : {}),
  }));
}

// Points for every row of a race under the ACTIVE points system of the series
// (position table + led-a-lap bonus + led-most-laps bonus). Used for the live
// recorder and for imported files, so both always follow the same rules.
// "Most laps" is decided among ALL cars in the file; ties each get the bonus.
// Manual edits made in "Edit results" are kept on the row and always respected:
//   dq          → disqualified: no position points, no bonuses (penalty still applies)
//   penaltyPts  → points taken away (can leave the race total negative)
//   bonusPts    → extra points given by hand
function scoreRows(rows, champ) {
  let maxLed = 0;
  rows.forEach(r => { r.led = Number(r.led) || 0; if (!r.dq && r.led > maxLed) maxLed = r.led; });
  rows.forEach(r => {
    r.mostLed = !r.dq && maxLed > 0 && r.led === maxLed;
    // Stage points: r.stages = finishing position of the car in each stage (0 / missing = none)
    const stT = Array.isArray(champ.stagePointsTable) ? champ.stagePointsTable : [];
    r.stagePts = r.dq ? 0 : round2((Array.isArray(r.stages) ? r.stages : [])
      .reduce((a, p) => a + (p >= 1 ? (Number(stT[p - 1]) || 0) : 0), 0));
    const base = r.dq ? 0 : ((Number(champ.pointsTable[r.finish - 1]) || 0)
                     + (r.led > 0 ? champ.bonusLedLap : 0)
                     + (r.mostLed ? champ.bonusMostLed : 0)
                     + r.stagePts);
    r.points  = round2(base + (Number(r.bonusPts) || 0) - (Number(r.penaltyPts) || 0));
  });
  return rows;
}

// Brings a race's contribution to the championship totals in line with its current rows.
// race.applied lists EVERY championship driver the race was counted for — including ones
// that scored 0 — so a later points-system change can still give them points
// (older saves left out 0-point drivers; for those, every listed driver in the race counts).
// Returns how many totals changed. Mutates byNum drivers, race.applied and champ.lastApplied.
function reconcileRace(race, champ, byNum) {
  if (race.nonPoints) return 0;                       // non-scoring race: never part of the championship totals
  const counted = race.counted === true || (Array.isArray(race.applied) && race.applied.length > 0);
  if (!counted) return 0;
  const prev = new Map((race.applied || []).map(x => [String(x.number).trim(), Number(x.pts) || 0]));
  const next = [];
  let adjusted = 0;
  (race.rows || []).forEach(r => {
    const k = String(r.number).trim();
    const d = byNum.get(k);
    if (!d) return;
    if (race.appliedAll && !prev.has(k)) return;        // wasn't in the championship when the race counted
    const pts = Number(r.points) || 0, old = prev.get(k) || 0;
    if (pts !== old) { d.points = round2(d.points + pts - old); adjusted++; }
    next.push({ number: d.number, pts });
  });
  race.applied = next; race.counted = true; race.appliedAll = true;
  if (champ.lastApplied && race.id && champ.lastApplied.raceId === race.id) champ.lastApplied.deltas = next;
  return adjusted;
}

// Recalculates the points of EVERY race already stored for the series (imported or
// recorded live) with the points system in `champ`. Where a race had already been
// added to the championship totals, each driver's total is corrected by the
// difference (so manual edits to the totals are kept) and the race's record of
// "what it added" is updated, so Delete race / Undo keep subtracting the right amount.
// The championship totals belong to the ACTIVE season only (a new season can reset them), so races of
// closed / other seasons get their POINTS column recalculated but never touch the totals.
// Mutates champ.drivers / champ.lastApplied; the caller saves the championship.
function rescoreRaces(id, champ) {
  const data = loadSeasons(id);
  const byNum = new Map(champ.drivers.map(d => [d.number, d]));
  let races = 0, changedRows = 0, adjusted = 0, touched = false, addedRaces = 0, addedDrivers = 0;
  for (const season of data.seasons) {
    const isActiveSeason = season.id === data.activeId;
    for (const race of season.races) {
      if (!Array.isArray(race.rows) || !race.rows.length) continue;
      const old = new Map(race.rows.map(r => [String(r.number).trim(), Number(r.points) || 0]));
      scoreRows(race.rows, champ);
      races++; touched = true;
      race.rows.forEach(r => { if ((old.get(String(r.number).trim()) || 0) !== r.points) changedRows++; });
      if (race.nonPoints) continue;                                   // non-scoring: only its POINTS column is refreshed
      if (!isActiveSeason) continue;                                  // other seasons: totals are not theirs to change
      const wasCounted = race.counted === true || (Array.isArray(race.applied) && race.applied.length > 0);
      if (!wasCounted) {                                              // never added to the totals: add it now
        const deltas = [];
        race.rows.forEach(r => {
          const d = byNum.get(String(r.number).trim());
          if (!d) return;
          const pts = Number(r.points) || 0;
          d.points = round2(d.points + pts); deltas.push({ number: d.number, pts });
        });
        if (deltas.length) {
          race.applied = deltas; race.counted = true; race.appliedAll = true;
          addedRaces++; addedDrivers += deltas.filter(x => x.pts).length;
        }
        continue;
      }
      adjusted += reconcileRace(race, champ, byNum);
    }
  }
  if (touched) saveSeasons(id, data);
  return { races, changedRows, adjusted, addedRaces, addedDrivers };
}

// Reads race files exported by NR2003 and adds them to a season (all their data: qualifying, weather, penalties…).
// Races already in the season are skipped. The points of each row are recalculated with the points system
// that is active for the series (the POINTS column written by the game is ignored); optionally they are added to the totals.
function importRaceFiles(id, seasonId, files, opts) {
  const data   = loadSeasons(id);
  const season = (seasonId && data.seasons.find(x => x.id === seasonId)) || ensureActiveSeason(data);
  const result = { added: [], skipped: [], applied: 0 };
  const stored = getChampionship(id);
  const byNum  = new Map(stored.drivers.map(d => [d.number, d]));
  let touchedPoints = false;

  for (const f of files) {
    const base = path.basename(f);
    let parsed;
    try { parsed = parseRaceHtml(fs.readFileSync(f, 'latin1')); }
    catch (err) { result.skipped.push({ file: base, reason: 'could not read the file' }); continue; }
    if (!parsed.ok) { result.skipped.push({ file: base, reason: parsed.error }); continue; }
    const p = parsed.race, w = p.rows[0];
    const key = `import:${p.track}|${p.dateStr}|${w.number}|${w.laps}|${p.rows.length}`;
    if (season.races.some(r => r.key === key)) { result.skipped.push({ file: base, reason: 'already in this season' }); continue; }

    const race = {
      id: newId(), at: p.at || Date.now(), key, imported: true,
      name: String(p.name || '').slice(0, 80), track: String(p.track || '').slice(0, 80), dateStr: p.dateStr || '',
      file: base,
      cautionFlags: p.cautionFlags, cautionLaps: p.cautionLaps, leadChanges: p.leadChanges, leadDrivers: p.leadDrivers, partial: false,
      weatherQual: p.weatherQual, weather: p.weather, pitFrequency: p.pitFrequency, aiStrength: p.aiStrength,
      penalties: p.penalties,
      qualifying: p.qualifying.map(q => ({ pos: q.pos, number: String(q.number), name: String(q.name || '').slice(0, 40), time: q.time })),
      rows: seasonRows(scoreRows(p.rows, stored)), applied: null,
    };
    if (opts && opts.applyPoints && season.id !== data.activeId) result.notApplied = true;   // totals belong to the active season
    if (opts && opts.applyPoints && season.id === data.activeId) {
      const deltas = [];
      race.rows.forEach(r => {
        const d = byNum.get(r.number), pts = Number(r.points) || 0;
        if (!d) return;
        d.points = round2(d.points + pts); deltas.push({ number: d.number, pts });
      });
      if (deltas.length) { race.applied = deltas; race.counted = true; race.appliedAll = true; result.applied += deltas.filter(x => x.pts).length; touchedPoints = true; }
    }
    season.races.push(race);
    result.added.push({ file: base, name: race.name || race.track, rows: race.rows.length });
  }

  if (result.added.length) {
    season.races.sort((a, b) => a.at - b.at);            // chronological, whatever order the files were picked in
    saveSeasons(id, data);
    if (touchedPoints) {
      if (!config.championships) config.championships = {};
      config.championships[id] = stored; saveConfig(); notifyChampionshipChanged();
    }
    notifySeasonUpdated();
  }
  return result;
}

// Removes a race from whichever season holds it. Returns the removed race (or null).
function removeRaceById(id, raceId) {
  const data = loadSeasons(id);
  for (const s of data.seasons) {
    const i = s.races.findIndex(r => r.id === raceId);
    if (i >= 0) { const [r] = s.races.splice(i, 1); saveSeasons(id, data); notifySeasonUpdated(); return r; }
  }
  return null;
}

function saveRaceResult(payload) {
  const s = config.raceResults || {};
  const wantHtml   = s.enabled !== false;
  const wantPoints = s.addPoints !== false;
  const wantSeason = s.saveToSeason !== false;
  if (!wantHtml && !wantPoints && !wantSeason) return { skipped: 'disabled' };
  const rows = (payload && Array.isArray(payload.rows)) ? payload.rows : [];
  if (!rows.length) return { skipped: 'empty' };

  const id    = config.series || 'default';
  const champ = getChampionship(id);

  // Same rules as the live overlay: position points + led-a-lap + led-most-laps
  scoreRows(rows, champ);

  const out = {};
  let dir = '';
  const eventName = peekNextRaceName(id);
  if (wantHtml) {
    const buf = buildRaceHtml({
      track:        payload.track,
      date:         dmy(new Date()),
      eventName,
      qualifying:   payload.qualifying,
      rows,
      cautionFlags: payload.cautionFlags,
      cautionLaps:  payload.cautionLaps,
      leadChanges:  payload.leadChanges,
      leadDrivers:  payload.leadDrivers,
    });
    dir = path.join(raceResultsBaseDir(), safeFileName(id));
    fs.mkdirSync(dir, { recursive: true });
    if (!config.raceResults) config.raceResults = {};
    if (!config.raceResults.counters) config.raceResults.counters = {};
    let n = parseInt(config.raceResults.counters[id], 10) || 1;
    while (fs.existsSync(path.join(dir, `R${n}.html`))) n++;      // never overwrite
    out.file = path.join(dir, `R${n}.html`);
    fs.writeFileSync(out.file, buf);
    config.raceResults.counters[id] = n + 1;
    saveConfig();
  }

  const raceId = newId();
  if (wantPoints) out.points = applyRacePoints(id, rows, payload.key, out.file, raceId);

  // Keep the full result in the season (unless this exact race was already counted a moment ago)
  if (wantSeason && !(out.points && out.points.duplicate)) {
    out.season = addRaceToSeason(id, {
      id: raceId, at: Date.now(), key: String(payload.key || ''),
      track: String(payload.track || '').slice(0, 80),
      file: out.file ? path.basename(out.file) : '',
      cautionFlags: payload.cautionFlags, cautionLaps: payload.cautionLaps,
      leadChanges: payload.leadChanges, leadDrivers: payload.leadDrivers, partial: !!payload.partial,
      applied: (out.points && out.points.deltas) ? out.points.deltas : null,
      counted: !!(out.points && out.points.deltas), appliedAll: !!(out.points && out.points.deltas),
      qualifying: (Array.isArray(payload.qualifying) ? payload.qualifying : []).slice(0, 60).map(q => ({
        pos: q.pos, number: String(q.number), name: String(q.name || '').slice(0, 40), time: String(q.time || '--') })),
      rows: seasonRows(rows),
    });
  }

  try {
    if (Notification.isSupported()) {
      const parts = [];
      if (out.file) parts.push(`${path.basename(out.file)} saved`);
      if (out.points && out.points.drivers) parts.push(`championship points added for ${out.points.drivers} drivers`);
      if (out.season && out.season.number) parts.push(`R${out.season.number} saved to "${out.season.seasonName}"`);
      if (payload.partial && out.points && out.points.drivers) parts.push('laps-led bonus may be incomplete (app opened mid-race)');
      new Notification({ title: 'Race finished', body: parts.join(' — ') || 'Race results processed' }).show();
    }
  } catch (e) {}
  if (out.file && championshipWindow && !championshipWindow.isDestroyed()) championshipWindow.webContents.send('race-result-saved', out.file);
  return out;
}

// Take back the points added by the last race
ipcMain.handle('undo-last-race-points', () => {
  const id     = config.series || 'default';
  const stored = getChampionship(id);
  const last   = stored.lastApplied;
  if (!last || !last.deltas.length) return { ok: false };
  const byNum = new Map(stored.drivers.map(d => [d.number, d]));
  let n = 0;
  last.deltas.forEach(x => { const d = byNum.get(x.number); if (d) { d.points = round2(d.points - x.pts); if (x.pts) n++; } });
  stored.lastApplied = null;
  if (!config.championships) config.championships = {};
  config.championships[id] = stored;
  saveConfig();
  // the race that was just taken back no longer belongs in the season either
  let removed = false;
  if (last.raceId) removed = !!removeRaceById(id, last.raceId);
  notifyChampionshipChanged();
  return { ok: true, drivers: n, removedFromSeason: removed };
});

// ── Season management (Championship window → Season results tab) ─────────
ipcMain.handle('get-season-state', (e, seriesId) => {
  const id = resolveSeriesId(seriesId);
  return Object.assign({ seriesId: id }, loadSeasons(id));
});

// New season: closes the current one (keeping its final standings) and starts an empty one.
ipcMain.handle('season-create', (e, seriesId, name, opts) => {
  const id   = resolveSeriesId(seriesId);
  const data = loadSeasons(id);
  const prev = data.seasons.find(x => x.id === data.activeId);
  if (prev && !prev.closedAt) { prev.closedAt = Date.now(); prev.finalStandings = snapshotStandings(id); }
  const s = makeSeason(name);
  data.seasons.push(s); data.activeId = s.id;
  saveSeasons(id, data);
  if (opts && opts.resetPoints) {
    const stored = getChampionship(id);
    stored.drivers.forEach(d => { d.points = 0; d.playoff = false; });
    stored.lastApplied = null;
    if (!config.championships) config.championships = {};
    config.championships[id] = stored;
    saveConfig();
    notifyChampionshipChanged();
  }
  notifySeasonUpdated();
  return Object.assign({ seriesId: id }, data);
});

ipcMain.handle('season-set-active', (e, seriesId, seasonId) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  const s  = data.seasons.find(x => x.id === seasonId);
  if (s) {
    const prev = data.seasons.find(x => x.id === data.activeId);
    if (prev && prev !== s && !prev.closedAt) { prev.closedAt = Date.now(); prev.finalStandings = snapshotStandings(id); }
    data.activeId = s.id; s.closedAt = null;
    saveSeasons(id, data); notifySeasonUpdated();
  }
  return Object.assign({ seriesId: id }, data);
});

ipcMain.handle('season-rename', (e, seriesId, seasonId, name) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  const s  = data.seasons.find(x => x.id === seasonId), nm = String(name || '').trim().slice(0, 60);
  if (s && nm) { s.name = nm; saveSeasons(id, data); notifySeasonUpdated(); }
  return Object.assign({ seriesId: id }, data);
});

ipcMain.handle('season-delete', (e, seriesId, seasonId) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  data.seasons = data.seasons.filter(x => x.id !== seasonId);
  if (data.activeId === seasonId) data.activeId = data.seasons.length ? data.seasons[data.seasons.length - 1].id : null;
  saveSeasons(id, data); notifySeasonUpdated();
  return Object.assign({ seriesId: id }, data);
});

// Delete one race; optionally take the points it added back out of the totals
ipcMain.handle('season-delete-race', (e, seriesId, raceId, subtract) => {
  const id   = resolveSeriesId(seriesId);
  const race = removeRaceById(id, String(raceId || ''));
  if (race) {
    const stored = getChampionship(id);
    const isLast = !!(stored.lastApplied && stored.lastApplied.raceId === race.id);   // the one "Undo" would refer to
    if (subtract && race.applied && race.applied.length) {
      const byNum = new Map(stored.drivers.map(d => [d.number, d]));
      race.applied.forEach(x => { const d = byNum.get(x.number); if (d) d.points = round2(d.points - x.pts); });
      if (isLast) stored.lastApplied = null;
    } else if (isLast) {
      stored.lastApplied.raceId = '';          // points stay; "Undo" must not try to remove a race that is already gone
    }
    if (!config.championships) config.championships = {};
    config.championships[id] = stored;
    saveConfig();
    notifyChampionshipChanged();
  }
  return Object.assign({ seriesId: id }, loadSeasons(id));
});

// Name a race (e.g. "Daytona 250", "CookOut 375")
ipcMain.handle('season-race-update', (e, seriesId, raceId, patchObj) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  for (const s of data.seasons) {
    const r = s.races.find(x => x.id === raceId);
    if (r) {
      if (patchObj && typeof patchObj.name === 'string') r.name = patchObj.name.trim().slice(0, 80);
      saveSeasons(id, data); notifySeasonUpdated(); break;
    }
  }
  return Object.assign({ seriesId: id }, loadSeasons(id));
});

// Edit the result of a stored race: new finishing order, DQ, points penalties/bonuses,
// status, laps, laps led, notes. Points are recalculated with the active points system and,
// if the race was counted in the championship, the totals are corrected by the difference.
ipcMain.handle('season-race-edit-results', (e, seriesId, raceId, edit) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  let race = null;
  for (const s of data.seasons) { race = s.races.find(x => x.id === raceId); if (race) break; }
  if (!race || !edit || !Array.isArray(edit.rows)) return { ok: false, error: 'race not found' };
  const old = new Map((race.rows || []).map(r => [String(r.number).trim(), r]));
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  const seen = new Set(), rows = [];
  edit.rows.forEach(x => {
    const k = String(x && x.number || '').trim(), o = old.get(k);
    if (!o || seen.has(k)) return;           // only cars that are in the race, once each
    seen.add(k);
    rows.push({
      ...o,
      origFinish: o.origFinish != null ? o.origFinish : o.finish,
      status:     String(x.status == null ? o.status : x.status).slice(0, 40),
      laps:       x.laps === undefined ? o.laps : Math.max(0, Math.round(num(x.laps))),
      led:        x.led  === undefined ? o.led  : Math.max(0, Math.round(num(x.led))),
      dq:         x.dq === true,
      penaltyPts: Math.max(0, Math.min(10000, round2(num(x.penaltyPts)))),
      bonusPts:   Math.max(0, Math.min(10000, round2(num(x.bonusPts)))),
      note:       String(x.note || '').trim().slice(0, 120),
      ...(Array.isArray(x.stages) ? { stages: x.stages.slice(0, 20).map(p => Math.max(0, Math.min(1000, Math.round(num(p))))) } : {}),
    });
  });
  (race.rows || []).forEach(o => { if (!seen.has(String(o.number).trim())) rows.push({ ...o }); });  // never lose a car
  // Disqualified cars go to the bottom (keeping their relative order)
  const ordered = rows.filter(r => !r.dq).concat(rows.filter(r => r.dq));
  ordered.forEach((r, i) => {
    r.finish = i + 1;
    if (Array.isArray(r.stages) && !r.stages.some(p => p >= 1)) delete r.stages;      // no stage result: nothing to keep
    if (r.dq && (!r.status || /^running$/i.test(r.status))) r.status = 'Disqualified';
    if (r.origFinish === r.finish && !r.dq && !r.penaltyPts && !r.bonusPts && !r.note) delete r.origFinish;
  });
  const stored = getChampionship(id);
  race.rows = seasonRows(scoreRows(ordered, stored));
  race.edited = Date.now();
  const adjusted = reconcileRace(race, stored, new Map(stored.drivers.map(d => [d.number, d])));
  saveSeasons(id, data);
  if (!config.championships) config.championships = {};
  config.championships[id] = stored;
  saveConfig();
  notifyChampionshipChanged();
  notifySeasonUpdated();
  return { ok: true, adjusted, state: Object.assign({ seriesId: id }, loadSeasons(id)) };
});

// Make a stored race non-scoring (its points are taken out of the totals) or count it again
ipcMain.handle('season-race-set-scoring', (e, seriesId, raceId, nonPts) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  let race = null;
  for (const s of data.seasons) { race = s.races.find(x => x.id === raceId); if (race) break; }
  if (!race) return { ok: false, error: 'race not found' };
  const stored = getChampionship(id);
  const byNum  = new Map(stored.drivers.map(d => [String(d.number).trim(), d]));
  const want   = !!nonPts;
  if (want && !race.nonPoints) {
    // take back out what the race added
    (race.applied || []).forEach(x => {
      const d = byNum.get(String(x.number).trim());
      if (d) d.points = round2(d.points - (Number(x.pts) || 0));
    });
    race.nonPoints = true; race.counted = false; race.applied = null; race.appliedAll = false;
    if (stored.lastApplied && stored.lastApplied.raceId === race.id) stored.lastApplied = null;
  } else if (!want && race.nonPoints) {
    // count it again with the active points system
    scoreRows(race.rows || [], stored);
    const deltas = [];
    (race.rows || []).forEach(r => {
      const d = byNum.get(String(r.number).trim());
      if (!d) return;
      const pts = Number(r.points) || 0;
      d.points = round2(d.points + pts); deltas.push({ number: d.number, pts });
    });
    delete race.nonPoints;
    race.applied = deltas; race.counted = deltas.length > 0; race.appliedAll = true;
  }
  saveSeasons(id, data);
  if (!config.championships) config.championships = {};
  config.championships[id] = stored;
  saveConfig();
  notifyChampionshipChanged();
  notifySeasonUpdated();
  return { ok: true, nonPoints: !!race.nonPoints, state: Object.assign({ seriesId: id }, loadSeasons(id)) };
});

// Name for the race that finishes next (written into its result file and season entry)
ipcMain.handle('season-set-next-name', (e, seriesId, name) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  const s  = ensureActiveSeason(data);
  s.nextName = String(name || '').trim().slice(0, 80);
  saveSeasons(id, data); notifySeasonUpdated();
  return Object.assign({ seriesId: id }, data);
});

// Recalculate the points of every stored race with the points system that is active now
ipcMain.handle('season-rescore', (e, seriesId) => {
  const id = resolveSeriesId(seriesId);
  const stored = getChampionship(id);
  const res = rescoreRaces(id, stored);
  if (!config.championships) config.championships = {};
  config.championships[id] = stored;
  saveConfig();
  notifyChampionshipChanged();
  notifySeasonUpdated();
  return Object.assign({ seriesId: id, state: Object.assign({ seriesId: id }, loadSeasons(id)) }, res);
});

// Import race files exported by NR2003 into a season
ipcMain.handle('season-import-races', async (e, seriesId, seasonId, opts) => {
  const id = resolveSeriesId(seriesId);
  const r  = await dialog.showOpenDialog(championshipWindow || mainWindow, {
    title:      'Import race results exported by NR2003',
    filters:    [{ name: 'NR2003 results (HTML)', extensions: ['html', 'htm'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return { canceled: true };
  const res = importRaceFiles(id, seasonId, r.filePaths, opts);
  return Object.assign({ seriesId: id, state: Object.assign({ seriesId: id }, loadSeasons(id)) }, res);
});

// Write a race out as an NR2003-style results file (with everything that is stored for it)
ipcMain.handle('season-export-race', async (e, seriesId, raceId) => {
  const id = resolveSeriesId(seriesId), data = loadSeasons(id);
  let race = null, n = 0;
  for (const s of data.seasons) { const i = s.races.findIndex(x => x.id === raceId); if (i >= 0) { race = s.races[i]; n = i + 1; break; } }
  if (!race) return null;
  const buf = buildRaceHtml({
    track: race.track, date: race.dateStr || dmy(new Date(race.at)), eventName: race.name,
    qualifying: race.qualifying, rows: race.rows,
    cautionFlags: race.cautionFlags, cautionLaps: race.cautionLaps, leadChanges: race.leadChanges, leadDrivers: race.leadDrivers,
    weatherQual: race.weatherQual, weather: race.weather, pitFrequency: race.pitFrequency, aiStrength: race.aiStrength,
    penalties: Array.isArray(race.penalties) ? race.penalties : undefined,
  });
  const r = await dialog.showSaveDialog(championshipWindow || mainWindow, {
    title:       'Save race results',
    defaultPath: path.join(raceResultsBaseDir(), safeFileName(id), safeFileName(race.name || `R${n}`) + '.html'),
    filters:     [{ name: 'HTML', extensions: ['html'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
  fs.writeFileSync(r.filePath, buf);
  return r.filePath;
});

// The recorder saw the green flag of a new race: stop neutralising the previous one
ipcMain.handle('race-started', () => {
  const id = config.series || 'default';
  const stored = getChampionship(id);
  if (stored.lastApplied && stored.lastApplied.live) {
    stored.lastApplied.live = false;
    if (!config.championships) config.championships = {};
    config.championships[id] = stored;
    saveConfig();
    notifyChampionshipChanged();
  }
  return true;
});

ipcMain.handle('save-race-result', (e, payload) => {
  return { skipped: 'the Championship is not part of this build: the season tracker keeps the points' };
  try { return saveRaceResult(payload); }
  catch (err) { console.error('save-race-result failed:', err); return { error: String(err && err.message || err) }; }
});

ipcMain.handle('get-race-results-settings', () => {
  const s  = config.raceResults || {};
  const id = config.series || 'default';
  const la = getChampionship(id).lastApplied;
  return { enabled: s.enabled !== false, addPoints: s.addPoints !== false, saveToSeason: s.saveToSeason !== false, dir: raceResultsBaseDir(), seriesId: id, next: (s.counters || {})[id] || 1,
           last: la ? { file: la.file, at: la.at, drivers: la.deltas.filter(x => x.pts).length } : null };
});
ipcMain.handle('set-race-results-settings', (e, v) => {
  if (!config.raceResults) config.raceResults = {};
  const s = config.raceResults;
  if (v && typeof v.enabled === 'boolean') s.enabled = v.enabled;
  if (v && typeof v.addPoints === 'boolean') s.addPoints = v.addPoints;
  if (v && typeof v.saveToSeason === 'boolean') s.saveToSeason = v.saveToSeason;
  if (v && v.next != null) {
    const n = parseInt(v.next, 10);
    if (n >= 1 && n <= 9999) { if (!s.counters) s.counters = {}; s.counters[config.series || 'default'] = n; }
  }
  saveConfig();
  return true;
});
ipcMain.handle('browse-race-results-dir', async () => {
  const r = await dialog.showOpenDialog(championshipWindow || mainWindow, {
    title: 'Folder for race results', properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  if (!config.raceResults) config.raceResults = {};
  config.raceResults.dir = r.filePaths[0];
  saveConfig();
  return r.filePaths[0];
});
ipcMain.handle('open-race-results-dir', async () => {
  const d = raceResultsBaseDir();
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  await shell.openPath(d);
  return true;
});

ipcMain.handle('browse-bc-exe', async () => {
  const result = await dialog.showOpenDialog({
    title:       'Locate Better Cautions (bc.exe)',
    filters:     [{ name: 'Executable', extensions: ['exe'] }],
    properties:  ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const bcPath = result.filePaths[0];
  config.bcExe = bcPath;
  saveConfig();
  return true;
});
// launch RaceControl / AIMOD when NR2003 starts (once per NR2003 session), for the mods with "launch with NR2003" on
const autoStartAttempted = {};
function startExtmodsWatcher() {
  return;                     // no companion apps to start in All In One NR2003
  setInterval(() => {
    try {
      for (const key of ext.autoStartDue(config, ext.runningNames(undefined, Date.now(), 4000), autoStartAttempted)) {
        (key === 'raceVision' && raceVision ? raceVision.launch() : ext.launch(key, config)).then(r => console.log('[extmods] auto-start', key, JSON.stringify(r)));
      }
    } catch (e) { /* never let the watcher break the app */ }
  }, 5000);
}

// ── Race schedule: pick a real race once -> stages (RaceControl + AIMOD follow) and, optionally, NR2003's race length
ipcMain.handle('schedule:list', () => {
  const d = schedule.load();
  return { series: d.series, source: d.source, note: d.note, races: d.races };
});
ipcMain.handle('schedule:apply', (e, id, setDistance) => {
  const race = schedule.find(schedule.load(), id);
  if (!race) return { ok: false, error: 'unknown race' };
  return applyRaceSetup(race, setDistance);
});
// a race's stage lengths -> Stage Racing (RaceControl + AIMOD follow), and optionally NR2003's race length (the race picker / a season's schedule)
function applyRaceSetup(race, setDistance) {
  const sr = ext.applyRaceControlMode(Object.assign({}, config.stageRacing || {}, race.stages && race.stages.length ? schedule.stageConfig(race) : { stagesOff: false }));
  if (sr.stagesOff) sr.enabled = false;
  config.stageRacing = sr;
  saveConfig();
  const out = { ok: true, race, stageRacing: sr };
  if (setDistance) {
    const exePath = () => config.nr2003_exe || '';
    const mem = new Win32Memory(() => gameExe.names(config), exePath);
    try { out.distance = schedule.setRaceLength(mem, race.laps); } finally { try { mem.detach(); } catch (_) { /* ignore */ } }
  }
  return out;
}
ipcMain.handle('extmods:launch', () => ({ ok: false, error: 'Companion apps are not part of All In One NR2003.' }));
ipcMain.handle('extmods:launch-racebrain', () => ({ ok: false, error: 'Companion apps are not part of All In One NR2003.' }));
ipcMain.handle('extmods:open-folder', () => false);
ipcMain.handle('extmods:browse', () => null);
ipcMain.handle('get-profiles',       () => ({ profiles: Object.keys(config.profiles), active: config.activeProfile }));
ipcMain.handle('set-active-profile', (e, name) => {
  if (config.profiles[name]) {
    config.activeProfile = name;
    saveConfig();
    if (shimProc) reopenOverlays();
  }
  return config.activeProfile;
});
ipcMain.handle('new-profile', async (e, name) => {
  if (!name || config.profiles[name]) return false;
  const active = getActiveWidgets();
  config.profiles[name] = { widgets: JSON.parse(JSON.stringify(active)) };
  config.activeProfile  = name;
  saveConfig();
  return true;
});

ipcMain.handle('show-input-dialog', async (e, { title, label }) => {
  // Create a small input dialog window
  return new Promise((resolve) => {
    const dlg = new BrowserWindow({
      width: 360, height: 160,
      parent: mainWindow,
      modal: true,
      resizable: false,
      frame: false,
      webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    const html = `<!DOCTYPE html>
<html><head><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#1a1d23; color:#e0e4ec; font-family:'Segoe UI',sans-serif;
         padding:20px; display:flex; flex-direction:column; gap:12px; }
  label { font-size:12px; color:#aaa; }
  input { width:100%; background:#0e1014; border:1px solid #2a2d35; border-radius:4px;
          padding:8px 10px; font-size:14px; color:#fff; outline:none; }
  input:focus { border-color:#3a7bd5; }
  .btns { display:flex; gap:8px; justify-content:flex-end; }
  button { border:none; border-radius:4px; padding:7px 16px; font-size:13px;
           font-weight:600; cursor:pointer; }
  .ok  { background:#3a7bd5; color:#fff; }
  .cancel { background:#252830; color:#aaa; }
</style></head>
<body>
  <label>${label}</label>
  <input type="text" id="val" autofocus>
  <div class="btns">
    <button class="cancel" onclick="require('electron').ipcRenderer.send('dlg-result', null)">Cancel</button>
    <button class="ok" onclick="require('electron').ipcRenderer.send('dlg-result', document.getElementById('val').value.trim())">OK</button>
  </div>
  <script>
    document.getElementById('val').addEventListener('keydown', e => {
      if (e.key === 'Enter') require('electron').ipcRenderer.send('dlg-result', document.getElementById('val').value.trim());
      if (e.key === 'Escape') require('electron').ipcRenderer.send('dlg-result', null);
    });
  </script>
</body></html>`;
    dlg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const { ipcMain: ipc } = require('electron');
    ipc.once('dlg-result', (ev, val) => {
      dlg.close();
      resolve(val);
    });
    dlg.on('closed', () => resolve(null));
  });
});
ipcMain.handle('rename-profile', async (e, { oldName, newName }) => {
  if (!newName || oldName === 'Default' || !config.profiles[oldName]) return false;
  if (config.profiles[newName]) return false;  // name taken
  config.profiles[newName] = config.profiles[oldName];
  delete config.profiles[oldName];
  if (config.activeProfile === oldName) config.activeProfile = newName;
  saveConfig();
  return true;
});

ipcMain.handle('delete-profile', (e, name) => {
  if (name === 'Default' || !config.profiles[name]) return false;
  delete config.profiles[name];
  config.activeProfile = 'Default';
  saveConfig();
  if (shimProc) reopenOverlays();
  return true;
});
ipcMain.handle('open-layout', () => { openLayoutEditor(); return true; });

// ── Wheel calibration window ───────────────────────────────────────────────
let calibrateWindow = null;

function openCalibrateWindow() {
  if (calibrateWindow && !calibrateWindow.isDestroyed()) {
    calibrateWindow.focus();
    return;
  }
  calibrateWindow = new BrowserWindow({
    width:     960,
    height:    680,
    minWidth:  860,
    minHeight: 580,
    resizable: true,
    title:     'Wheel Calibration — All In One NR2003',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  calibrateWindow.setMenuBarVisibility(false);
  calibrateWindow.loadFile('calibrate.html');
  calibrateWindow.on('closed', () => { calibrateWindow = null; });
}


// ── Season tracking ────────────────────────────────────────────────────────
// Points system (AutoStages 2026 scoring) + season-long standings. Reads the
// same bridge telemetry as the overlays; stage cautions stay with Stage Racing /
// Better Cautions above.
let seasonService = null;
let seasonWindow  = null;

function startSeasonService() {
  if (seasonService) return;
  try {
    seasonService = new SeasonService({
      userData:   USER_DATA,
      appDir:     APP_DIR,
      getConfig:  () => config,
      saveConfig: () => saveConfig(),
      log:        (m) => console.log(m),
      mapFrame:   (d) => (stageFeed ? stageFeed.mapFrame(d) : d),        // stage results as they really happened (a caution can end a stage early)
      // AIMOD's racing intensity & rivals: rivalries carry on through a season (saved with each counted race, handed back for the next)
      memory:          (() => { const exePath = () => config.nr2003_exe || ''; return new Win32Memory(() => gameExe.names(config), exePath); })(),   // incidents / damage
      // RaceLab running its allies / rivals in this race: its rivalries among this race's cars instead (run-ins = its contact / spin / wreck / block events)
      getRaceRivals:   () => { try { if (raceLab.ownedRelationshipsRecently()) { const cars = rlCars(); if (cars.length) return raceLab.raceRivals(cars); } } catch (e) { /* AIMOD's */ } return aimod ? aimod.raceRivals() : []; },
      nrDir:           () => (config.nr2003_exe ? path.dirname(config.nr2003_exe) : ''),
      // rookies: the overlay series' rookies.json (car number -> true), as the broadcast graphics mark them
      rookies:         () => { try { const j = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, config.series || 'default', 'rookies.json'), 'utf8')); return new Set(Object.keys(j).filter(k => j[k]).map(k => String(parseInt(k, 10)))); } catch (e) { return null; } },
      applyRace:       (race, setDistance) => applyRaceSetup(race, setDistance),
      setSeasonRivals: (list) => { if (aimod) aimod.setSeasonRivals(list); },
    });
    seasonService.registerIpc({
      ipcMain, dialog, shell,
      getParentWindow: () => (seasonWindow && !seasonWindow.isDestroyed()) ? seasonWindow : mainWindow,
    });
    seasonService.start();
  } catch (e) {
    console.error('[season] failed to start:', e);
    seasonService = null;
  }
}

function openSeasonWindow() {
  if (seasonWindow && !seasonWindow.isDestroyed()) { seasonWindow.focus(); return; }
  seasonWindow = new BrowserWindow({
    width:     1180,
    height:    780,
    minWidth:  900,
    minHeight: 560,
    title:     'Season Manager — All In One NR2003',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  seasonWindow.setMenuBarVisibility(false);
  seasonWindow.loadFile('season.html', { query: { port: String((config.season && config.season.port) || 8769) } });
  seasonWindow.on('closed', () => { seasonWindow = null; });
}
ipcMain.handle('open-season-window', () => { openSeasonWindow(); return true; });

let raceControl = null;
let qualBoxWin = null, rcGfxWin = null, playerOverlayWin = null;
function startRaceControl() {
  if (raceControl) return;
  try {
    raceControl = new RaceControlService({
      userData: USER_DATA, getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      externalRunning: () => ext.runningNames(undefined, Date.now(), 4000).has('racecontrol.exe'),   // the standalone exe: never run both
      getExtraGfx: () => (aimod ? aimod.gfxExtra() : null),            // AIMOD's pit board rides on the same graphics window and web pages
      // RaceControl 2.0 "Overlays drawn by": a board with a layout picked in the built-in RaceVision is drawn from that layout, not here
      drawnByLayouts: () => (director && director.layouts ? director.layouts.rcDrawnHere() : null),
      getGuaranteed: () => (seasonService ? seasonService.guaranteedNow() : null),  // season mode: guaranteed starters are never cut in qualifying
    });
    raceControl.registerIpc({ ipcMain });
    raceControl.start();
    // the qualifying timing box over the game (RaceControl 1.1.0)
    qualBoxWin = new QualBoxWindow({
      BrowserWindow, screen, ipcMain, getService: () => raceControl, log: (m) => console.log(m),
      saveLayout: (l) => raceControl.setConfig({ QualBox: l }),
    });
    qualBoxWin.start();
    // the player's banner, ready card and the broadcast panel (RaceControl 1.2.0)
    playerOverlayWin = new PlayerOverlayWindow({ BrowserWindow, screen, ipcMain, getService: () => raceControl, log: (m) => console.log(m) });
    playerOverlayWin.start();
    // the choose cone board and caution panel over the game
    rcGfxWin = new RcGfxWindow({ BrowserWindow, screen, ipcMain, getService: () => raceControl, log: (m) => console.log(m) });
    rcGfxWin.start();
  } catch (e) { console.error('[racecontrol] failed to start:', e); raceControl = null; }
}

// RaceVision (TV director): All In One NR2003 runs it from an MPH-fixed copy, shows its remote page in a window and adds extra options on top
let raceVision = null;
function startRaceVision() {
  if (raceVision) return;
  try {
    raceVision = new RaceVisionService({
      getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      getStageEnds: () => (stageFeed ? stageFeed.stageEnds() : null),
    });
    raceVision.registerIpc({ ipcMain, shell });
    raceVision.start();
  } catch (e) { console.error('[racevision] failed to start:', e); raceVision = null; }
}
let rvWindow = null;
function openRaceVisionWindow() {
  if (rvWindow && !rvWindow.isDestroyed()) { rvWindow.focus(); return; }
  rvWindow = new BrowserWindow({
    width: 1180, height: 860, minWidth: 900, minHeight: 600,
    title: 'RaceVision — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  rvWindow.setMenuBarVisibility(false);
  rvWindow.loadFile('racevision.html');
  rvWindow.on('closed', () => { rvWindow = null; });
}
ipcMain.handle('open-racevision-window', () => { openRaceVisionWindow(); return true; });

let qualWindow = null;
function openQualWindow() {
  if (qualWindow && !qualWindow.isDestroyed()) { qualWindow.focus(); return; }
  qualWindow = new BrowserWindow({
    width: 1000, height: 820, minWidth: 820, minHeight: 560,
    title: 'Qualifying — RaceControl — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  qualWindow.setMenuBarVisibility(false);
  qualWindow.loadFile('qualifying.html');
  qualWindow.on('closed', () => { qualWindow = null; });
}
ipcMain.handle('open-qual-window', () => { openQualWindow(); return true; });
// RaceControl (Nov 2026)'s track map: the track from above, drawn from the AI cars; click to put the cone there
let trackMapWindow = null;
function openTrackMapWindow() {
  if (trackMapWindow && !trackMapWindow.isDestroyed()) { trackMapWindow.focus(); return; }
  trackMapWindow = new BrowserWindow({
    width: 820, height: 640, minWidth: 480, minHeight: 360,
    title: 'Track map — RaceControl — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  trackMapWindow.setMenuBarVisibility(false);
  trackMapWindow.loadFile('trackmap.html');
  trackMapWindow.on('closed', () => { trackMapWindow = null; });
}
ipcMain.handle('open-trackmap-window', () => { openTrackMapWindow(); return true; });
ipcMain.handle('qual-place-box', () => {
  if (raceControl && raceControl.cfg().QualStyle === 'broadcast') { if (playerOverlayWin) playerOverlayWin.place('broad'); }
  else if (qualBoxWin) qualBoxWin.place();
  return true;
});
ipcMain.handle('qual-place-banner', () => { if (playerOverlayWin) playerOverlayWin.place('banner'); return true; });

// AIMOD v2.2 pit strategy, crew chief brain and driver behavior, built in (runs AIMOD's modules on All In One NR2003's Python VM)
let aimod = null, radioVoice = null;
function startAimod() {
  if (aimod) return;
  try {
    radioVoice = new RadioVoiceWindow({ BrowserWindow, ipcMain, getRadioConfig: () => { try { return aimod ? aimod.radioConfig() : {}; } catch (e) { return {}; } },
      onSubtitle: (info) => { if (aimod) aimod.setSubtitle(info); } });          // AIMOD 2.2's subtitle box, drawn by the graphics window
    aimod = new AimodService({
      raceLabOwns: () => raceLabOwns('relationships'),        // RaceLab's allies / rivals drive the AI: racing intensity & rivals stand aside
      raceLabCard: () => raceLabCard(),                        // ... and the rivals card shows RaceLab's rival (else trusted ally) next to the car on TV
      onSpeech: (msgs) => radioVoice && radioVoice.say(msgs),
      userData: USER_DATA, getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      rcLogFile: path.join(USER_DATA, 'race_control.log'),
      getRcLogFile: () => {
        if (ext.runningNames(undefined, Date.now(), 4000).has('racecontrol.exe')) {
          const exe = ext.findExe('raceControl', config);
          if (exe) return path.join(path.dirname(exe), 'race_control.log');
        }
        return path.join(USER_DATA, 'race_control.log');
      },
      mapStageEnds: (ends) => (raceControl ? raceControl.applyEarlyStages(ends) : ends),     // stages a caution already ended early                       // the built-in RaceControl's wave-around / free-pass log
      externalRunning: () => ext.runningNames(undefined, Date.now(), 4000).has('aimod.exe'),   // the standalone exe: never run both
      importDir: () => {
        const selected = config.extMods && config.extMods.aimod && config.extMods.aimod.exe;
        const exe = selected && fs.existsSync(selected) ? selected : ext.MODS.aimod.bundled;
        return exe ? path.dirname(exe) : '';
      },
      getPitLaneState: () => aie ? aie.getPitLaneState() : null,
      getTeamRows: () => aie ? aie.getTeamRows() : [],
    });
    aimod.registerIpc({ ipcMain });
    aimod.start();
  } catch (e) { console.error('[aimod] failed to start:', e); aimod = null; }
}

// Stage display: All In One NR2003 works the stage state out itself (app/stages) and gives it to the overlays and the season
// tracker, because the compiled bridge plans the stage ends once per race and never notices a stage a caution ended early.
let stageFeed = null;
function startStageFeed() {
  if (stageFeed) return;
  try {
    stageFeed = new StageFeed({
      getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      applyEarly: (ends) => (raceControl ? raceControl.applyEarlyStages(ends) : ends),     // stages RaceControl already ended early
      rcEarly: () => !!(raceControl && raceControl.earlyActive()),
      port: config.stageFeedPort || 8772,
    });
    stageFeed.start();
  } catch (e) { console.error('[stages] failed to start:', e); stageFeed = null; }
}
ipcMain.handle('get-stage-guard', () => (stageFeed ? stageFeed.cfg() : { enabled: false, laps: 5 }));
ipcMain.handle('set-stage-guard', (e, p) => (stageFeed ? stageFeed.setGuard(p) : null));
// "Stages off": no stage cautions, no stage points, no stage display — everything that follows the stage plan stands down.
ipcMain.handle('set-stages-off', (e, off) => {
  const sr = config.stageRacing = config.stageRacing || { enabled: false, numStages: 0, inputMode: 'percent', percentages: [], laps: [] };
  sr.stagesOff = !!off;
  sr.enabled = !sr.stagesOff && !!(stageRaceWindow && !stageRaceWindow.isDestroyed());      // back on = on again while the Stage Racing window is open
  saveConfig();
  mainWindow?.webContents.send('stage-race-status', sr.enabled);
  return { stagesOff: sr.stagesOff, enabled: sr.enabled };
});

let aiService = null;
let aiWindow  = null;

function startAiService() {
  if (aiService) return;
  try {
    aiService = new AIService({
      userData:   USER_DATA,
      getConfig:  () => config,
      saveConfig: () => saveConfig(),
      log:        (m) => console.log(m),
    });
    aiService.registerIpc({
      ipcMain, dialog, shell,
      getParentWindow: () => (aiWindow && !aiWindow.isDestroyed()) ? aiWindow : mainWindow,
    });
    aiService.start();
  } catch (e) {
    console.error('[ai] failed to start:', e);
    aiService = null;
  }
}

function openAiWindow() {
  if (aiWindow && !aiWindow.isDestroyed()) { aiWindow.focus(); return; }
  aiWindow = new BrowserWindow({
    width:     1240,
    height:    860,
    minWidth:  980,
    minHeight: 600,
    title:     'AI Tweaks & AIMOD — All In One NR2003',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  aiWindow.setMenuBarVisibility(false);
  aiWindow.loadFile('ai.html');
  aiWindow.on('closed', () => { aiWindow = null; });
}
ipcMain.handle('open-ai-window', () => { openAiWindow(); return true; });

let aimodWindow = null;
// RaceLab (NR2003 Race Lab beta): launched with the game, its settings edited here, All In One NR2003's overlapping AI writers stand aside while it runs
const { RaceLabService } = require('./racelab');
const raceLabRel = require('./racelab/relations');
const { readField: readDirectorField } = require('./director/field');
// RaceLab included with the app: the original RaceLab zip in <install>\RaceLab (unpacked into the NR2003 folder from the RaceLab page)
const bundledRaceLabZip = () => { try { const d = path.join(INSTALL_DIR, 'RaceLab'); const z = fs.readdirSync(d).filter(n => /\.zip$/i.test(n) && /racelab/i.test(n)).sort().pop(); return z ? path.join(d, z) : ''; } catch (e) { return ''; } };
const raceLab = new RaceLabService({ getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m), gameRunning: () => nr2003Running || isNR2003Running(), bundledZip: bundledRaceLabZip });
const raceLabOwns = (what) => { try { return raceLab.owns(what); } catch (e) { return false; } };
// RaceLab's allies / rivals reach All In One NR2003 like AIMOD's racing intensity & rivals do (racelab/relations.js): the TV director, the
// battle label and story line, the rivals card, and the Season Tracker. They need the field: numbers, driver names (RaceLab's driver ids
// are the names) and positions - the TV director's when it runs, else read here.
let rlFieldMem = null, rlFieldAt = 0, rlFieldCache = null;
function rlField() {
  if (director && director.attached && director.field && Date.now() - (director._fieldAt || 0) < 3000) return director.field;
  const now = Date.now();
  if (now - rlFieldAt < 400) return rlFieldCache;
  rlFieldAt = now;
  try {
    if (!rlFieldMem) rlFieldMem = new Win32Memory(() => gameExe.names(config), () => config.nr2003_exe || '');
    rlFieldCache = rlFieldMem.attach() ? readDirectorField(rlFieldMem, 0) : null;
  } catch (e) { rlFieldCache = null; }
  return rlFieldCache;
}
const rlCars = () => { const f = rlField(); return f && f.cars ? f.cars.filter(c => !c.pace) : []; };
const rlRelations = () => { try { return raceLabOwns('relationships') ? raceLab.relationsFor(rlCars()) : null; } catch (e) { return null; } };
// the car on TV: the observed-car reader's slot, else the TV director's
function rlTvSlot() {
  if (camCar >= 0) return camCar;
  try { const c = director && director.dir && director.dir.cur; if (c && c.slot >= 0) return c.slot; return director && director.cam ? director.cam.focusSlot() : -1; } catch (e) { return -1; }
}
function raceLabCard() {
  const r = rlRelations();
  if (!r) return null;
  const f = rlField();
  return f ? raceLabRel.onScreen(r, f.cars, rlTvSlot()) : null;
}
// NR2003 Dynamic Rubber (app/rubber): the community add-on installed, switched and undone from here
const { RubberService } = require('./rubber');
const rubber = new RubberService({ getConfig: () => config, appDir: __dirname, log: (m) => console.log(m), gameRunning: () => nr2003Running || isNR2003Running() });
rubber.registerIpc({ ipcMain });
let rubberWindow = null;
function openRubberWindow() {
  if (rubberWindow && !rubberWindow.isDestroyed()) { rubberWindow.focus(); return; }
  rubberWindow = new BrowserWindow({
    width: 760, height: 820, minWidth: 600, minHeight: 520, title: 'Dynamic Rubber — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  rubberWindow.setMenuBarVisibility(false);
  rubberWindow.loadFile('rubber.html');
  rubberWindow.on('closed', () => { rubberWindow = null; });
}
ipcMain.handle('open-rubber-window', () => { openRubberWindow(); return true; });
let raceLabWindow = null;
function openRaceLabWindow() {
  if (raceLabWindow && !raceLabWindow.isDestroyed()) { raceLabWindow.focus(); return; }
  raceLabWindow = new BrowserWindow({
    width: 1060, height: 860, minWidth: 780, minHeight: 560, title: 'RaceLab — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  raceLabWindow.setMenuBarVisibility(false);
  raceLabWindow.loadFile('racelab.html');
  raceLabWindow.on('closed', () => { raceLabWindow = null; });
}
ipcMain.handle('open-racelab-window', () => { openRaceLabWindow(); return true; });
ipcMain.handle('racelab:state', () => raceLab.state());
ipcMain.handle('racelab:set', (e, p) => raceLab.set(p));
ipcMain.handle('racelab:set-tuning', (e, m) => raceLab.setTuning(m));
ipcMain.handle('racelab:enable', (e, on) => raceLab.setEnabled(on));
ipcMain.handle('racelab:game-exe', (e, name) => raceLab.setGameExe(name));
ipcMain.handle('racelab:renderer-switch', () => raceLab.switchRenderer());
ipcMain.handle('racelab:renderer-restore', () => raceLab.restoreRenderer());
ipcMain.handle('racelab:renderer-pick', async () => {
  const r = await dialog.showOpenDialog(raceLabWindow || mainWindow, { title: 'Pick RaceLab\'s rend_dxg.dll for the chosen game EXE', properties: ['openFile'], filters: [{ name: 'Renderer', extensions: ['dll'] }] });
  if (r.canceled || !r.filePaths[0]) return { ok: false, text: '' };
  return raceLab.switchRenderer(r.filePaths[0]);
});
ipcMain.handle('racelab:check', () => raceLab.check());
ipcMain.handle('racelab:install-bundled', () => raceLab.installBundled());
ipcMain.handle('racelab:install-assets', () => raceLab.installAssets());
ipcMain.handle('racelab:open-launcher', () => raceLab.openLauncher());
ipcMain.handle('racelab:log', () => raceLab.logTail(120));
ipcMain.handle('racelab:open-file', (e, which) => { const d = raceLab.dir(); if (!d) return false; const f = { ini: 'SpinMod.ini', log: 'SpinMod.log', folder: '' }[which]; if (f === undefined) return false; shell.openPath(path.join(d, f)); return true; });
ipcMain.handle('racelab:browse', async () => {
  const r = await dialog.showOpenDialog(raceLabWindow || mainWindow, { title: 'Pick RaceLab\'s folder (the one with SpinModLauncher.exe)', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return raceLab.state();
  return raceLab.setDir(r.filePaths[0]);
});

function openAimodWindow() {
  if (aimodWindow && !aimodWindow.isDestroyed()) { aimodWindow.focus(); return; }
  aimodWindow = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1000, minHeight: 600,
    title: 'AIMOD Pit Strategy — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  aimodWindow.setMenuBarVisibility(false);
  aimodWindow.loadFile('aimod.html');
  aimodWindow.on('closed', () => { aimodWindow = null; });
}
ipcMain.handle('open-aimod-window', () => { openAimodWindow(); return true; });

// RaceVision's TV director, built in (no RaceVision.exe): who is on TV and which camera shows them
let director = null;
function startDirector() {
  if (director) return;
  try {
    director = new DirectorService({
      userData: USER_DATA, getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      externalRunning: () => { const n = ext.runningNames(undefined, Date.now(), 4000); return n.has('racevision.exe') || n.has('racevision_mphfix.exe'); },   // never drive the camera twice
      onOverlay: (o) => tvOverlaySend(o), seriesDirs: () => [SERIES_DIR],
      // RaceVision 2.0 overlay layouts: the editor's previews (a hidden window draws them), Race Control's overlay feed (rc.*), the race
      // length, the fonts layouts may use (All In One NR2003's own and the font pack), the art roots for art:images/... pictures
      layoutRender: (layout, job) => renderLayout(layout, job),
      rcFeed: () => (raceControl && raceControl.overlayFeed ? raceControl.overlayFeed() : null),
      raceInfo: () => { const e = raceControl && raceControl.engine; if (!e) return null; const n = e.RaceLengthLaps; return { lapsTotal: n > 0 ? n : 0, session: e.InRace ? 'race' : '' }; },
      fontDirs: () => [path.join(INSTALL_DIR, 'fonts'), path.join(USER_DATA, 'fonts')],
      artRoots: () => [USER_DATA, INSTALL_DIR],
      wipe: (o) => runWipe(o), hideOverlays: (on, o) => hideOtherOverlays(on, o),          // RaceVision 1.2.0: the replay wipe, other overlays out of the way
      coneFor: () => (raceControl && raceControl.coneState ? raceControl.coneState() : null),   // the choose cone (dynamic cameras at the cone)
      logFile: path.join(USER_DATA, 'tv.log'),
      qualDrive: () => !!(raceControl && raceControl.qual && raceControl.qual.DriveCar === 0),
      gamePositions: () => (seasonService ? seasonService.gamePositions() : null),       // the game's running order for places gained / lost      // your own qualifying run: the TV goes to your cockpit
      // rivalries for the TV: AIMOD's of this race (they include the season's when the race counts), else the active season's
      rivals: () => { const rl = rlRelations(); if (rl) return rl.rivals; const live = aimod ? aimod.feudsNow() : []; if (live && live.length) return live; return seasonService ? seasonService.seasonRivalsList() : []; },
      allies: () => { const rl = rlRelations(); return rl ? rl.allies.filter(a => a.trusted) : []; },   // RaceLab's trusted allies: the battle label and story line
      presets: () => { const out = {}, dir = path.join(__dirname, 'director', 'presets'); try { for (const f of fs.readdirSync(dir)) if (/.ini$/i.test(f)) out[f.replace(/.ini$/i, '')] = fs.readFileSync(path.join(dir, f), 'latin1'); } catch (e) { /* none */ } return out; },
    });
    director.registerIpc({ ipcMain, shell });
    director.start();
    // Ctrl+F7: pause the race and show the replay of the crash most worth it (while you drive: pause, replay, resume)
    try { globalShortcut.register('CommandOrControl+F7', () => { if (director) director.replayNow(); }); } catch (e) { /* taken by another app */ }
  } catch (e) { console.error('[tv] failed to start:', e); director = null; }
}
// RaceVision 2.0: the overlay editor's previews. A hidden window (layoutrender.html) draws one layout with director/layoutdraw.js and
// hands back a PNG; it is made on the first preview and closed after a minute without one.
let layoutRenderWin = null, layoutRenderReady = null, layoutRenderIdle = null;
function renderLayout(layout, job) {
  if (!layoutRenderWin || layoutRenderWin.isDestroyed()) {
    layoutRenderWin = new BrowserWindow({ show: false, width: 400, height: 300, skipTaskbar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: false, backgroundThrottling: false } });
    layoutRenderReady = layoutRenderWin.loadFile('layoutrender.html');
    layoutRenderWin.on('closed', () => { layoutRenderWin = null; layoutRenderReady = null; });
  }
  clearTimeout(layoutRenderIdle);
  layoutRenderIdle = setTimeout(() => { try { if (layoutRenderWin && !layoutRenderWin.isDestroyed()) layoutRenderWin.close(); } catch (e) { /* gone */ } }, 60000);
  const w = layoutRenderWin;
  const data = JSON.stringify(Object.assign({ layout }, job || {}));
  return Promise.resolve(layoutRenderReady)
    .then(() => Promise.race([w.webContents.executeJavaScript('window.RVRender(' + data + ')', true), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 8000))]))
    .then((url) => { const m = /^data:image\/png;base64,(.*)$/.exec(String(url || '')); return m ? Buffer.from(m[1], 'base64') : null; });
}
// the broadcast graphics: one transparent click-through window over the game, drawn by tvoverlay.html
let tvOverlayWin = null, tvOverlayReady = false, tvOverlayLast = null;
function tvOverlaySend(o) {
  const want = !!(o && o.on);
  if (want && !tvOverlayWin) {
    try {
      const b = screen.getPrimaryDisplay().bounds;
      tvOverlayWin = new BrowserWindow({
        x: b.x, y: b.y, width: b.width, height: b.height, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false, show: false, hasShadow: false,
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
      });
      tvOverlayWin.setAlwaysOnTop(true, 'screen-saver'); tvOverlayWin.setIgnoreMouseEvents(true);
      tvOverlayReady = false;
      tvOverlayWin.loadFile('tvoverlay.html');
      tvOverlayWin.webContents.once('did-finish-load', () => { tvOverlayReady = true; if (tvOverlayWin && !tvOverlayWin.isDestroyed()) tvOverlayWin.showInactive(); });
      tvOverlayWin.on('closed', () => { tvOverlayWin = null; tvOverlayReady = false; });
    } catch (e) { tvOverlayWin = null; }
  }
  if (tvOverlayWin && !tvOverlayWin.isDestroyed() && tvOverlayReady) {
    const key = JSON.stringify(o);
    if (key !== tvOverlayLast) { tvOverlayLast = key; tvOverlayWin.webContents.send('tvoverlay:data', o); }
    if (!want && !(o.crowd && o.crowd.length)) { tvOverlayWin.close(); }
  }
}
// the replay wipe (RaceVision 1.2.0): a full-screen TV wipe drawn by wipe.html - bars sweep across, REPLAY / LIVE slams in, the bars leave.
// runWipe resolves once the screen is covered (the director makes its cut then) with the function that lets the wipe leave.
let wipeWin = null, wipeLoaded = null, wipeSeq = 0;
const wipeCovered = new Map();
function wipeWindow() {
  if (wipeWin && !wipeWin.isDestroyed()) return;
  const b = screen.getPrimaryDisplay().bounds;
  wipeWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, focusable: false, show: false, hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  wipeWin.setAlwaysOnTop(true, 'screen-saver'); wipeWin.setIgnoreMouseEvents(true);
  wipeLoaded = new Promise(res => wipeWin.webContents.once('did-finish-load', res));
  wipeWin.loadFile('wipe.html');
  wipeWin.on('closed', () => { wipeWin = null; wipeLoaded = null; });
}
async function runWipe(o) {
  wipeWindow();
  await Promise.race([wipeLoaded, new Promise(r => setTimeout(r, 3000))]);
  if (!wipeWin || wipeWin.isDestroyed()) return null;
  const id = ++wipeSeq;
  const covered = new Promise(res => wipeCovered.set(id, res));
  try { wipeWin.showInactive(); wipeWin.moveTop(); } catch (e) { /* ignore */ }
  wipeWin.webContents.send('wipe:go', Object.assign({ id }, o));
  await Promise.race([covered, new Promise(r => setTimeout(r, (o.ms || 1500) * 0.5 + 1200))]);
  wipeCovered.delete(id);
  return () => { if (wipeWin && !wipeWin.isDestroyed()) wipeWin.webContents.send('wipe:release', id); };
}
ipcMain.on('wipe:covered', (e, id) => { const r = wipeCovered.get(id); if (r) r(); });
ipcMain.on('wipe:done', () => { try { if (wipeWin && !wipeWin.isDestroyed()) wipeWin.hide(); } catch (e) { /* ignore */ } });
// hide_companion_overlays: All In One NR2003's own broadcast widgets (the companion app's overlays) and other programs' topmost overlay windows
// stay out of sight during a replay; RaceVision's own graphics (the TV overlay) and the wipe stay
let othersHidden = null, othersGuard = null, otherApps = null;
function hideOtherOverlays(on, o) {
  if (!otherApps) { try { otherApps = new (require('./director/others').OtherOverlays)((m) => console.log('[tv] ' + m)); } catch (e) { otherApps = null; } }
  if (on) {
    if (!othersHidden) othersHidden = new Set();
    const sweep = () => { for (const w of Object.values(overlayWindows)) { try { if (w && !w.isDestroyed() && w.isVisible()) { w.hide(); othersHidden.add(w); } } catch (e) { /* gone */ } } };
    sweep();
    if (!othersGuard) othersGuard = setInterval(sweep, 300);         // a widget that shows itself again (or a new one) goes away again
    let n = othersHidden.size;
    try { if (otherApps) n += otherApps.hide(o || {}); } catch (e) { /* user32 not there */ }
    return n;
  }
  if (othersGuard) { clearInterval(othersGuard); othersGuard = null; }
  let n = 0;
  if (othersHidden) { for (const w of othersHidden) { try { if (!w.isDestroyed()) { w.showInactive(); w.setAlwaysOnTop(true, 'screen-saver'); w.moveTop(); n++; } } catch (e) { /* gone */ } } othersHidden = null; }
  try { if (otherApps) n += otherApps.show(); } catch (e) { /* ignore */ }
  return n;
}
ipcMain.handle('tvoverlay:sounds', (e, kind) => {
  try {
    const cfg = (config.director && config.director.settings && config.director.settings.crowd_folder) || 'sounds\\crowd';
    const dir = path.isAbsolute(cfg) ? cfg : path.join(USER_DATA, 'tv', cfg);
    return fs.readdirSync(dir).filter(f => /\.(wav|mp3|ogg)$/i.test(f) && f.toLowerCase().startsWith(kind + '_')).map(f => 'file:///' + path.join(dir, f).replace(/\\/g, '/'));
  } catch (err) { return []; }
});
let tvWindow = null;
function openTvWindow() {
  if (tvWindow && !tvWindow.isDestroyed()) { tvWindow.focus(); return; }
  tvWindow = new BrowserWindow({
    width: 1120, height: 900, minWidth: 860, minHeight: 600,
    title: 'RaceVision (TV director) — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  tvWindow.setMenuBarVisibility(false);
  tvWindow.loadFile('director.html');
  tvWindow.on('closed', () => { tvWindow = null; });
}
ipcMain.handle('open-tv-window', () => { openTvWindow(); return true; });

// AI Enhanced's Environment tab (grip + rubber build-up), random rubber and per-track presets, built in
let aie = null;
function startAie() {
  if (aie) return;
  try {
    aie = new AiEnhancedService({
      raceLabOwns: () => raceLabOwns('lines'),                // RaceLab's racing lines: tandem / MultiGroove and our race line stand aside
      userData: USER_DATA, getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      externalRunning: () => { for (const n of ext.runningNames(undefined, Date.now(), 4000)) if (/^ai enhanced.*\.exe$/.test(n)) return true; return false; },   // never run both
      runningNames: () => ext.runningNames(undefined, Date.now(), 4000),
      getPitLanePlan: () => aimod ? aimod.getPitLanePlan() : null,
    });
    aie.registerIpc({ ipcMain, dialog });
    aie.start();
  } catch (e) { console.error('[aie] failed to start:', e); aie = null; }
}
function startWindTunnelControl() {
  if (windTunnelControl) return;
  try {
    windTunnelControl = new WindTunnelControl({ userData: USER_DATA, getConfig: () => config,
      guiRunning: () => ext.runningNames(undefined, Date.now(), 4000).has('windtunnelfornr.exe') });
    windTunnelControl.start();
  } catch (e) { console.error('[windtunnel] control bridge failed:', e); windTunnelControl = null; }
}
// Superspeedway Lines: the AI held in grooves built from the game's own race line at Daytona / Talladega (replaces Superspeedway Line Control.exe)
// Superspeedway Lines is not part of All In One NR2003
// one car per driver: keeps the AI roster free of drivers that appear twice
let field = null;
function startField() {
  if (field) return;
  try {
    field = new FieldService({
      userData: USER_DATA, getConfig: () => config, saveConfig: () => saveConfig(), log: (m) => console.log(m),
      nrDir: () => (config.nr2003_exe ? path.dirname(config.nr2003_exe) : ''), playerFolder: () => config.playerFolder || '',
      guaranteed: () => (seasonService ? seasonService.guaranteedNow() : null),     // season mode: top N owners / chartered cars stay in the pool
    });
    field.registerIpc({ ipcMain });
    field.start();
  } catch (e) { console.error('[field] failed to start:', e); field = null; }
}
let aieWindow = null;
function openAieWindow() {
  if (aieWindow && !aieWindow.isDestroyed()) { aieWindow.focus(); return; }
  aieWindow = new BrowserWindow({
    width: 520, height: 260, minWidth: 420, minHeight: 220, resizable: false,
    title: 'AI Enhanced — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false },
  });
  aieWindow.setMenuBarVisibility(false);
  aieWindow.loadFile('aie.html');
  aieWindow.on('closed', () => { aieWindow = null; });
}
ipcMain.handle('open-aie-window', () => { openAieWindow(); return true; });
// AI Enhanced in All In One NR2003 = the original AI Enhanced v0_2_2b.exe, shipped with the app and started with it when chosen. It runs from a
// copy in the settings folder (it writes its presets next to itself), with the app's administrator rights (it reads NR2003's memory).
const AIE_EXE = 'AI Enhanced v0_2_2b.exe';
const aieRunning = () => ext.runningNames(undefined, Date.now(), 2000).has(AIE_EXE.toLowerCase());
function aieExePath() {
  const src = path.join(__dirname, 'beta', 'ai-enhanced', AIE_EXE), dir = path.join(USER_DATA, 'ai-enhanced'), dst = path.join(dir, AIE_EXE);
  try {
    // compared by content: the RaceLab-aware build is the same size as the original
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size || !fs.readFileSync(dst).equals(fs.readFileSync(src))) { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(src, dst); }
    return dst;
  } catch (e) { console.error('[aie] could not prepare AI Enhanced:', e.message); return fs.existsSync(src) ? src : ''; }
}
// AI Enhanced processes, whether each has a window (tasklist /V: "N/A" = none) and whether Windows sees it hung ("Not Responding"). One
// left behind by an earlier session hung (or windowless) is useless, and made the app think AI Enhanced was already up.
function aieProcs() {
  try {
    const out = execSync(`tasklist /V /FO CSV /NH /FI "IMAGENAME eq ${AIE_EXE}"`, { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    return String(out).split(/\r?\n/).map(l => l.match(/"([^"]*)"/g)).filter(c => c && c.length >= 9 && c[0].toLowerCase() === '"' + AIE_EXE.toLowerCase() + '"')
      .map(c => ({ pid: Number(c[1].replace(/\D/g, '')), window: !/^"N\/A"$/i.test(c[c.length - 1]) && c[c.length - 1] !== '""', hung: /not responding/i.test(c[5]) }));
  } catch (e) { return []; }
}
let aieChild = null, aieStartedAt = 0;      // the AI Enhanced this app started (closed again when the app quits)
function launchAiEnhanced() {
  const procs = aieProcs();
  if (procs.some(p => p.window && !p.hung)) return { ok: true, already: true };
  // running but hung or windowless: a leftover (unless it is the one just started, still opening its window) - close it, start a fresh one
  if (procs.length && Date.now() - aieStartedAt < 20000) return { ok: true, already: true };
  for (const p of procs) { try { process.kill(p.pid); console.log('[aie] closed an AI Enhanced that was ' + (p.hung ? 'not responding' : 'running with no window') + ' (pid ' + p.pid + ')'); } catch (e) { /* gone */ } }
  const exe = aieExePath();
  if (!exe) return { ok: false, error: 'AI Enhanced is missing from this install.' };
  // AIE_GAME_EXE: the game's exe name (RaceLab's builds keep theirs, e.g. NR2003_MS.exe); this AI Enhanced build looks for that name
  const game = path.basename(gameExe.launchExe(config) || 'NR2003.exe');
  try {
    aieChild = spawn(exe, [], { cwd: path.dirname(exe), detached: true, stdio: 'ignore', env: Object.assign({}, process.env, { AIE_GAME_EXE: game }) });
    aieChild.on('exit', () => { aieChild = null; });
    aieChild.unref(); aieStartedAt = Date.now();
    console.log('[aie] started', exe, 'for', game); return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
ipcMain.handle('aie-launch:get', () => ({ onStart: !!(config.aieLaunch && config.aieLaunch.onStart), running: aieRunning() }));
ipcMain.handle('aie-launch:set', (e, on) => { config.aieLaunch = { onStart: !!on }; saveConfig(); return { onStart: !!on, running: aieRunning() }; });
let aieEditorWindow = null;
function openAieEditorWindow() {
  if (aieEditorWindow && !aieEditorWindow.isDestroyed()) { aieEditorWindow.focus(); return; }
  // AI Enhanced's Lap File Editor window: 900 wide, as tall as the screen less 80 (at least 400)
  const edH = Math.max(400, ((require('electron').screen.getPrimaryDisplay().workAreaSize || {}).height || 900) - 80);
  aieEditorWindow = new BrowserWindow({ width: 900, height: edH, minWidth: 420, minHeight: 400, title: 'Lap File Editor', backgroundColor: '#505050',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false } });
  aieEditorWindow.setMenuBarVisibility(false); aieEditorWindow.loadFile('aieeditor.html');
  aieEditorWindow.on('closed', () => { aieEditorWindow = null; });
}
ipcMain.handle('open-aie-editor', () => { openAieEditorWindow(); return true; });
let windTunnelStudioWindow = null;
function openWindTunnelStudio() {
  if (windTunnelStudioWindow && !windTunnelStudioWindow.isDestroyed()) { windTunnelStudioWindow.focus(); return; }
  windTunnelStudioWindow = new BrowserWindow({ width: 1160, height: 850, minWidth: 900, minHeight: 640, title: 'Wind Tunnel Studio — All In One NR2003',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, preload: path.join(__dirname, 'preload.js'), webSecurity: false } });
  windTunnelStudioWindow.setMenuBarVisibility(false); windTunnelStudioWindow.loadFile('windtunnel.html');
  windTunnelStudioWindow.on('closed', () => { windTunnelStudioWindow = null; });
}
ipcMain.handle('open-wind-tunnel-studio', () => { openWindTunnelStudio(); return true; });
ipcMain.handle('wtc:get-state', () => windTunnelControl ? windTunnelControl.tick() : { connected: false, message: 'Wind Tunnel controls are not initialized.' });
ipcMain.handle('wtc:set-settings', (e, p) => windTunnelControl ? windTunnelControl.setSettings(p) : { connected: false, message: 'Wind Tunnel controls are not initialized.' });
ipcMain.handle('wts:load-sequence', async () => {
  const r = await dialog.showOpenDialog({ title: 'Load Wind Tunnel Director sequence', filters: [{ name: 'Wind Tunnel Director sequence', extensions: ['wtdc'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return Wtdc.parse(fs.readFileSync(r.filePaths[0], 'ascii'));
});
ipcMain.handle('wts:save-sequence', async (e, sequence) => {
  const text = Wtdc.serialize(sequence);
  const r = await dialog.showSaveDialog({ title: 'Save Wind Tunnel Director sequence', defaultPath: path.join(app.getPath('documents'), 'Sequence.wtdc'), filters: [{ name: 'Wind Tunnel Director sequence', extensions: ['wtdc'] }] });
  if (r.canceled || !r.filePath) return false;
  const file = path.extname(r.filePath) ? r.filePath : r.filePath + '.wtdc'; fs.writeFileSync(file, text, 'ascii'); return { ok: true, file };
});
ipcMain.handle('wts:load-pro', async () => {
  const r = await dialog.showOpenDialog({ title: 'Load Wind Tunnel PRO settings', filters: [{ name: 'Wind Tunnel PRO settings', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return WindTunnelPro.normalize(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
});
ipcMain.handle('wts:save-pro', async (e, settings) => {
  const normalized = WindTunnelPro.normalize(settings);
  const r = await dialog.showSaveDialog({ title: 'Save Wind Tunnel PRO settings', defaultPath: path.join(app.getPath('documents'), '.Wind Tunnel Settings.json'), filters: [{ name: 'JSON settings', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return false;
  const file = path.extname(r.filePath) ? r.filePath : r.filePath + '.json'; fs.writeFileSync(file, JSON.stringify(normalized, null, 2), 'utf8'); return { ok: true, file };
});

ipcMain.handle('open-companions-window', () => false);       // no companion apps in All In One NR2003

let stageRaceWindow = null;

function openStageRaceWindow() {
  if (stageRaceWindow) { stageRaceWindow.focus(); return; }

  stageRaceWindow = new BrowserWindow({
    width:     780,
    height:    860,
    minWidth:  540,
    minHeight: 520,
    resizable: true,
    title:     'Stage Racing — All In One NR2003',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  stageRaceWindow.setMenuBarVisibility(false);
  stageRaceWindow.loadFile('stagerace.html');
  stageRaceWindow.on('closed', () => {
    stageRaceWindow = null;
    mainWindow?.webContents.send('stage-race-status', false);
    if (config.stageRacing) { config.stageRacing.enabled = false; saveConfig(); }
  });
  if (config.stageRacing) { config.stageRacing.enabled = !config.stageRacing.stagesOff; saveConfig(); }
  mainWindow?.webContents.send('stage-race-status', !(config.stageRacing && config.stageRacing.stagesOff));
}

function closeStageRaceWindow() {
  if (stageRaceWindow && !stageRaceWindow.isDestroyed()) {
    stageRaceWindow.close();
  }
  stageRaceWindow = null;
}

ipcMain.handle('open-calibrate',        () => { openCalibrateWindow(); return true; });
ipcMain.handle('save-wheel-calibration', (e, data) => {
  fs.writeFileSync(CALIB_PATH, JSON.stringify(data, null, 2), 'utf8');
  config.wheelInput = data;
  saveConfig();
  if (shimProc) reopenOverlays();
  return true;
});
ipcMain.handle('get-wheel-calibration', () => {
  try {
    if (fs.existsSync(CALIB_PATH)) return JSON.parse(fs.readFileSync(CALIB_PATH, 'utf8'));
  } catch(e) {}
  return config.wheelInput || null;
});

// Notify the bridge (if running) that the layout/config changed, so it can
// push a live-update signal to any connected master overlay / widget without
// requiring OBS to reload the browser source. Fire-and-forget — safe no-op
// if the bridge isn't running.
function notifyBridgeLayoutChanged() {
  if (!shimProc) return;
  const port = config.httpPort || 8766;
  fetch(`http://localhost:${port}/notify-layout-changed`, { method: 'POST' })
    .catch(() => {}); // bridge not up yet or request failed — non-fatal
}

ipcMain.handle('save-layout', (e, widgets) => {
  setActiveWidgets(widgets);
  saveConfig();
  notifyBridgeLayoutChanged();
  // Update running slot overlays with new settings (position, scale etc)
  // without full close/reopen of all overlays
  if (shimProc) {
    const w = getActiveWidgets();
    for (const [id, slot] of Object.entries(w)) {
      if (slot && !(slot.skins && slot.activeSkin)) {
        // Plain widgets (championship, relative, radar...) have no skins: just honour their enabled flag
        const plainWin = overlayWindows[id];
        if (slot.enabled) {
          if (!plainWin || plainWin.isDestroyed()) createOverlayWindow(id);
        } else if (plainWin && !plainWin.isDestroyed()) {
          plainWin.destroy();
          delete overlayWindows[id];
        }
        continue;
      }
      if (!slot || !slot.skins || !slot.activeSkin) continue;
      const skin = slot.skins[slot.activeSkin];
      if (!skin) continue;
      const win = overlayWindows[id];
      if (win && !win.isDestroyed()) {
        // Reopen to pick up scale/position changes
        win.destroy();
        delete overlayWindows[id];
        if (skin.enabled) createOverlayWindow(id);
      } else if (skin.enabled) {
        createOverlayWindow(id);
      }
    }
  }
  return true;
});

ipcMain.handle('browse-bg', async () => {
  const result = await dialog.showOpenDialog(layoutWindow || mainWindow, {
    title:      'Select Background Image',
    filters:    [{ name: 'Images', extensions: ['png','jpg','jpeg'] }],
    properties: ['openFile'],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    config.layoutBg = result.filePaths[0].replace(/\\/g, '/');
    saveConfig();
    return config.layoutBg;
  }
  return null;
});
ipcMain.handle('get-series', () => scanSeries(true));
// NBC 2017: images dropped in <userData>/images/NBC2017/sponsors are rotated in the logo box
ipcMain.handle('list-sponsor-images', () => {
  // Looks in several places (first one wins for a given file name): AppData, next to the exe, resources, app folder.
  const dirs = [
    path.join(USER_DATA, 'images', 'NBC2017', 'sponsors'),
    path.join(INSTALL_DIR, 'images', 'NBC2017', 'sponsors'),
    path.join(process.resourcesPath || INSTALL_DIR, 'images', 'NBC2017', 'sponsors'),
    path.join(path.dirname(INSTALL_DIR), 'images', 'NBC2017', 'sponsors'),
  ];
  try { fs.mkdirSync(dirs[0], { recursive: true }); } catch (e) {}
  const seen = new Map();
  for (const dir of dirs) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(png|jpe?g|svg|webp|gif)$/i.test(f)) continue;
        const k = f.toLowerCase();
        if (!seen.has(k)) seen.set(k, { name: f, url: require('url').pathToFileURL(path.join(dir, f)).href });
      }
    } catch (e) { /* folder doesn't exist */ }
  }
  const out = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  console.log('[sponsors] searched:', dirs.join(' | '), '->', out.map(o => o.name).join(', ') || '(none)');
  return out;
});

ipcMain.handle('browse-nr2003', async () => {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return { error: 'All In One NR2003’s main window is not ready. Close and reopen All In One NR2003, then try again.' };
    const result = await dialog.showOpenDialog(mainWindow, {
      title:       'Select NR2003.exe (or equivalent)',
      filters:     [{ name: 'Executable', extensions: ['exe'] }],
      properties:  ['openFile'],
    });
    if (!result.canceled && result.filePaths.length > 0) {
      config.nr2003_exe = result.filePaths[0];
      saveConfig();
      return config.nr2003_exe;
    }
    return null;
  } catch (e) {
    console.error('[picker] failed to open NR2003 file dialog:', e);
    return { error: e?.message || String(e) };
  }
});

ipcMain.handle('set-player-folder', (e, folder) => {
  config.playerFolder = folder;
  saveConfig();
  return true;
});

ipcMain.handle('scan-players', () => {
  if (!config.nr2003_exe) return [];
  const playersDir = path.join(path.dirname(config.nr2003_exe), 'players');
  try {
    if (!fs.existsSync(playersDir)) return [];
    return fs.readdirSync(playersDir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const folder = e.name;
        const parts  = folder.split('__');
        const last   = parts[0].replace(/_/g, ' ').trim();
        const first  = (parts[1] || '').replace(/_/g, ' ').trim();
        const label  = first ? `${first} ${last}` : last;
        return { folder, label };
      })
      .filter(p => p.label)
      .sort((a, b) => a.label.localeCompare(b.label));
  } catch(e) {
    return [];
  }
});


ipcMain.handle('set-series', async (e, seriesId) => {
  config.series = seriesId;
  saveConfig();
  try { seasonService?.onSeriesChanged(seriesId); } catch(_) {}
  if (championshipWindow && !championshipWindow.isDestroyed()) championshipWindow.webContents.send('championship-series-changed');
  // Notify bridge to reload series data (colors, rookies, names)
  const port = config.httpPort || 8766;
  try {
    await fetch(`http://localhost:${port}/reload-series?series=${encodeURIComponent(seriesId)}`, { method: 'POST' });
  } catch(_) {}
  // Reopen all overlays with new series
  if (shimProc) reopenOverlays();
  return true;
});

ipcMain.handle('open-racestats', async () => {
  const port   = config.httpPort || 8766;
  const series = config.series   || 'default';
  // token + mobile-server port: lets clicking a driver in Race Stats show that car on screen (links without it stay read-only)
  let extra = '';
  try { const mp = await startMobileServer(); if (mp) extra = `&mport=${mp}&t=${encodeURIComponent(mobileToken())}`; } catch (e) {}
  const url    = `http://localhost:${port}/racestats?series=${encodeURIComponent(series)}${extra}`;
  shell.openExternal(url);
  return true;
});

ipcMain.handle('launch-nr2003', () => {
  launchNR2003();
  return true;
});

ipcMain.handle('toggle-dash', (e, visible) => {
  const widgets = getActiveWidgets();
  widgets.dash = widgets.dash || { x: 20, y: 829, scale: 1.0, opacity: 1.0 };
  widgets.dash.enabled = visible;
  setActiveWidgets(widgets);
  saveConfig();
  if (visible) {
    createOverlayWindow('dash');
  } else {
    const win = overlayWindows['dash'];
    if (win && !win.isDestroyed()) win.close();
    delete overlayWindows['dash'];
  }
  return true;
});

// ── App lifecycle ──────────────────────────────────────────────────────────
// Hardware acceleration — disable if user has opted out (fixes blurry text on some GPUs)
// Must be called before app.whenReady()
try {
  const _cfgRaw = fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8');
  const _cfg    = JSON.parse(_cfgRaw);
  if (_cfg.disableHardwareAcceleration) {
    app.disableHardwareAcceleration();
  }
} catch(e) { /* config not yet created on first run — use default (enabled) */ }

// Chromium switches only take effect when set before the app is ready.
// Disable background throttling so overlays keep updating when NR2003 has focus.
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// Perf: stop Chromium's native window-occlusion tracking (extra hooks/thread that
// are useless for always-on-top overlays sitting over a fullscreen game).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

app.whenReady().then(() => {
  setTimeout(() => { try { startMobileServer(); } catch (e) {} }, 1500);   // serves /api/championship for the Race Stats page
  const seedLog = seedUserData();
  writeDebugLog(seedLog);

  // (Chromium switches are now appended at module load, before 'ready' — see above.)
  lowerElectronPriority();

  Menu.setApplicationMenu(null);

  loadConfig();
  crashJournal.setDir(USER_DATA);
  adoptExternalMods();
  startExtmodsWatcher();
  startSeasonService();
  startAiService();
  startStageFeed();
  startRaceVision();
  startRaceControl();
  startAimod();
  try { seasonService && seasonService._pushRivals(); } catch (e) { /* no season yet */ }
  startAie();
  if (config.aieLaunch && config.aieLaunch.onStart) setTimeout(() => console.log('[aie] launch on start', JSON.stringify(launchAiEnhanced())), 1500);
  startWindTunnelControl();
  startField();
  startDirector();
  startBackground();
  // Hotkeys are (un)registered by the foreground gate: only while NR2003 is in front
  applyHotkeyGate();
  startForegroundWatcher();
  startCamReader();
  startPitOutReader();

  // Kill any leftover instances from previous sessions BEFORE spawning new ones
  // Also kill NR2003.exe if it's still running from a previous CTD — it holds
  // the shared memory handle open which prevents the shim from reinitializing
  const nr2003ExeName = config.nr2003_exe ? path.basename(config.nr2003_exe) : 'NR2003.exe';
  try { execSync('taskkill /F /IM nr2003_bridge.exe /T 2>nul', { windowsHide: true, timeout: 3000 }); } catch(e) {}
  try { execSync('taskkill /F /IM nr2003_shim.exe /T 2>nul',   { windowsHide: true, timeout: 3000 }); } catch(e) {}
  try { execSync(`taskkill /F /IM "${nr2003ExeName}" /T 2>nul`, { windowsHide: true, timeout: 3000 }); } catch(e) {}

  // Wait longer to ensure killed processes are fully gone
  setTimeout(() => {
    createMainWindow();
    createRecorderWindow();
  }, 1500);
});

app.on('window-all-closed', () => {
  stopAll();
  app.quit();
});

// ── NR2003 Background (built in): video and sound keep going when the game's window loses focus ────────────
let background = null, backgroundPoll = null, backgroundMem = null;
function backgroundLog(m) { try { fs.appendFileSync(path.join(USER_DATA, 'background.log'), new Date().toISOString() + ' ' + m + '\r\n'); } catch (e) { /* read-only */ } }
function backgroundSettings() { const b = config.background || {}; return { on: !!b.on, audioOnly: !!b.audioOnly }; }
function startBackground() {
  background = new Background({ log: backgroundLog, settings: backgroundSettings });
  if (backgroundPoll) return;
  const exePath = () => config.nr2003_exe || '';
  backgroundMem = new Win32Memory(() => gameExe.names(config), exePath);
  // a game that All In One NR2003 didn't start this way: its window gets the focus messages, its sound flags are set from now on
  backgroundPoll = setInterval(backgroundCheck, 2000);
  if (backgroundPoll.unref) backgroundPoll.unref();
}
function backgroundCheck() {
  try {
    if (!background || !backgroundMem) return;
    if (!backgroundSettings().on) { if (background.pid) background.stop(); return; }
    if (!backgroundMem.attach()) { if (background.pid) background.stop(); return; }
    if (backgroundMem.pid !== background.pid) background.watch(backgroundMem.pid);
    if (background.soundPid !== backgroundMem.pid) background.latePatch(backgroundMem.pid, backgroundMem);
  } catch (e) { /* the game went away */ }
}
// RaceLab started the game: look every 150 ms for the first 30 s so Background's sound flags go in before the game makes many sounds
function backgroundSoon() {
  const until = Date.now() + 30000;
  const t = setInterval(() => {
    backgroundCheck();
    if (Date.now() > until || (background && backgroundMem && backgroundMem.pid && background.soundPid === backgroundMem.pid)) clearInterval(t);
  }, 150);
  if (t.unref) t.unref();
}
ipcMain.handle('background:get', () => (background ? background.state() : backgroundSettings()));
ipcMain.handle('background:set', (e, patch) => {
  config.background = Object.assign({ on: false, audioOnly: false }, config.background || {}, {
    on: patch && 'on' in patch ? !!patch.on : !!(config.background && config.background.on),
    audioOnly: patch && 'audioOnly' in patch ? !!patch.audioOnly : !!(config.background && config.background.audioOnly),
  });
  saveConfig();
  if (!config.background.on && background) background.stop();
  return background ? background.state() : backgroundSettings();
});

app.on('before-quit', () => {
  try { if (backgroundPoll) clearInterval(backgroundPoll); background?.stop(); backgroundMem?.detach(); } catch (e) { /* ignore */ }
  try { windTunnelControl?.stop(); } catch (e) { /* ignore */ }
  try { seasonService?.stop(); } catch(e) {}
  try { aiService?.stop(); } catch(e) {}      // restores every NR2003 patch
  try { stageFeed?.stop(); } catch(e) {}
  try { qualBoxWin?.stop(); } catch(e) {}
  try { playerOverlayWin?.stop(); } catch(e) {}
  try { radioVoice?.stop(); } catch(e) {}
  try { rcGfxWin?.stop(); } catch(e) {}
  try { raceVision?.stopService(); } catch(e) {}
  try { aimod?.stop(); } catch(e) {}           // restores the game's patched bytes and the normal pit crew
  // (no Superspeedway Lines in All In One NR2003)          // puts the game's race line and lane limits back
  try { aie?.stop(); } catch(e) {}             // puts the driver stats back
  try { if (aieChild && aieChild.pid) process.kill(aieChild.pid); } catch(e) {}   // the AI Enhanced this app started: not left running on its own
  try { field?.stop(); } catch(e) {}           // puts the AI roster back as it was
  try { director?.stop(); } catch(e) {}        // removes the camera hook
  try { raceControl?.stop(); } catch(e) {}    // opens pit road again
  try { if (mobileServer) mobileServer.close(); } catch (e) {}
  isQuitting = true;
  stopForegroundWatcher();
  stopCamReader();
  stopWatch();
  stopPitOutReader();
  globalShortcut.unregisterAll();
  stopNR2003Monitor();
  if (editModeActive) exitEditMode(true);
  stopAll();
});

// Also handle process exit signals
process.on('exit', () => { stopAll(); try { aiService?.stop(); } catch(e) {} });
process.on('SIGINT', () => { stopAll(); process.exit(); });
process.on('SIGTERM', () => { stopAll(); process.exit(); });

// ── Driver Info (editable info lines of the driver banner) ─────────────────
// Stored per series in series/<id>/driverinfo.json as { "<number>": { line1, line2 } }.
let driverInfoWindow = null;
function driverInfoSeriesId() { return config.series || 'default'; }
function driverInfoFile(id) { return path.join(SERIES_DIR, id, 'driverinfo.json'); }
function readDriverInfo(id) {
  try {
    const o = JSON.parse(fs.readFileSync(driverInfoFile(id), 'utf8').replace(/^﻿/, ''));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}
function broadcastDriverInfo() {
  const m = readDriverInfo(driverInfoSeriesId());
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send('driver-info-changed', m); } catch (e) {} }
}
function driverInfoSeriesName() {
  try {
    const ini = fs.readFileSync(path.join(SERIES_DIR, driverInfoSeriesId(), 'seriesinfo.ini'), 'utf8');
    const mm = ini.match(/^seriesname\s*=\s*(.+)/mi);
    if (mm) return mm[1].trim();
  } catch (e) {}
  return '';
}
function openDriverInfo() {
  if (driverInfoWindow) { driverInfoWindow.focus(); return; }
  const id = driverInfoSeriesId();
  let seriesName = '';
  try {
    const ini = fs.readFileSync(path.join(SERIES_DIR, id, 'seriesinfo.ini'), 'utf8');
    const m = ini.match(/^seriesname\s*=\s*(.+)/mi);
    if (m) seriesName = m[1].trim();
  } catch (e) {}
  driverInfoWindow = new BrowserWindow({
    width:  900,
    height: 640,
    title:  'All In One NR2003 — Driver Info',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  driverInfoWindow.loadFile('driver-info.html', { query: {
    installdir: USER_DATA.replace(/\\/g, '/'),
    series:     id,
    seriesname: seriesName,
  } });
  driverInfoWindow.on('closed', () => { driverInfoWindow = null; });
}
ipcMain.handle('open-driver-info', () => { openDriverInfo(); return true; });
// Active horizontal ticker (the skin the Driver Info preview should imitate) and whether that skin can show driver banners
const DRIVER_INFO_SKINS = ['nbc2017shart', 'nbc2016', 'fox2010', 'espn2017', 'prime'];
function driverInfoSkin() {
  let skin = '';
  try {
    const w = getActiveWidgets() || {}, t = w.ticker, tw = w.tower;
    skin = (t && t.activeSkin) || '';
    // Prime is a tower skin: it is the Driver Info skin when it is the active, enabled tower and the ticker has no banner of its own
    const primeOn = !!(tw && tw.activeSkin === 'prime' && tw.skins && tw.skins.prime && tw.skins.prime.enabled);
    const tickerOn = !!(t && t.skins && t.skins[skin] && t.skins[skin].enabled);
    if (primeOn && !(tickerOn && DRIVER_INFO_SKINS.includes(skin))) skin = 'prime';
  } catch (e) {}
  return { skin, supported: DRIVER_INFO_SKINS.includes(skin) };
}
ipcMain.handle('get-driver-info-skin', () => driverInfoSkin());

// Drivers that have both a name and a number in the Series Editor (names.json of the active series)
function driverInfoList() {
  let names = {};
  try { names = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, driverInfoSeriesId(), 'names.json'), 'utf8').replace(/^﻿/, '')) || {}; } catch (e) {}
  let colors = {};
  try { colors = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, driverInfoSeriesId(), 'colors.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) {}
  return Object.keys(names)
    .filter(n => /^\d{1,4}$/.test(String(n).trim()) && names[n] && (String(names[n].first || '').trim() || String(names[n].last || '').trim()))
    .sort((a, b) => (parseInt(a, 10) - parseInt(b, 10)) || a.localeCompare(b))
    .map(n => ({ number: String(n).trim(), first: String(names[n].first || '').trim(), last: String(names[n].last || '').trim(), color: (typeof colors[n] === 'string') ? colors[n].trim() : '' }));
}
ipcMain.handle('get-driver-info-list', () => driverInfoList());
ipcMain.handle('get-driver-info', () => readDriverInfo(driverInfoSeriesId()));
// Remove the Info 1 / Info 2 of every driver of the active series
function clearAllDriverInfo() {
  const id = driverInfoSeriesId();
  try {
    fs.mkdirSync(path.join(SERIES_DIR, id), { recursive: true });
    fs.writeFileSync(driverInfoFile(id), '{}', 'utf8');
  } catch (e) { return false; }
  broadcastDriverInfo();
  return true;
}
ipcMain.handle('clear-all-driver-info', () => clearAllDriverInfo());
function saveDriverInfoEntry(number, data) {
  const id = driverInfoSeriesId(), num = String(number == null ? '' : number).trim();
  if (!/^\d{1,4}$/.test(num)) return false;
  const clean = v => String((v == null) ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 80);
  const KINDS = ['ledToday', 'ledSeason', 'champPos', 'champPts', 'winsSeason', 'top5Season', 'top10Season', 'wins', 'dnfSeason', 'dnfLast', 'startPos', 'curPos', 'lastLap', 'bestLap', 'fastestLap', 'liveChampPos', 'cutoffPts', 'lastPit', 'pitCount', 'custom'];
  const kind = v => { v = String(v == null ? '' : v); return KINDS.includes(v) ? v : ''; };
  const nn = v => { const n = parseInt(v, 10); return (Number.isFinite(n) && n >= 1) ? Math.min(99, n) : 5; };
  let l1 = clean(data && data.line1), l2 = clean(data && data.line2);
  let k1 = kind(data && data.k1), k2 = kind(data && data.k2);
  // old format (text only, no choice) = custom text
  if (data && data.k1 === undefined && l1) k1 = 'custom';
  if (data && data.k2 === undefined && l2) k2 = 'custom';
  if (k1 === 'custom' && !l1) k1 = '';
  if (k2 === 'custom' && !l2) k2 = '';
  if (k1 !== 'custom') l1 = '';
  if (k2 !== 'custom') l2 = '';
  const all = readDriverInfo(id);
  if (k1 || k2) all[num] = { k1, k2, line1: l1, line2: l2, n1: nn(data && data.n1), n2: nn(data && data.n2) }; else delete all[num];
  fs.mkdirSync(path.join(SERIES_DIR, id), { recursive: true });
  fs.writeFileSync(driverInfoFile(id), JSON.stringify(all, null, 2), 'utf8');
  broadcastDriverInfo();
  return true;
}
ipcMain.handle('save-driver-info', (e, number, data) => saveDriverInfoEntry(number, data));

// ── "As they run" panel: which drivers (max 7) and which value the tickers show ─────────────────────────────
// Edited from the phone's Championship tab; stored per series in pointsview.json and pushed to every overlay.
const PV_METRICS = ['', 'points', 'champPos', 'racePos', 'racePosChamp', 'gapCutoff', 'posCutoff'];   // '' = gap to the leader (the original look)
function pointsViewFile(id) { return path.join(SERIES_DIR, id, 'pointsview.json'); }
function cleanPointsView(v) {
  const o = (v && typeof v === 'object') ? v : {};
  const seen = new Set(), drivers = [];
  (Array.isArray(o.drivers) ? o.drivers : []).forEach(n => {
    const k = String(n == null ? '' : n).trim();
    if (/^\d{1,4}$/.test(k) && !seen.has(k) && drivers.length < 7) { seen.add(k); drivers.push(k); }
  });
  return { drivers, metric: PV_METRICS.includes(o.metric) ? o.metric : '' };
}
function readPointsView(id) {
  let v;
  try { v = cleanPointsView(JSON.parse(fs.readFileSync(pointsViewFile(id), 'utf8').replace(/^\uFEFF/, ''))); }
  catch (e) { v = { drivers: [], metric: '' }; }
  // the cutoff line of the Championship screen (not stored here; it only says whether the Cutoff Line options can be used)
  let cut = { enabled: false, pos: 0 };
  try { const c = getChampionship(id) || {}; if (c.cutoffEnabled === true && c.cutoffPos >= 1) cut = { enabled: true, pos: c.cutoffPos, text: c.cutoffText == null ? 'CUTOFF LINE' : String(c.cutoffText), color: c.cutoffColor || '#e8232a', textColor: c.cutoffTextColor || '#ffffff' }; } catch (e) {}
  v.cut = cut;
  return v;
}
function broadcastPointsView() {
  const v = readPointsView(driverInfoSeriesId());
  for (const w of BrowserWindow.getAllWindows()) { try { if (!w.isDestroyed()) w.webContents.send('points-view-changed', v); } catch (e) {} }
}
function savePointsView(data) {
  const id = driverInfoSeriesId(), v = cleanPointsView(data);
  try {
    fs.mkdirSync(path.join(SERIES_DIR, id), { recursive: true });
    fs.writeFileSync(pointsViewFile(id), JSON.stringify(v, null, 2), 'utf8');
  } catch (e) { return false; }
  broadcastPointsView();
  return true;
}
ipcMain.handle('get-points-view', () => readPointsView(driverInfoSeriesId()));
// What the phone needs: the saved choice + the championship drivers in standings order (the ones that can be picked)
function pointsViewState() {
  const id = driverInfoSeriesId();
  let champ = { drivers: [] };
  try { champ = getChampionship(id) || champ; } catch (e) {}
  const info = {};
  driverInfoList().forEach(d => { info[d.number] = d; });
  const seen = new Set(), list = [];
  (champ.drivers || []).forEach((d, idx) => {
    const k = String(d.number == null ? '' : d.number).trim();
    if (!/^\d{1,4}$/.test(k) || seen.has(k)) return; seen.add(k);
    const i = info[k] || {};
    const name = ((i.first || '') + ' ' + (i.last || '')).trim() || String(d.name || '').trim();
    list.push({ number: k, name, color: i.color || '', points: Number(d.points) || 0, idx });
  });
  list.sort((a, b) => (b.points - a.points) || (a.idx - b.idx));
  return { view: readPointsView(id), seriesName: driverInfoSeriesName(), drivers: list.map((o, p) => ({ number: o.number, name: o.name, color: o.color, points: round2(o.points), pos: p + 1 })) };
}

// ── Mobile editor: small local web server so a phone on the same Wi-Fi can edit Info 1 / Info 2 live ──────────
// The link carries a private token (kept in config.mobileToken); requests without it are refused.
const http_ = require('http'), os_ = require('os'), crypto_ = require('crypto');
let mobileServer = null, mobilePort = 0, mobileStarting = null;
function mobileToken() {
  if (!/^[0-9a-f]{18}$/.test(String(config.mobileToken || ''))) { config.mobileToken = crypto_.randomBytes(9).toString('hex'); try { saveConfig(); } catch (e) {} }
  return config.mobileToken;
}
function mobileTokenOk(t) {
  const a = Buffer.from(String(t || '')), b = Buffer.from(mobileToken());
  return a.length === b.length && crypto_.timingSafeEqual(a, b);
}
function mobileReadBody(req, cb) {
  let n = 0; const chunks = [];
  req.on('data', c => { n += c.length; if (n > 8192) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(null); } });
}
function mobileHandler(req, res) {
  const send = (code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(body); };
  let u; try { u = new URL(req.url, 'http://localhost'); } catch (e) { return send(400, 'Bad request', 'text/plain'); }
  // Read-only championship data for the Race Stats web page (points + positions as they run). No token: nothing here can change anything.
  if (u.pathname === '/api/startorder' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
    return res.end(JSON.stringify(startOrder));
  }
  // Season stats per driver for the Race Stats driver card (read-only, no token — same as /api/championship)
  if (u.pathname === '/api/driverstats' && req.method === 'GET') {
    const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
    try {
      const id = resolveSeriesId(u.searchParams.get('series'));
      const sd = loadSeasons(id), sn = sd.seasons.find(x => x.id === sd.activeId);
      const races = sn ? (sn.races || []).filter(r => !r.nonPoints && Array.isArray(r.rows) && r.rows.length) : [];
      const blank = () => ({ wins: 0, top5: 0, top10: 0, dnf: 0, poles: 0, races: 0 });
      const st = {};
      races.forEach(r => r.rows.forEach(x => {
        const k = String(x.number).trim(), o = st[k] || (st[k] = blank());
        const fin = Number(x.finish) || 0, stt = String(x.status || '').trim().toLowerCase();
        o.races++;
        if (!x.dq && fin === 1) o.wins++;
        if (!x.dq && fin >= 1 && fin <= 5) o.top5++;
        if (!x.dq && fin >= 1 && fin <= 10) o.top10++;
        if (x.dq || (stt && stt !== 'running' && stt !== 'pitting')) o.dnf++;
        if (Number(x.start) === 1) o.poles++;
      }));
      const champ = getChampionship(id);
      const order = champ.drivers.map((d, i) => ({ k: String(d.number).trim(), pts: Number(d.points) || 0, i })).sort((a, b) => (b.pts - a.pts) || (a.i - b.i));
      order.forEach((o, p) => { const e = st[o.k] || (st[o.k] = blank()); e.points = round2(o.pts); e.pos = p + 1; });
      const mm = readManuMeta(id), manus = {};
      mm.list.forEach(m => { manus[m.id] = m.name; });
      res.writeHead(200, cors);
      return res.end(JSON.stringify({ ok: true, season: sn ? sn.name : '', races: races.length, champSize: order.length, drivers: st, manus, assign: mm.assign }));
    } catch (e) { res.writeHead(500, cors); return res.end('{"ok":false}'); }
  }
  if (u.pathname === '/api/championship') {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Max-Age': '600' }); return res.end(); }
    if (req.method === 'GET') {
      try {
        const id = resolveSeriesId(u.searchParams.get('series'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' });
        return res.end(JSON.stringify({ seriesId: id, data: getChampionship(id) }));
      } catch (e) { return send(500, '{"ok":false}'); }
    }
  }
  if (!mobileTokenOk(u.searchParams.get('t'))) return send(403, 'Invalid link. Scan the QR code again.', 'text/plain; charset=utf-8');
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
    try { return send(200, fs.readFileSync(path.join(__dirname, 'mobile-info.html')), 'text/html; charset=utf-8'); }
    catch (e) { return send(500, 'Page missing', 'text/plain'); }
  }
  if (req.method === 'GET' && u.pathname === '/api/state') return send(200, JSON.stringify({ cam: camNumber(), list: driverInfoList(), info: readDriverInfo(driverInfoSeriesId()), seriesName: driverInfoSeriesName(), skin: driverInfoSkin().skin, httpPort: config.httpPort || 8766, series: driverInfoSeriesId(), cutoff: (() => { try { const c = getChampionship(driverInfoSeriesId()) || {}; return c.cutoffEnabled === true && c.cutoffPos >= 1; } catch (e) { return false; } })() }));
  // assets for the phone preview (car number, manufacturer logo, banner font) - numbers are validated, no path tricks possible
  if (req.method === 'GET' && u.pathname.startsWith('/asset/')) {
    const sendFile = (file, type) => { try { return send(200, fs.readFileSync(file), type); } catch (e) { return send(404, 'Not found', 'text/plain'); } };
    let mm;
    if (u.pathname === '/asset/font.ttf') return sendFile(path.join(USER_DATA, 'images', 'NBC2016', 'font.ttf'), 'font/ttf');
    if ((mm = /^\/asset\/number\/(\d{1,4})\.png$/.exec(u.pathname))) return sendFile(path.join(SERIES_DIR, driverInfoSeriesId(), 'numbers', mm[1] + '.png'), 'image/png');
    if ((mm = /^\/asset\/manu\/(\d{1,4})\.png$/.exec(u.pathname))) return sendFile(path.join(SERIES_DIR, driverInfoSeriesId(), 'manufacturers', mm[1] + '.png'), 'image/png');
    const sid = driverInfoSeriesId();
    if ((mm = /^\/asset\/headshot\/(\d{1,4})\.png$/.exec(u.pathname))) return sendFile(path.join(SERIES_DIR, sid, 'headshots', mm[1] + '.png'), 'image/png');
    if ((mm = /^\/asset\/car\/(\d{1,4})\.png$/.exec(u.pathname))) return sendFile(path.join(SERIES_DIR, sid, 'cars', mm[1] + '.png'), 'image/png');
    if (u.pathname === '/asset/defaultheadshot.png') return sendFile(path.join(USER_DATA, 'images', 'defaultheadshot.png'), 'image/png');
    if (u.pathname === '/asset/serieslogo.png') return sendFile(path.join(SERIES_DIR, sid, 'serieslogo.png'), 'image/png');
    if (u.pathname === '/asset/psf-logo.png') return sendFile(path.join(__dirname, 'static', 'images', 'psf_logo.png'), 'image/png');
    if (u.pathname === '/asset/logo.svg') return sendFile(path.join(USER_DATA, 'images', 'nr2003_logo.svg'), 'image/svg+xml');
    if (u.pathname === '/asset/font-din.ttf') return sendFile(path.join(USER_DATA, 'images', 'ticker', 'DIN Condensed Bold.ttf'), 'font/ttf');
    if (u.pathname === '/asset/font-halyard.otf') return sendFile(path.join(USER_DATA, 'fonts', 'halyard-text-medium.otf'), 'font/otf');
    if (u.pathname === '/asset/font-racer.otf') return sendFile(path.join(USER_DATA, 'fonts', 'Racer Pro Italic.otf'), 'font/otf');
    return send(404, 'Not found', 'text/plain');
  }
  if (req.method === 'POST' && u.pathname === '/api/save') return mobileReadBody(req, b => {
    if (!b || typeof b !== 'object') return send(400, '{"ok":false}');
    send(200, JSON.stringify({ ok: !!saveDriverInfoEntry(b.number, b.data) }));
  });
  // Championship tab: read / save the "As they run" choice (drivers + value shown)
  if (u.pathname === '/api/pview') {
    if (req.method === 'GET') return send(200, JSON.stringify(pointsViewState()));
    if (req.method === 'POST') return mobileReadBody(req, b => {
      if (!b || typeof b !== 'object') return send(400, '{"ok":false}');
      send(200, JSON.stringify({ ok: savePointsView(b), view: readPointsView(driverInfoSeriesId()) }));
    });
  }
  // Race Stats page: current car on screen / show a car on screen (token required, so a shared read-only link cannot move the camera)
  if (u.pathname === '/api/cam' || u.pathname === '/api/watch-car') {
    const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' };
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); return res.end(); }
    if (req.method === 'GET' && u.pathname === '/api/cam') { res.writeHead(200, cors); return res.end(JSON.stringify({ idx: camCar, num: camNumber(), hold: watchIdx })); }
    if (req.method === 'POST' && u.pathname === '/api/watch-car') return mobileReadBody(req, b => {
      if (!b || typeof b !== 'object') { res.writeHead(400, cors); return res.end('{"ok":false}'); }
      watchCar(b.carIdx).then(ok => { res.writeHead(200, cors); res.end(JSON.stringify({ ok })); });
    });
  }
  if (req.method === 'POST' && u.pathname === '/api/clear-all') return mobileReadBody(req, () => send(200, JSON.stringify({ ok: clearAllDriverInfo() })));
  send(404, '{"ok":false}');
}
function startMobileServer() {
  if (mobileStarting) return mobileStarting;
  mobileStarting = new Promise(resolve => {
    let port = 48765;   // far from the bridge's own ports (8765 / 8766)
    const tryListen = () => {
      const srv = http_.createServer(mobileHandler);
      srv.on('error', err => { if (!mobileServer && err.code === 'EADDRINUSE' && port < 48785) { port++; tryListen(); } else if (!mobileServer) { mobileStarting = null; resolve(0); } });
      srv.listen(port, '0.0.0.0', () => { mobileServer = srv; mobilePort = port; resolve(port); });
    };
    tryListen();
  });
  return mobileStarting;
}
function lanAddresses() {
  const out = [], ifs = os_.networkInterfaces();
  Object.keys(ifs).forEach(name => (ifs[name] || []).forEach(a => { if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ name, ip: a.address }); }));
  const rank = ip => /^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return out.sort((a, b) => rank(a.ip) - rank(b.ip));
}
// Opens the phone page in this PC's browser on the chosen tab (TV Director card of the home screen)
ipcMain.handle('open-mobile-tab', async (e, tab) => {
  const port = await startMobileServer();
  if (!port) return { ok: false, error: 'Could not start the local server' };
  const t = ['di', 'ch', 'rs'].includes(tab) ? '#' + tab : '';   // no tab: the page opens on the one used last
  try { await shell.openExternal('http://127.0.0.1:' + port + '/?t=' + mobileToken() + t); } catch (err) { return { ok: false }; }
  return { ok: true };
});
ipcMain.handle('get-mobile-info', async () => {
  const port = await startMobileServer();
  if (!port) return { ok: false, error: 'Could not start the local server' };
  const t = mobileToken();
  return { ok: true, port, urls: lanAddresses().map(a => ({ name: a.name, ip: a.ip, url: 'http://' + a.ip + ':' + port + '/?t=' + t })) };
});

// ── Series Editor window ───────────────────────────────────────────────────
let seriesEditorWindow = null;

function openSeriesEditor() {
  if (seriesEditorWindow) { seriesEditorWindow.focus(); return; }
  seriesEditorWindow = new BrowserWindow({
    width:  1100,
    height: 700,
    title:  'All In One NR2003 — Series Editor',
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      sandbox: false,
      preload:          path.join(__dirname, 'preload.js'),
      webSecurity:      false,
    },
  });
  seriesEditorWindow.loadFile('series-editor.html', { query: {
    installdir: USER_DATA.replace(/\\/g, '/'),
    series:     config.series || '',
  } });
  seriesEditorWindow.on('closed', () => { seriesEditorWindow = null; });
}

ipcMain.handle('open-series-editor', () => { openSeriesEditor(); return true; });

// ── Series Editor IPC handlers ─────────────────────────────────────────────

// List all series (same as get-series but without 'default')
ipcMain.handle('get-series-list', () => {
  const all = scanSeries(true);
  return all.filter(s => s.id !== 'default');
});

// Read seriesinfo.ini for a series
ipcMain.handle('get-series-info', (e, id) => {
  const iniPath = path.join(SERIES_DIR, id, 'seriesinfo.ini');
  let name = id;
  try {
    const ini = fs.readFileSync(iniPath, 'utf8');
    const m   = ini.match(/^seriesname\s*=\s*(.+)/mi);
    if (m) name = m[1].trim();
  } catch(_) {}
  return { name };
});

// Save seriesinfo.ini and colors.json for a series
ipcMain.handle('save-series-info', (e, id, data) => {
  const dir = path.join(SERIES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'seriesinfo.ini'), `seriesname=${data.name}\n`, 'utf8');
  if (data.colors && Object.keys(data.colors).length > 0) {
    fs.writeFileSync(path.join(dir, 'colors.json'), JSON.stringify(data.colors, null, 2), 'utf8');
  } else {
    // Write empty colors.json if no colors set
    fs.writeFileSync(path.join(dir, 'colors.json'), '{}', 'utf8');
  }
  // Write rookies.json
  if (data.rookies && Object.keys(data.rookies).length > 0) {
    fs.writeFileSync(path.join(dir, 'rookies.json'), JSON.stringify(data.rookies, null, 2), 'utf8');
  } else {
    fs.writeFileSync(path.join(dir, 'rookies.json'), '{}', 'utf8');
  }
  // Write names.json
  if (data.names && Object.keys(data.names).length > 0) {
    fs.writeFileSync(path.join(dir, 'names.json'), JSON.stringify(data.names, null, 2), 'utf8');
  } else {
    fs.writeFileSync(path.join(dir, 'names.json'), '{}', 'utf8');
  }
  invalidateSeriesCache();
  return true;
});

// Create new series — make folder structure and blank files
ipcMain.handle('create-series', (e, id, name) => {
  const dir = path.join(SERIES_DIR, id);
  fs.mkdirSync(path.join(dir, 'numbers'),       { recursive: true });
  fs.mkdirSync(path.join(dir, 'headshots'),     { recursive: true });
  fs.mkdirSync(path.join(dir, 'cars'),          { recursive: true });
  fs.mkdirSync(path.join(dir, 'manufacturers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'seriesinfo.ini'), `seriesname=${name}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'colors.json'),  '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'rookies.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'names.json'),   '{}', 'utf8');
  invalidateSeriesCache();
  return true;
});

// Delete a series folder
ipcMain.handle('delete-series', (e, id) => {
  const dir = path.join(SERIES_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  invalidateSeriesCache();
  return true;
});

// Get which car numbers have assets
ipcMain.handle('get-series-car-data', (e, id) => {
  const numDir  = path.join(SERIES_DIR, id, 'numbers');
  const headDir = path.join(SERIES_DIR, id, 'headshots');
  const carDir  = path.join(SERIES_DIR, id, 'cars');
  const manuDir = path.join(SERIES_DIR, id, 'manufacturers');
  let colors = {}, rookies = {}, names = {};
  try { colors  = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, id, 'colors.json'),  'utf8')); } catch(_) {}
  try { rookies = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, id, 'rookies.json'), 'utf8')); } catch(_) {}
  try { names   = JSON.parse(fs.readFileSync(path.join(SERIES_DIR, id, 'names.json'),   'utf8')); } catch(_) {}

  const ALL_NUMS = [
    '0','00','01','02','03','04','05','06','07','08','09',
    ...Array.from({length:99},  (_,i) => String(i+1)),
    ...Array.from({length:900}, (_,i) => String(i+100))
  ];
  const result = {};
  ALL_NUMS.forEach(n => {
    const hasNum  = fs.existsSync(path.join(numDir,  n + '.png'));
    const hasHead = fs.existsSync(path.join(headDir, n + '.png'));
    const hasManu = fs.existsSync(path.join(manuDir, n + '.png'));
    const hasCar  = fs.existsSync(path.join(carDir,  n + '.png'));
    const color   = colors[n]  || null;
    const rookie  = !!rookies[n];
    const nameOv  = names[n]   || null;  // { first, last } or null
    if (hasNum || hasHead || hasManu || hasCar || color || rookie || nameOv) {
      result[n] = { hasNum, hasHead, hasManu, hasCar, color, rookie, nameOv };
    }
  });
  return result;
});

// Get a URL to a series asset for display in the renderer
ipcMain.handle('get-series-asset-url', (e, id, filename) => {
  const p = path.join(SERIES_DIR, id, filename);
  if (!fs.existsSync(p)) return null;
  return 'file:///' + p.replace(/\\/g, '/');
});

// Inline URL builder (synchronous, used from renderer directly via URL param)
ipcMain.handle('get-asset-url', (e, id, subfolder, filename) => {
  const p = path.join(SERIES_DIR, id, subfolder, filename);
  if (!fs.existsSync(p)) return null;
  return 'file:///' + p.replace(/\\/g, '/');
});

// Browse and copy an asset (number.png or headshot) into the series folder
ipcMain.handle('browse-series-asset', async (e, id, subfolder, num) => {
  const win = seriesEditorWindow || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title:      `Select PNG for #${num}`,
    filters:    [{ name: 'PNG Image', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return false;
  const dest = path.join(SERIES_DIR, id, subfolder);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(result.filePaths[0], path.join(dest, num + '.png'));
  return true;
});

// Car photo: accepts PNG or JPG, converts to PNG and shrinks big photos so 40+
// of them stay light for the overlays. Saved as series/<id>/cars/<number>.png
const CAR_PHOTO_MAX_W = 640;
function importCarPhoto(srcPath, destPath) {
  const img = nativeImage.createFromPath(srcPath);
  if (!img || img.isEmpty()) return false;
  const { width } = img.getSize();
  const out = width > CAR_PHOTO_MAX_W ? img.resize({ width: CAR_PHOTO_MAX_W, quality: 'best' }) : img;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, out.toPNG());
  return true;
}
ipcMain.handle('browse-car-photo', async (e, id, num) => {
  if (!/^\d{1,4}$/.test(String(num))) return false;
  const win = seriesEditorWindow || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title:      `Select the car photo for #${num}`,
    filters:    [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return false;
  try { return importCarPhoto(result.filePaths[0], path.join(SERIES_DIR, id, 'cars', num + '.png')); }
  catch (err) { console.error('browse-car-photo failed:', err); return false; }
});

// ── Spotter guide ────────────────────────────────────────────────────────
// The Series Editor draws the guide on a canvas. It needs the images as data
// URLs (a canvas fed with file:// images can't be exported), plus the driver
// names typed in the Championship window as a fallback for numbers without a
// name in the Series data.
// Which car numbers are in the Chase / Playoff, using the Championship settings.
// Manual (Playoff 2014–2025): the drivers ticked as PLAYOFF.
// Top (Chase 2004–2013): top N by points going into the race, plus anyone within X points of the leader.
function chaseInfo(id) {
  const c = getChampionship(id);
  const flagged = c.drivers.filter(d => d.playoff).length;
  const label = c.chaseMode === 'manual' ? 'PLAYOFF' : 'CHASE';
  if (!c.chaseEnabled) return { enabled: false, label, numbers: [], flagged };
  let numbers;
  if (c.chaseMode === 'manual') {
    numbers = c.drivers.filter(d => d.playoff).map(d => d.number);
  } else {
    const order = c.drivers.map((d, i) => ({ d, i })).sort((a, b) => (b.d.points - a.d.points) || (a.i - b.i));
    const lead  = order.length ? order[0].d.points : 0;
    numbers = order
      .filter((o, idx) => idx < c.chaseSize || (c.chaseWithin > 0 && lead - o.d.points <= c.chaseWithin))
      .map(o => o.d.number);
  }
  return { enabled: true, label, numbers, flagged };
}

ipcMain.handle('get-spotter-assets', (e, id, numbers) => {
  const dir  = path.join(SERIES_DIR, String(id || ''));
  const read = (p) => { try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); } catch (err) { return null; } };
  const out  = { logo: read(path.join(dir, 'serieslogo.png')), cars: {}, names: {}, chase: { enabled: false, label: 'CHASE', numbers: [], flagged: 0 } };
  try { out.chase = chaseInfo(String(id)); } catch (err) {}
  (Array.isArray(numbers) ? numbers : []).slice(0, 400).forEach(n => {
    n = String(n);
    if (!/^\d{1,4}$/.test(n)) return;
    out.cars[n] = { car: read(path.join(dir, 'cars', n + '.png')), num: read(path.join(dir, 'numbers', n + '.png')) };
  });
  try { getChampionship(String(id)).drivers.forEach(d => { if (d.name) out.names[d.number] = d.name; }); } catch (err) {}
  return out;
});

// ── Standings image (Championship window) ─────────────────────────────────
// Everything the "Standings image" export needs: the table (points, behind, starts, wins,
// top 5/10, DNFs, laps led, change since the previous race) computed from the races stored in
// the chosen season, plus the series logo, number PNGs and manufacturer logos as data URLs.
ipcMain.handle('get-standings-data', (e, seriesId, seasonId, limit) => {
  const id    = resolveSeriesId(seriesId);
  const champ = getChampionship(id);
  const data  = loadSeasons(id);
  const season = data.seasons.find(x => x.id === seasonId) || data.seasons.find(x => x.id === data.activeId) || null;
  const isActive = !season || season.id === data.activeId;
  const dir  = path.join(SERIES_DIR, id);
  const read = (f) => { try { return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'); } catch (err) { return null; } };
  let names = {};
  try { names = JSON.parse(fs.readFileSync(path.join(dir, 'names.json'), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (err) {}

  // Points: the live championship for the active season, the closing snapshot for a finished one
  let base = champ.drivers.map(d => ({ number: String(d.number).trim(), name: d.name || '', points: Number(d.points) || 0 }));
  if (!isActive && season && Array.isArray(season.finalStandings) && season.finalStandings.length)
    base = season.finalStandings.map(d => ({ number: String(d.number).trim(), name: d.name || '', points: Number(d.points) || 0 }));

  // Per-driver stats from the races of the season (non-scoring races don't count)
  const st = new Map();
  const get = n => { if (!st.has(n)) st.set(n, { starts: 0, wins: 0, top5: 0, top10: 0, dnfs: 0, led: 0 }); return st.get(n); };
  const races = season ? season.races.filter(r => !r.nonPoints && Array.isArray(r.rows) && r.rows.length) : [];
  races.forEach(r => r.rows.forEach(row => {
    const x = get(String(row.number).trim()), f = Number(row.finish) || 0;
    const stt = String(row.status || '').trim().toLowerCase();
    x.starts++; x.led += Number(row.led) || 0;
    if (!row.dq) { if (f === 1) x.wins++; if (f >= 1 && f <= 5) x.top5++; if (f >= 1 && f <= 10) x.top10++; }
    if (row.dq || (stt && stt !== 'running' && stt !== 'pitting')) x.dnfs++;
  }));

  // Change in the order caused by the last race that counted
  const last = isActive ? races.filter(r => (r.counted || (r.applied && r.applied.length)) && r.applied).slice(-1)[0] : null;
  const rankOf = list => { const m = new Map(); list.map((d, i) => ({ d, i })).sort((a, b) => (b.d.pts - a.d.pts) || (a.i - b.i)).forEach((o, k) => m.set(o.d.number, k + 1)); return m; };
  const nowRank = rankOf(base.map(d => ({ number: d.number, pts: d.points })));
  let prevRank = null;
  if (last && races.length > 1) {
    const dl = new Map(last.applied.map(x => [String(x.number).trim(), Number(x.pts) || 0]));
    prevRank = rankOf(base.map(d => ({ number: d.number, pts: d.points - (dl.get(d.number) || 0) })));
  }

  const sorted = base.map((d, i) => ({ d, i })).sort((a, b) => (b.d.points - a.d.points) || (a.i - b.i)).map(o => o.d);
  const top = sorted.length ? sorted[0].points : 0;
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 20, 80));
  const rows = sorted.slice(0, n).map((d, i) => {
    const nm = names[d.number] || {};
    let first = String(nm.first || '').trim(), lastN = String(nm.last || '').trim();
    if (!first && !lastN) {
      const t = String(d.name || '').trim().split(/\s+/).filter(Boolean);
      if (t.length > 1) { first = t.slice(0, -1).join(' '); lastN = t[t.length - 1]; } else lastN = t[0] || '#' + d.number;
    }
    const x = st.get(d.number) || { starts: 0, wins: 0, top5: 0, top10: 0, dnfs: 0, led: 0 };
    return {
      pos: i + 1, change: prevRank ? (prevRank.get(d.number) - nowRank.get(d.number)) : 0,
      number: d.number, first, last: lastN,
      numImg: read(path.join(dir, 'numbers', d.number + '.png')),
      mfrImg: read(path.join(dir, 'manufacturers', d.number + '.png')),
      points: round2(d.points), behind: round2(d.points - top), ...x,
    };
  });
  return { logo: read(path.join(dir, 'serieslogo.png')), seasonName: season ? season.name : '', races: races.length, hasHistory: !!prevRank, total: sorted.length, rows };
});

ipcMain.handle('get-race-image-data', (e, seriesId, raceId, limit) => {
  const id   = resolveSeriesId(seriesId);
  const data = loadSeasons(id);
  let race = null;
  for (const sn of data.seasons) { race = sn.races.find(x => x.id === raceId); if (race) break; }
  if (!race) return null;
  const dir  = path.join(SERIES_DIR, id);
  const read = (f) => { try { return 'data:image/png;base64,' + fs.readFileSync(f).toString('base64'); } catch (err) { return null; } };
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 80, 100));
  const rows = (race.rows || []).slice(0, n).map(x => ({
    finish: x.finish, start: x.start == null ? null : x.start, number: String(x.number).trim(), name: x.name || ('#' + x.number),
    interval: x.interval, laps: x.laps, led: x.led || 0, mostLed: !!x.mostLed, points: x.points, status: x.status || '', dq: !!x.dq,
    numImg: read(path.join(dir, 'numbers', String(x.number).trim() + '.png')),
    mfrImg: read(path.join(dir, 'manufacturers', String(x.number).trim() + '.png')),
  }));
  let date = '';
  try { date = race.dateStr || (race.at ? new Date(race.at).toLocaleDateString() : ''); } catch (err) {}
  return { logo: read(path.join(dir, 'serieslogo.png')), name: race.name || '', track: race.track || '', date,
           cautionFlags: race.cautionFlags != null ? race.cautionFlags : null, cautionLaps: race.cautionLaps != null ? race.cautionLaps : null,
           leadChanges: race.leadChanges != null ? race.leadChanges : null, leadDrivers: race.leadDrivers != null ? race.leadDrivers : null,
           hasMostLed: rows.some(r => r.mostLed), rows };
});

ipcMain.handle('save-race-image', async (e, buffer, defaultName) => {
  const r = await dialog.showSaveDialog(championshipWindow || mainWindow, {
    title:       'Save results image',
    defaultPath: path.join(app.getPath('pictures'), safeFileName(defaultName || 'race_results') + '.png'),
    filters:     [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(buffer));
  return r.filePath;
});

ipcMain.handle('save-standings-image', async (e, buffer, defaultName) => {
  const r = await dialog.showSaveDialog(championshipWindow || mainWindow, {
    title:       'Save standings image',
    defaultPath: path.join(app.getPath('pictures'), safeFileName(defaultName || 'standings') + '.png'),
    filters:     [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(buffer));
  return r.filePath;
});

ipcMain.handle('save-spotter-image', async (e, buffer, defaultName) => {
  const r = await dialog.showSaveDialog(seriesEditorWindow || mainWindow, {
    title:       'Save spotter guide',
    defaultPath: path.join(app.getPath('pictures'), safeFileName(defaultName || 'spotter_guide') + '.png'),
    filters:     [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(buffer));
  return r.filePath;
});

// Clear (delete) a series asset
ipcMain.handle('clear-series-asset', (e, id, subfolder, num) => {
  const p = path.join(SERIES_DIR, id, subfolder, num + '.png');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});

// Browse and set a series logo
ipcMain.handle('browse-series-logo', async (e, id) => {
  const win = seriesEditorWindow || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title:      'Select series logo PNG',
    filters:    [{ name: 'PNG Image', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return false;
  const dest = path.join(SERIES_DIR, id);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(result.filePaths[0], path.join(dest, 'serieslogo.png'));
  return true;
});

// Browse and set a series-level manufacturer PNG (manu1.png - manu4.png)
ipcMain.handle('browse-series-manufacturer', async (e, id, slot, light) => {
  const win = seriesEditorWindow || mainWindow;
  const result = await dialog.showOpenDialog(win, {
    title:      `Select PNG for Manufacturer ${slot}${light ? ' (light-background version)' : ''}`,
    filters:    [{ name: 'PNG Image', extensions: ['png'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths.length) return false;
  const dest = path.join(SERIES_DIR, id, 'manufacturers');
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(result.filePaths[0], path.join(dest, `manu${slot}${light ? '_light' : ''}.png`));
  syncAssignedManufacturer(id, parseInt(slot, 10));
  return true;
});

// Remove the light-background version of a manufacturer (and the copies of the cars assigned to it)
ipcMain.handle('clear-series-manufacturer-light', (e, id, mid) => {
  mid = parseInt(mid, 10);
  if (!(mid >= 1)) return false;
  try { fs.unlinkSync(path.join(SERIES_DIR, id, 'manufacturers', `manu${mid}_light.png`)); } catch (er) {}
  syncAssignedManufacturer(id, mid);
  return true;
});

// Get series-level manufacturer PNG URLs
ipcMain.handle('get-series-manufacturers', (e, id) => {
  const dir = path.join(SERIES_DIR, id, 'manufacturers');
  const result = {};
  for (let i = 1; i <= 4; i++) {
    const p = path.join(dir, `manu${i}.png`);
    result[i] = fs.existsSync(p) ? 'file:///' + p.replace(/\\/g, '/') : null;
  }
  return result;
});

// ── Manufacturers: a named list per series ────────────────────────────────
// series/<id>/manufacturers.json = { list:[{id,name}], assign:{ "<car number>": <manufacturer id> } }
// Ids 1-4 are the game's car-make slots (manu1-4.png, picked automatically from the car file).
// Extra manufacturers (id 5+) are used only through a per-car assignment. Assigning one copies its
// PNG to manufacturers/<number>.png, which is the per-car override the overlays already read.
function manuMetaPath(id) { return path.join(SERIES_DIR, id, 'manufacturers.json'); }
function readManuMeta(id) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(manuMetaPath(id), 'utf8').replace(/^\uFEFF/, '')) || {}; } catch (e) {}
  const dir = path.join(SERIES_DIR, id, 'manufacturers');
  const names = new Map();
  (Array.isArray(raw.list) ? raw.list : []).forEach(m => {
    const n = parseInt(m && m.id, 10);
    if (n >= 1 && n <= 999 && !names.has(n)) names.set(n, String(m.name == null ? '' : m.name).trim().slice(0, 30));
  });
  for (let i = 1; i <= 4; i++) if (!names.has(i)) names.set(i, '');
  try {
    fs.readdirSync(dir).forEach(f => {
      const m = f.match(/^manu(\d+)\.png$/i);
      if (m) { const n = parseInt(m[1], 10); if (n >= 1 && n <= 999 && !names.has(n)) names.set(n, ''); }
    });
  } catch (e) {}
  const list = [...names.entries()].sort((a, b) => a[0] - b[0]).map(([mid, name]) => ({ id: mid, name: name || `Manufacturer ${mid}` }));
  const assign = {};
  Object.entries(raw.assign || {}).forEach(([num, mid]) => {
    const n = parseInt(mid, 10);
    if (/^\d{1,4}$/.test(num) && names.has(n)) assign[num] = n;
  });
  return { list, assign };
}
function writeManuMeta(id, meta) {
  fs.mkdirSync(path.join(SERIES_DIR, id), { recursive: true });
  fs.writeFileSync(manuMetaPath(id), JSON.stringify({ list: meta.list, assign: meta.assign }, null, 2), 'utf8');
}
// The logo of manufacturer `mid` changed: refresh the per-car copy of every car assigned to it
function syncAssignedManufacturer(id, mid) {
  try {
    const meta = readManuMeta(id);
    const dir  = path.join(SERIES_DIR, id, 'manufacturers');
    const src  = path.join(dir, `manu${mid}.png`);
    const lsrc = path.join(dir, `manu${mid}_light.png`);   // optional light-background version
    Object.entries(meta.assign).forEach(([num, m]) => {
      if (m !== mid) return;
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, `${num}.png`));
      const ld = path.join(dir, `${num}_light.png`);
      if (fs.existsSync(lsrc)) fs.copyFileSync(lsrc, ld); else { try { fs.unlinkSync(ld); } catch (er) {} }
    });
  } catch (e) { console.error('syncAssignedManufacturer:', e); }
}

ipcMain.handle('get-series-manufacturers-v2', (e, id) => {
  const meta = readManuMeta(id);
  const dir  = path.join(SERIES_DIR, id, 'manufacturers');
  return { list: meta.list.map(m => ({ ...m, has: fs.existsSync(path.join(dir, `manu${m.id}.png`)), light: fs.existsSync(path.join(dir, `manu${m.id}_light.png`)) })), assign: meta.assign };
});

ipcMain.handle('add-series-manufacturer', (e, id) => {
  const meta = readManuMeta(id);
  const next = Math.max(4, ...meta.list.map(m => m.id)) + 1;
  if (next > 999) return null;
  meta.list.push({ id: next, name: `Manufacturer ${next}` });
  writeManuMeta(id, meta);
  return next;
});

ipcMain.handle('rename-series-manufacturer', (e, id, mid, name) => {
  mid = parseInt(mid, 10);
  const meta = readManuMeta(id);
  const m = meta.list.find(x => x.id === mid);
  if (!m) return false;
  m.name = String(name == null ? '' : name).trim().slice(0, 30) || `Manufacturer ${mid}`;
  writeManuMeta(id, meta);
  return m.name;
});

// Only the extra manufacturers (5+) can be removed; the cars assigned to it go back to automatic
ipcMain.handle('remove-series-manufacturer', (e, id, mid) => {
  mid = parseInt(mid, 10);
  if (!(mid > 4)) return false;
  const meta = readManuMeta(id);
  const dir  = path.join(SERIES_DIR, id, 'manufacturers');
  Object.entries(meta.assign).forEach(([num, m]) => {
    if (m === mid) { try { fs.unlinkSync(path.join(dir, `${num}.png`)); } catch (er) {} try { fs.unlinkSync(path.join(dir, `${num}_light.png`)); } catch (er) {} delete meta.assign[num]; }
  });
  try { fs.unlinkSync(path.join(dir, `manu${mid}.png`)); } catch (er) {}
  try { fs.unlinkSync(path.join(dir, `manu${mid}_light.png`)); } catch (er) {}
  meta.list = meta.list.filter(x => x.id !== mid);
  writeManuMeta(id, meta);
  return true;
});

// mid = null → automatic (from the car file): the per-car override is removed
ipcMain.handle('assign-series-manufacturer', (e, id, num, mid) => {
  num = String(num);
  if (!/^\d{1,4}$/.test(num)) return { ok: false, error: 'bad-number' };
  const meta = readManuMeta(id);
  const dir  = path.join(SERIES_DIR, id, 'manufacturers');
  const dest = path.join(dir, `${num}.png`);
  if (mid == null || mid === '') {
    try { fs.unlinkSync(dest); } catch (er) {}
    try { fs.unlinkSync(path.join(dir, `${num}_light.png`)); } catch (er) {}
    delete meta.assign[num];
    writeManuMeta(id, meta);
    return { ok: true };
  }
  mid = parseInt(mid, 10);
  if (!meta.list.some(m => m.id === mid)) return { ok: false, error: 'unknown' };
  const src = path.join(dir, `manu${mid}.png`);
  if (!fs.existsSync(src)) return { ok: false, error: 'no-image' };
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dest);
  { const lsrc = path.join(dir, `manu${mid}_light.png`), ld = path.join(dir, `${num}_light.png`);   // light-background version follows the assignment
    if (fs.existsSync(lsrc)) fs.copyFileSync(lsrc, ld); else { try { fs.unlinkSync(ld); } catch (er) {} } }
  meta.assign[num] = mid;
  writeManuMeta(id, meta);
  return { ok: true };
});

// ── Screen color eyedropper ────────────────────────────────────────────────
const { desktopCapturer } = require('electron');

ipcMain.handle('pick-screen-color', async () => {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scaleFactor), height: Math.round(height * scaleFactor) },
  });
  if (!sources.length) return null;

  const screenshot = sources[0].thumbnail.toDataURL();

  return new Promise((resolve) => {
    const eyedropWin = new BrowserWindow({
      width, height, x: 0, y: 0,
      frame: false, transparent: true, alwaysOnTop: true,
      skipTaskbar: true, resizable: false, movable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: false },
    });

    const html = `<!DOCTYPE html><html><head><style>
      * { margin:0; padding:0; cursor:crosshair; }
      body { width:${width}px; height:${height}px; overflow:hidden; }
      canvas { display:block; position:absolute; top:0; left:0; }
      #magnifier {
        position:fixed; border:2px solid #fff; border-radius:50%;
        width:80px; height:80px; pointer-events:none;
        box-shadow:0 0 0 1px #000; overflow:hidden;
      }
      #mag-canvas { width:80px; height:80px; image-rendering:pixelated; }
      #mag-cross {
        position:absolute; top:0; left:0; width:100%; height:100%; pointer-events:none;
      }
      #mag-cross::before, #mag-cross::after {
        content:''; position:absolute; background:rgba(255,255,255,0.7);
      }
      #mag-cross::before { width:1px; height:100%; left:50%; }
      #mag-cross::after  { width:100%; height:1px; top:50%; }
      #preview {
        position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,0.82); color:#fff; padding:7px 18px;
        border-radius:20px; font-family:monospace; font-size:14px;
        pointer-events:none; display:flex; align-items:center; gap:8px; letter-spacing:1px;
      }
      #pdot { width:14px; height:14px; border-radius:50%; border:1px solid rgba(255,255,255,0.3); }
      #hint {
        position:fixed; top:20px; left:50%; transform:translateX(-50%);
        background:rgba(0,0,0,0.7); color:#fff; padding:6px 18px;
        border-radius:20px; font-family:sans-serif; font-size:13px; pointer-events:none;
      }
    </style></head><body>
      <canvas id="c"></canvas>
      <div id="magnifier"><canvas id="mag-canvas" width="80" height="80"></canvas><div id="mag-cross"></div></div>
      <div id="preview"><div id="pdot"></div><span id="hlabel">#000000</span></div>
      <div id="hint">Click to pick · Esc to cancel</div>
    <script>
      window.__result = null;
      const img = new Image();
      img.onload = () => {
        const c = document.getElementById('c');
        c.width = ${width}; c.height = ${height};
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, ${width}, ${height});
        const mag = document.getElementById('magnifier');
        const mc  = document.getElementById('mag-canvas');
        const mctx = mc.getContext('2d');
        mctx.imageSmoothingEnabled = false;
        const hlabel = document.getElementById('hlabel');
        const pdot   = document.getElementById('pdot');
        const toHex  = (px) => '#' + [px[0],px[1],px[2]].map(v=>v.toString(16).padStart(2,'0')).join('');
        document.addEventListener('mousemove', e => {
          const x = e.clientX, y = e.clientY;
          let mx = x + 22, my = y + 22;
          if (mx + 82 > ${width})  mx = x - 102;
          if (my + 82 > ${height}) my = y - 102;
          mag.style.left = mx + 'px'; mag.style.top = my + 'px';
          mctx.drawImage(c, x-5, y-5, 10, 10, 0, 0, 80, 80);
          const px = ctx.getImageData(x, y, 1, 1).data;
          const hex = toHex(px);
          hlabel.textContent = hex; pdot.style.background = hex;
        });
        document.addEventListener('click', e => {
          const px = ctx.getImageData(e.clientX, e.clientY, 1, 1).data;
          window.__result = toHex(px);
        });
        document.addEventListener('keydown', e => {
          if (e.key === 'Escape') window.__result = 'cancel';
        });
      };
      img.src = '${screenshot}';
    <\/script></body></html>`;

    eyedropWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    let resolved = false;
    const poll = setInterval(async () => {
      if (eyedropWin.isDestroyed()) { clearInterval(poll); if (!resolved) { resolved = true; resolve(null); } return; }
      try {
        const result = await eyedropWin.webContents.executeJavaScript('window.__result');
        if (result) {
          clearInterval(poll);
          if (!resolved) { resolved = true; }
          eyedropWin.close();
          resolve(result === 'cancel' ? null : result);
        }
      } catch(_) {}
    }, 50);

    eyedropWin.on('closed', () => {
      clearInterval(poll);
      if (!resolved) { resolved = true; resolve(null); }
    });
  });
});
