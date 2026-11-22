// RaceLab (NR2003 Race Lab, nine-series beta) built into All In One NR2003 as a companion: RaceLab's features run inside the game (SpinMod.dll,
// injected by SpinModLauncher.exe - AI racecraft, tire failures, crash panels / soft body, traffic yield, drafting rows, allies / rivals,
// Career). All In One NR2003 launches NR2003 through it, edits its settings in RaceLab's own files (SpinMod.ini, CupPanelTuning.ini - RaceLab's
// launcher sees the same values), and while RaceLab drives the AI, All In One NR2003's own overlapping AI writers stand aside (owns()).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const gameExe = require('../gameexe');
const rel = require('./relations');

const LAUNCHER = 'SpinModLauncher.exe', INI = 'SpinMod.ini', TUNING = 'CupPanelTuning.ini', LOG = 'SpinMod.log', RELATIONS = 'RaceLabV2Relationships.ini';
// RaceLab's renderer for each game build (Game EXEs\Choosing a game EXE.txt): soft body checks rend_dxg.dll as a pair with the exe
const RENDERER = 'rend_dxg.dll', RENDERER_BACKUP = 'rend_dxg.dll.steelfire-original';
const RENDERERS = { 'NR2003_RaceLabV2.exe': '58635622e17a226ae82e4f741136c3839474d8295c01a0f44886f5cbeb754ee1', 'NR2003_MS.exe': '4b205eca6edee71731bf40ee023aa41621c58b92899b9ced6dcdaec0352c8729' };
const ACTIVE_LOG_S = 20;            // RaceLab is running in the game while its log is being written (it logs every few seconds)

// the body damage modes (RaceLab's Modules > Body damage): RaceLab's detachable panels, or the soft body for one exact series
const BODY_MODES = ['RaceLab panels', 'Original Cup soft body', '2003WC_sng soft body', 'Cup12ss soft body', 'Gen6BR soft body', 'FCRD NCS22 v1 soft body',
  'cup2000 soft body', 'Cup12 soft body', 'lmpv2 soft body', 'cts95 soft body'];
const PANEL_REGIONS = ['hood', 'decklid', 'rear_spoiler', 'front_bumper', 'rear_bumper', 'left_fender', 'left_quarter', 'left_door_skin', 'right_fender', 'right_quarter',
  'right_door_skin', 'roof', 'roof_flap_left', 'roof_flap_right'];

// The settings the All In One NR2003 page shows, by RaceLab launcher tab: [section, key, label, kind, extra, help]. kind: bool | num | text | choice
const FIELDS = {
  modules: [
    ['Modules', 'SpinModEnabled', 'Tire failures (SpinMod)', 'bool', null, 'AI tire failures: the hotkey and random failures (Tire failures tab).'],
    ['Modules', 'DetachablePanelsEnabled', 'Detachable panels (RaceLab panels mode)', 'bool', null, 'The native detachable panels and wheels, for RaceLab panels mode.'],
    ['Modules', 'BodyDamageEnabled', 'Body damage', 'bool', null, 'RaceLab\'s body damage (panels or soft body, by the mode below).'],
    ['Modules', 'RacingLinesEnabled', 'Dynamic racing lines and passing', 'bool', null, 'RaceLab\'s AI passing, drafting rows, traffic and superspeedway pack strategy. While it runs, All In One NR2003\'s Superspeedway Lines and AI Enhanced\'s tandem / MultiGroove stand aside.'],
    ['Modules', 'RelationshipsEnabled', 'Allies and rivals', 'bool', null, 'RaceLab\'s rivalry and ally behaviour. While it runs, AIMOD\'s racing intensity and rivals stand aside (every driver gets his own aggression back).'],
    ['CareerMode', 'Enabled', 'Career menu and race progression', 'bool', null, 'RaceLab\'s Career (inbox, garage, sponsors, money).'],
    ['RelationshipIndicators', 'Enabled', 'Ally / rival markers over the cars', 'bool', null, ''],
  ],
  tires: [
    ['SpinMod', 'TriggerKey', 'Manual failure hotkey', 'text', null, 'One key, e.g. Q.'],
    ['SpinMod', 'Wheel', 'Target wheel', 'choice', ['Random', 'LF', 'RF', 'LR', 'RR'], ''],
    ['SpinMod', 'DamageSeverity', 'Severity (0-1)', 'num', [0, 1, 0.05], ''],
    ['SpinMod', 'RandomFailuresEnabled', 'Random failures', 'bool', null, ''],
    ['SpinMod', 'RandomFailureChancePerMinute', 'Random chance per minute (%)', 'num', [0, 100, 0.5], ''],
    ['SpinMod', 'CooldownMs', 'Cooldown (ms)', 'num', [0, 60000, 100], ''],
    ['SpinMod', 'RequireRacingAction', 'Only cars that are racing', 'bool', null, 'A failure only on a car in racing AI (not pitting, not crashing).'],
    ['SpinMod', 'RequireGameForeground', 'Only while the game is in front', 'bool', null, ''],
    ['SpinMod', 'RearSpinAssistEnabled', 'Rear failures can spin the car', 'bool', null, ''],
    ['SpinMod', 'FrontUndersteerEnabled', 'Front failures push the car up', 'bool', null, ''],
  ],
  damage: [
    ['DetachablePanels', 'AffectPlayer', 'Panels come off your car too', 'bool', null, ''],
    ['DetachablePanels', 'AutoDetachEnabled', 'Panels come off in crashes', 'bool', null, ''],
    ['DetachablePanels', 'AutoDetachChancePercent', 'Detach chance (%)', 'num', [0, 100, 1], ''],
    ['DetachablePanels', 'AutoDetachMinimumDamage', 'Minimum damage to detach (0-1)', 'num', [0, 1, 0.05], ''],
    ['DetachablePanels', 'RolloverSheddingEnabled', 'Panels shed in rollovers', 'bool', null, ''],
    ['ArticulatedHood', 'HingeStrengthPercent', 'Hood hinge strength (%)', 'num', [10, 200, 1], ''],
    ['ArticulatedFrontBumper', 'MountStrengthPercent', 'Front bumper mount strength (%)', 'num', [10, 200, 1], ''],
    ['ArticulatedRearBumper', 'MountStrengthPercent', 'Rear bumper mount strength (%)', 'num', [10, 200, 1], ''],
    ['DetachableWheels', 'Enabled', 'Wheels can come off', 'bool', null, 'Model support varies by series.'],
    ['DetachableWheels', 'AffectPlayer', 'Wheels can come off your car', 'bool', null, ''],
    ['DetachableWheels', 'RolloverMaximumWheels', 'Most wheels off a car', 'num', [0, 4, 1], ''],
    ['DetachableWheels', 'FatalEngineOnDetach', 'A lost wheel ends the car\'s race', 'bool', null, 'The terminal engine consequence.'],
    ['PitService', 'BodyRepairRateScale', 'Body repair speed (x)', 'num', [0.1, 3, 0.05], ''],
  ],
  traffic: [
    ['TrafficYield', 'ActiveEnabled', 'Slower cars yield', 'bool', null, 'RaceLab recommends turning yield off on short tracks.'],
    ['TrafficYield', 'MinimumDamageSeverity', 'Damaged car: minimum damage (0-1)', 'num', [0, 1, 0.05], ''],
    ['TrafficYield', 'MinimumSpeedDeficitMph', 'Damaged car: mph slower than the pack', 'num', [0, 60, 1], ''],
    ['TrafficYield', 'MaximumCatchSeconds', 'Damaged car: caught within (s)', 'num', [1, 60, 0.5], ''],
    ['TrafficYield', 'HealthyOffPaceEnabled', 'Healthy off-pace cars yield too', 'bool', null, ''],
    ['TrafficYield', 'HealthyMinimumSpeedDeficitMph', 'Healthy car: mph slower', 'num', [0, 60, 1], ''],
    ['TrafficYield', 'HealthyMaximumCatchSeconds', 'Healthy car: caught within (s)', 'num', [1, 60, 0.5], ''],
  ],
  lines: [
    ['SuperspeedwayStrategy', 'TrackProfile', 'Track profile', 'choice', ['Auto', 'Superspeedway', 'Speedway', 'Short Track', 'Road Course'], 'Auto uses the track\'s metadata.'],
    ['SuperspeedwayStrategy', 'Enabled', 'Superspeedway pack strategy', 'bool', null, ''],
    ['DynamicPassing', 'ActiveEnabled', 'AI passing moves', 'bool', null, ''],
    ['DynamicPassing', 'AbsoluteRowsEnabled', 'Protected drafting rows', 'bool', null, 'Speedway and plate tracks (types 1-4); not short tracks, road courses or Darlington.'],
    ['DynamicPassing', 'FormationOutsideTargetCars', 'Row targets: outside', 'num', [0, 43, 1], ''],
    ['DynamicPassing', 'FormationMiddleTargetCars', 'Row targets: middle', 'num', [0, 43, 1], ''],
    ['DynamicPassing', 'FormationInsideTargetCars', 'Row targets: inside', 'num', [0, 43, 1], ''],
    ['DynamicPassing', 'FormationSettleLaps', 'Settling laps after the start', 'num', [0, 10, 1], ''],
    ['DynamicPassing', 'RestartSettleLaps', 'Settling laps after a restart', 'num', [0, 10, 1], ''],
    ['DynamicPassing', 'FormationCalmFraction', 'Opening protection to (race fraction)', 'num', [0, 1, 0.05], ''],
    ['AllyCooperation', 'Enabled', 'Team / manufacturer cooperation', 'bool', null, ''],
    ['AllyCooperation', 'TeamEnabled', 'Teammates work together', 'bool', null, ''],
    ['AllyCooperation', 'ManufacturerEnabled', 'Manufacturers work together', 'bool', null, ''],
    ['AllyCooperation', 'TeammatesNeverBlock', 'Teammates never block each other', 'bool', null, ''],
  ],
  rivals: [
    ['RivalrySystem', 'Enabled', 'Rivalries', 'bool', null, ''],
    ['RivalrySystem', 'RetaliationEnabled', 'Retaliation', 'bool', null, ''],
    ['RivalrySystem', 'ActionAggressionPercent', 'Rival aggression (%)', 'num', [0, 400, 5], ''],
    ['RivalrySystem', 'ContactActionRecoveryMs', 'Time between contact reactions (ms)', 'num', [0, 120000, 500], ''],
    ['RivalrySystem', 'RetaliationRecoveryMs', 'Time between retaliations (ms)', 'num', [0, 300000, 1000], ''],
    ['RivalrySystem', 'AllyDefenseEnabled', 'Allies defend each other', 'bool', null, ''],
  ],
};

// ---- ini files, edited line by line so comments, order and unknown keys stay
function iniRead(text) {
  const out = {};
  let sec = '';
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l[0] === ';' || l[0] === '#') continue;
    const m = /^\[(.+)\]$/.exec(l);
    if (m) { sec = m[1]; out[sec] = out[sec] || {}; continue; }
    const i = l.indexOf('=');
    if (i > 0 && sec) out[sec][l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return out;
}
// patch: { section: { key: value } } -> the text with those values set (added at the end of the section, or a new section, if missing)
function iniWrite(text, patch) {
  const nl = String(text).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(text) ? String(text).split(/\r?\n/) : [];
  const endNl = lines.length > 1 && lines[lines.length - 1] === '';
  if (endNl) lines.pop();
  for (const [sec, kv] of Object.entries(patch)) {
    let start = lines.findIndex(l => l.trim() === '[' + sec + ']');
    if (start < 0) {
      if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
      lines.push('[' + sec + ']'); start = lines.length - 1;
    }
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (/^\s*\[.+\]\s*$/.test(lines[i])) { end = i; break; }
    for (const [k, v] of Object.entries(kv)) {
      let at = -1;
      for (let i = start + 1; i < end; i++) { const l = lines[i].trim(); const j = l.indexOf('='); if (j > 0 && l[0] !== ';' && l.slice(0, j).trim().toLowerCase() === k.toLowerCase()) { at = i; break; } }
      if (at >= 0) lines[at] = lines[at].slice(0, lines[at].indexOf('=') + 1) + String(v);
      else { let ins = end; while (ins > start + 1 && lines[ins - 1].trim() === '') ins--; lines.splice(ins, 0, k + '=' + String(v)); end++; }
    }
  }
  return lines.join(nl) + (endNl || !String(text) ? nl : '');
}
const iniWriteFile = (file, patch) => { const t = fs.existsSync(file) ? fs.readFileSync(file, 'latin1') : ''; fs.writeFileSync(file, iniWrite(t, patch), 'latin1'); };

function clean(kind, extra, v) {
  if (kind === 'bool') return v === true || v === 1 || v === '1' || v === 'true' ? '1' : '0';
  if (kind === 'num') { let n = Number(v); if (!Number.isFinite(n)) return null; if (extra) n = Math.max(extra[0], Math.min(extra[1], n)); return String(Math.round(n * 1000) / 1000); }
  if (kind === 'choice') return extra.includes(String(v)) ? String(v) : null;
  const s = String(v == null ? '' : v).replace(/[\r\n=\[\]]/g, '').trim();
  return s.length ? s.slice(0, 40) : null;
}

class RaceLabService {
  // opts: { getConfig, saveConfig, log, gameRunning? () => bool, now? }
  constructor(opts) {
    this.opts = opts;
    this.now = opts.now || Date.now;
    this.lastCheck = null; this.busy = '';
  }
  log(m) { if (this.opts.log) this.opts.log('[racelab] ' + m); }
  cfg() {
    const c = this.opts.getConfig();
    if (!c.raceLab || typeof c.raceLab !== 'object') c.raceLab = {};
    for (const [k, v] of Object.entries({ enabled: false, dir: '' })) if (!(k in c.raceLab)) c.raceLab[k] = v;   // in place: callers hold on to it
    return c.raceLab;
  }
  // the RaceLab folder: the one chosen, else the beta folder next to NR2003 (the folder holding SpinModLauncher.exe)
  dir() {
    const c = this.cfg();
    if (c.dir && fs.existsSync(path.join(c.dir, LAUNCHER))) return c.dir;
    const game = this.opts.getConfig().nr2003_exe ? path.dirname(this.opts.getConfig().nr2003_exe) : '';
    for (const root of [game, game && path.dirname(game)].filter(Boolean)) {
      let names = [];
      try { names = fs.readdirSync(root); } catch (e) { continue; }
      for (const n of names) {
        if (!/racelab/i.test(n)) continue;
        for (const p of [path.join(root, n), path.join(root, n, 'RaceLab')]) if (fs.existsSync(path.join(p, LAUNCHER))) return p;
      }
    }
    return '';
  }
  // ── RaceLab included with the app: the original download (a zip in <install>\RaceLab, opts.bundledZip()) unpacked into the NR2003
  // folder, where dir() finds it - not into the install folder, because RaceLab keeps its log, settings and Career saves in its own folder
  bundledZip() { try { const z = this.opts.bundledZip ? this.opts.bundledZip() : ''; return z && fs.existsSync(z) ? z : ''; } catch (e) { return ''; } }
  installBundled() {
    if (this.unpacking) return Promise.resolve({ ok: false, message: 'Already unpacking RaceLab.' });
    const zip = this.bundledZip(), game = this._gameDir();
    if (!zip) return Promise.resolve({ ok: false, message: 'RaceLab is not included with this install.' });
    if (!game) return Promise.resolve({ ok: false, message: 'Choose NR2003 on the main page first.' });
    if (this.opts.gameRunning && this.opts.gameRunning()) return Promise.resolve({ ok: false, message: 'Close NR2003 first.' });
    const dest = path.join(game, path.basename(zip, path.extname(zip))), inner = path.join(dest, 'RaceLab');
    if (fs.existsSync(path.join(inner, LAUNCHER))) { this.setDir(inner); return Promise.resolve({ ok: true, message: 'RaceLab is already unpacked in ' + dest + ' and is now selected.' }); }
    this.unpacking = true; this.unpackMsg = 'Unpacking RaceLab into ' + dest + '...';
    this.log('unpacking the included RaceLab into ' + dest);
    const done = (ok, message) => { this.unpacking = false; this.unpackMsg = message; this.log(message); return { ok, message }; };
    return new Promise((resolve) => {
      try { fs.mkdirSync(dest, { recursive: true }); } catch (e) { resolve(done(false, 'Could not make ' + dest + ': ' + e.message)); return; }
      // Windows' own tar (Windows 10 1803+) unpacks a zip quickly; PowerShell's Expand-Archive if it isn't there
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const finish = (err) => {
        if (!err && fs.existsSync(path.join(inner, LAUNCHER))) { this.setDir(inner); resolve(done(true, 'RaceLab is unpacked in ' + dest + ' and selected. Switch on "Launch NR2003 through RaceLab" to use it.')); }
        else resolve(done(false, 'Could not unpack RaceLab' + (err ? ': ' + String(err.message || err).split(/\r?\n/)[0] : ' (SpinModLauncher.exe is missing after unpacking).')));
      };
      const viaPs = () => execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', "Expand-Archive -LiteralPath '" + zip.replace(/'/g, "''") + "' -DestinationPath '" + dest.replace(/'/g, "''") + "' -Force"], { windowsHide: true, timeout: 900000 }, (err) => finish(err));
      if (fs.existsSync(tar)) execFile(tar, ['-xf', zip, '-C', dest], { windowsHide: true, timeout: 900000 }, (err) => (err ? viaPs() : finish(null)));
      else viaPs();
    });
  }
  setDir(d) { const c = this.cfg(); c.dir = d && fs.existsSync(path.join(d, LAUNCHER)) ? d : (d && fs.existsSync(path.join(d, 'RaceLab', LAUNCHER)) ? path.join(d, 'RaceLab') : ''); this.opts.saveConfig(); return this.state(); }
  setEnabled(on) { this.cfg().enabled = !!on; this.opts.saveConfig(); return this.state(); }

  // RaceLab's game builds (its Game EXEs folder): RaceLab injects only into those and they must keep their names, so the game then
  // runs as NR2003_RaceLabV2.exe / NR2003_MS.exe (every All In One NR2003 mod looks for those names too, gameexe.js).
  _gameDir() { const e = this.opts.getConfig().nr2003_exe; return e ? path.dirname(e) : ''; }
  _supplied() { const d = this.dir(); return d ? path.join(path.dirname(d), 'Game EXEs') : ''; }
  gameExes() {
    const g = this._gameDir(), sup = this._supplied();
    return gameExe.RACELAB_EXES.map(name => ({ name, inGame: !!g && fs.existsSync(path.join(g, name)), supplied: !!sup && fs.existsSync(path.join(sup, name)) }))
      .filter(x => x.inGame || x.supplied);
  }
  setGameExe(name) {
    const n = String(name || '');
    const ok = this.gameExes().some(x => x.name === n);   // first: gameExes() re-creates config.raceLab (cfg())
    this.cfg().gameExe = ok ? n : '';
    this.opts.saveConfig();
    return this.state();
  }
  // the exe RaceLab starts: the chosen build in the game folder (copied there from Game EXEs when it isn't yet, as RaceLab's guide says), else NR2003's
  exe() {
    const c = this.cfg(), main = this.opts.getConfig().nr2003_exe || '';
    if (!c.gameExe || !main) return main;
    const dst = path.join(this._gameDir(), c.gameExe);
    if (!fs.existsSync(dst)) {
      const src = path.join(this._supplied(), c.gameExe);
      try { fs.copyFileSync(src, dst); this.log('copied ' + c.gameExe + ' from Game EXEs into the game folder'); } catch (e) { this.log('could not copy ' + c.gameExe + ' into the game folder: ' + e.message); return main; }
    }
    return dst;
  }

  ini() { const d = this.dir(); try { return d ? iniRead(fs.readFileSync(path.join(d, INI), 'latin1')) : {}; } catch (e) { return {}; } }
  // ── the renderer: RaceLab's soft body checks rend_dxg.dll as a pair with its game build (Game EXEs\Choosing a game EXE.txt).
  // Switching backs up the game's own rend_dxg.dll first (never overwritten once made) and Restore puts it back, both checked by SHA-256.
  _sha(f) { try { return require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch (e) { return ''; } }
  _shaCached(f) {
    let st; try { st = fs.statSync(f); } catch (e) { return ''; }
    const k = f + '|' + st.size + '|' + st.mtimeMs;
    this._shaCache = this._shaCache || new Map();
    if (!this._shaCache.has(k)) this._shaCache.set(k, this._sha(f));
    return this._shaCache.get(k);
  }
  _rendFile() { const g = this._gameDir(); return g ? path.join(g, RENDERER) : ''; }
  _backupFile() { const g = this._gameDir(); return g ? path.join(g, RENDERER_BACKUP) : ''; }
  // rend_dxg*.dll files that could be RaceLab's renderer: picked by the user, in the game's Backup folders, around RaceLab
  _rendCandidates() {
    const out = new Set((this.cfg().rendererSources || []).filter(f => fs.existsSync(f)));
    const walk = (dir, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth > 0 && !/^(node_modules|\.git)$/i.test(e.name)) walk(p, depth - 1); }
        else if (/^rend_dxg.*\.dll$/i.test(e.name) && p.toLowerCase() !== this._rendFile().toLowerCase()) out.add(p);
      }
    };
    const g = this._gameDir(), d = this.dir();
    if (g) walk(path.join(g, 'Backup'), 4);
    if (d) walk(path.dirname(d), 3);
    return [...out];
  }
  renderer() {
    const c = this.cfg(), f = this._rendFile();
    const cur = f ? this._shaCached(f) : '';
    const need = c.gameExe ? RENDERERS[c.gameExe] : '';
    const matches = Object.keys(RENDERERS).find(n => RENDERERS[n] === cur) || '';
    const source = need ? (this._rendCandidates().find(p => this._shaCached(p) === need) || '') : '';
    const b = this._backupFile(), bk = c.rendererBackup || null;
    return { gameExe: c.gameExe || '', need, current: cur, matches, ok: !!need && cur === need, source,
      backup: b && fs.existsSync(b) ? { file: b, sha: this._shaCached(b), at: bk && bk.at || 0 } : null,
      original: !!b && fs.existsSync(b) && cur === this._shaCached(b) };
  }
  // put the renderer that matches the chosen game build in place (from a found copy, or `file` the user picked)
  switchRenderer(file) {
    if (this.opts.gameRunning && this.opts.gameRunning()) return { ok: false, text: 'Close NR2003 first: the game has rend_dxg.dll open.' };
    const c = this.cfg(), need = c.gameExe ? RENDERERS[c.gameExe] : '';
    if (!need) return { ok: false, text: 'Pick NR2003_RaceLabV2.exe or NR2003_MS.exe as the Game EXE first: each has its own renderer.' };
    const dst = this._rendFile();
    if (!dst || !fs.existsSync(dst)) return { ok: false, text: 'rend_dxg.dll was not found in the game folder.' };
    let src = '';
    if (file) {
      if (this._sha(file) !== need) return { ok: false, text: 'That file is not the renderer ' + c.gameExe + ' needs (SHA-256 ' + need.slice(0, 12) + '…).' };
      src = file;
      const list = (c.rendererSources || []).filter(f => f !== file); list.unshift(file); c.rendererSources = list.slice(0, 8);
    } else src = this.renderer().source;
    if (!src) return { ok: false, text: 'The renderer for ' + c.gameExe + ' (SHA-256 ' + need.slice(0, 12) + '…) was not found. Use "Pick the file…" to choose it.' };
    const cur = this._sha(dst);
    if (cur === need) return { ok: true, text: 'The game already has the renderer ' + c.gameExe + ' needs.' };
    const bak = this._backupFile();
    // the backup is the game's own renderer: made once, and never from one of RaceLab's renderers
    if (!fs.existsSync(bak)) {
      if (Object.values(RENDERERS).includes(cur)) return { ok: false, text: 'The game already has one of RaceLab\'s renderers and there is no backup of the original, so nothing was changed.' };
      try { fs.copyFileSync(dst, bak); } catch (e) { return { ok: false, text: 'Could not back up rend_dxg.dll: ' + e.message }; }
      if (this._sha(bak) !== cur) { try { fs.unlinkSync(bak); } catch (e) { /* */ } return { ok: false, text: 'The backup did not verify, so nothing was changed.' }; }
      c.rendererBackup = { sha: cur, at: this.now() };
      this.log('backed up the original rend_dxg.dll to ' + RENDERER_BACKUP);
    }
    try { fs.copyFileSync(src, dst); } catch (e) { return { ok: false, text: 'Could not replace rend_dxg.dll: ' + e.message }; }
    this.opts.saveConfig();
    if (this._sha(dst) !== need) return { ok: false, text: 'The copy did not verify. Use Restore original to put your renderer back.' };
    this.log('rend_dxg.dll switched to the ' + c.gameExe + ' renderer from ' + src);
    return { ok: true, text: 'rend_dxg.dll switched to the renderer for ' + c.gameExe + '. Your original is backed up as ' + RENDERER_BACKUP + '.' };
  }
  restoreRenderer() {
    if (this.opts.gameRunning && this.opts.gameRunning()) return { ok: false, text: 'Close NR2003 first: the game has rend_dxg.dll open.' };
    const bak = this._backupFile(), dst = this._rendFile();
    if (!bak || !fs.existsSync(bak)) return { ok: false, text: 'There is no backup of the original rend_dxg.dll.' };
    const want = this._sha(bak), rec = (this.cfg().rendererBackup || {}).sha;
    if (rec && rec !== want) return { ok: false, text: 'The backup has changed since it was made, so it was not restored.' };
    try { fs.copyFileSync(bak, dst); } catch (e) { return { ok: false, text: 'Could not restore rend_dxg.dll: ' + e.message }; }
    if (this._sha(dst) !== want) return { ok: false, text: 'The restored file did not verify. The backup is still at ' + RENDERER_BACKUP + '.' };
    this.log('original rend_dxg.dll restored');
    return { ok: true, text: 'Your original rend_dxg.dll is back. The backup stays as ' + RENDERER_BACKUP + '.' };
  }

  tuning() {
    const d = this.dir(), out = {};
    let t = {};
    try { t = d ? iniRead(fs.readFileSync(path.join(d, TUNING), 'latin1')) : {}; } catch (e) { t = {}; }
    const s = t.CupPanelResponse || {};
    for (const r of PANEL_REGIONS) { const [a, b] = String(s[r] || '100,100').split(',').map(Number); out[r] = [Number.isFinite(a) ? a : 100, Number.isFinite(b) ? b : 100]; }
    return out;
  }

  // RaceLab is driving the game now: its log is being written (it is, every few seconds, while SpinMod.dll runs in NR2003)
  active() {
    const d = this.dir();
    if (!d) return false;
    try { return (this.now() - fs.statSync(path.join(d, LOG)).mtimeMs) / 1000 < ACTIVE_LOG_S && (!this.opts.gameRunning || this.opts.gameRunning()); } catch (e) { return false; }
  }
  // which of All In One NR2003's AI writers RaceLab owns right now: 'lines' (racing lines, passing, drafting rows) or 'relationships' (allies / rivals)
  owns(what) {
    if (!this.active()) return false;
    const m = (this.ini().Modules || {});
    if (what === 'lines') return m.RacingLinesEnabled !== '0';
    if (what === 'relationships') { const on = m.RelationshipsEnabled !== '0'; if (on) this._relSeenAt = this.now(); return on; }
    return false;
  }

  // ── allies and rivals (relations.js): RaceLab's relationship file and live events, as All In One NR2003's rivalries ─────────────────────────
  // RaceLab ran its allies / rivals in the game lately (the race just scored by the Season Tracker had them, even if the game has closed)
  ownedRelationshipsRecently(ms = 15 * 60000) { this.owns('relationships'); return !!this._relSeenAt && this.now() - this._relSeenAt < ms; }
  _relPairs() {
    const d = this.dir();
    if (!d) return [];
    const f = path.join(d, RELATIONS);
    let st; try { st = fs.statSync(f); } catch (e) { return []; }
    const k = st.size + '|' + st.mtimeMs;
    if (this._relKey !== k) { try { this._rel = rel.parseRelationships(fs.readFileSync(f, 'latin1')); this._relKey = k; } catch (e) { return this._rel || []; } }
    return this._rel || [];
  }
  relThresholds() {
    const r = this.ini().RivalrySystem || {}, n = (v, d) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : d);
    return { rival: n(r.RivalThreshold, -40), contact: n(r.ContactRivalThreshold, -60), intense: n(r.IntenseRivalThreshold, -80) };
  }
  // cars: [{ num, first, last }] -> { rivals, allies } among them (cached briefly: asked several times a second)
  relationsFor(cars) {
    const key = (cars || []).map(c => c.num + ':' + c.first + ' ' + c.last).join(',') + '|' + this._relKey;
    const now = this.now();
    if (this._rfKey === key && now - this._rfAt < 1000) return this._rf;
    this._rf = rel.forField(this._relPairs(), cars, this.relThresholds()); this._rfKey = key; this._rfAt = now;
    return this._rf;
  }
  // RaceLab's live AI-AI events, read from the new end of SpinMod.log each time (a new game session starts a new list)
  pollEvents() {
    const d = this.dir();
    if (!d) return this._events || [];
    const f = path.join(d, LOG);
    let st; try { st = fs.statSync(f); } catch (e) { return this._events || []; }
    if (this._evPos == null || st.size < this._evPos) { this._evPos = st.size; this._events = []; return this._events; }   // from now on (and after RaceLab restarted its log)
    if (st.size === this._evPos) return this._events;
    const len = Math.min(st.size - this._evPos, 4 * 1024 * 1024), buf = Buffer.alloc(len);
    try { const fd = fs.openSync(f, 'r'); fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd); } catch (e) { return this._events; }
    this._evPos = st.size;
    const text = buf.toString('latin1');
    if (/EXE profile verified/.test(text)) this._events = [];                 // a new game session
    for (const e of rel.parseEvents(text)) this._events.push(e);
    if (this._events.length > 5000) this._events.splice(0, this._events.length - 5000);
    return this._events;
  }
  raceRivals(cars) { return rel.raceRivals(this.relationsFor(cars), cars, this.pollEvents()); }

  state() {
    const d = this.dir(), ini = this.ini(), c = this.cfg();
    const values = {};
    for (const [tab, list] of Object.entries(FIELDS)) values[tab] = list.map(([sec, key, label, kind, extra, help]) => ({ sec, key, label, kind, extra, help, value: ((ini[sec] || {})[key]) }));
    const cv = ini.CupVisual || {}, comp = ini.Compatibility || {};
    return {
      enabled: !!c.enabled, dir: d, found: !!d, active: this.active(), owns: { lines: this.owns('lines'), relationships: this.owns('relationships') },
      exe: this.opts.getConfig().nr2003_exe || '', gameExe: c.gameExe || '', gameExes: this.gameExes(), renderer: this.renderer(), fields: values, bodyModes: BODY_MODES, bodyMode: cv.Mode || 'RaceLab panels', preferredMode: cv.PreferredMode || '',
      tuning: this.tuning(), regions: PANEL_REGIONS, series: comp.ActiveSeries || '', check: this.lastCheck, busy: this.busy, careers: this.careers(),
      bundled: !!this.bundledZip(), unpacking: !!this.unpacking, unpackMsg: this.unpackMsg || '',
    };
  }
  // patch: { 'Section.Key': value } (only the shown settings), plus bodyMode
  set(patch) {
    const d = this.dir();
    if (!d) return { error: 'RaceLab folder not found' };
    const allowed = new Map();
    for (const list of Object.values(FIELDS)) for (const f of list) allowed.set(f[0] + '.' + f[1], f);
    const out = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'bodyMode') { if (BODY_MODES.includes(String(v))) { (out.CupVisual = out.CupVisual || {}).Mode = String(v); if (v !== 'RaceLab panels') out.CupVisual.PreferredMode = String(v); } continue; }
      const f = allowed.get(k);
      if (!f) continue;
      const val = clean(f[3], f[4], v);
      if (val === null) continue;
      (out[f[0]] = out[f[0]] || {})[f[1]] = val;
    }
    if (Object.keys(out).length) { iniWriteFile(path.join(d, INI), out); this.log('settings saved: ' + Object.entries(out).map(([s, kv]) => Object.keys(kv).map(k => s + '.' + k).join(' ')).join(' ')); }
    return this.state();
  }
  // panel response: region -> [deformation %, fastener %], 25-250 each
  setTuning(map) {
    const d = this.dir();
    if (!d) return { error: 'RaceLab folder not found' };
    const kv = {};
    for (const [r, pair] of Object.entries(map || {})) {
      if (!PANEL_REGIONS.includes(r) || !Array.isArray(pair)) continue;
      const a = Math.max(25, Math.min(250, Math.round(Number(pair[0]) || 100))), b = Math.max(25, Math.min(250, Math.round(Number(pair[1]) || 100)));
      kv[r] = a + ',' + b;
    }
    if (Object.keys(kv).length) iniWriteFile(path.join(d, TUNING), { CupPanelResponse: kv });
    return this.state();
  }

  // RaceLab's own tools, run from its folder
  _run(args, timeout) {
    const d = this.dir();
    return new Promise((res) => {
      if (!d) return res({ code: -1, out: 'RaceLab folder not found' });
      execFile(path.join(d, LAUNCHER), args, { cwd: d, windowsHide: true, timeout: timeout || 60000 }, (err, stdout, stderr) => res({ code: err ? (err.code || 1) : 0, out: String(stdout || '') + String(stderr || '') }));
    });
  }
  // --check: is this game EXE one RaceLab injects into (its build is known by its SHA-256)
  async check() {
    const exe = this.exe();
    if (!exe) return { ok: false, text: 'Set the NR2003 game EXE on the main page first.' };
    this.busy = 'Checking the game EXE...';
    const r = await this._run(['--check', exe], 30000);
    this.busy = '';
    this.lastCheck = { ok: /Version check passed/i.test(r.out) && !/Unsupported/i.test(r.out), text: r.out.trim(), at: this.now() };
    return this.lastCheck;
  }
  async installAssets() {
    const exe = this.exe();
    if (!exe) return { ok: false, text: 'Set the NR2003 game EXE first.' };
    if (this.opts.gameRunning && this.opts.gameRunning()) return { ok: false, text: 'Close NR2003 first: the body models are swapped in its folder.' };
    this.busy = 'Installing the body damage assets...';
    const r = await this._run(['--exe', exe, '--install-assets'], 300000);
    this.busy = '';
    return { ok: r.code === 0, text: r.out.trim() || (r.code === 0 ? 'Body damage assets installed.' : 'Install failed (code ' + r.code + ').') };
  }
  // the launch: RaceLab's injector starts the game with SpinMod.dll (a soft-body mode installs its models first, as RaceLab's launcher does)
  launchArgs(exe) {
    const mode = (this.ini().CupVisual || {}).Mode || 'RaceLab panels';
    return ['--exe', exe].concat(/soft body/i.test(mode) ? ['--install-assets'] : []);
  }
  launch(exe, cb) {
    const d = this.dir();
    if (!d) return false;
    const args = this.launchArgs(exe);
    this.log('launching NR2003 through RaceLab: ' + LAUNCHER + ' ' + args.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));
    execFile(path.join(d, LAUNCHER), args, { cwd: d, windowsHide: true, timeout: 600000 }, (err, stdout, stderr) => {
      const out = (String(stdout || '') + String(stderr || '')).trim();
      if (out) this.log(out.split(/\r?\n/).slice(-6).join(' | '));
      if (cb) cb(err, out);
    });
    return true;
  }
  // RaceLab's own window (Schedule Creator, Career, soft-body replays and the settings All In One NR2003 doesn't show)
  openLauncher() {
    const d = this.dir();
    if (!d) return false;
    try { spawn(path.join(d, 'NR2003RaceLab.exe'), [], { cwd: d, detached: true, stdio: 'ignore' }).unref(); return true; } catch (e) { return false; }
  }
  // careers: RaceLabCareer\Profiles\<id>\career.ini (garage, money, progress) - shown as they are
  careers() {
    const d = this.dir();
    if (!d) return [];
    const root = path.join(d, 'RaceLabCareer', 'Profiles');
    let ids = [];
    try { ids = fs.readdirSync(root, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name); } catch (e) { return []; }
    return ids.slice(0, 40).map(id => {
      let ini = {};
      try { ini = iniRead(fs.readFileSync(path.join(root, id, 'career.ini'), 'latin1')); } catch (e) { ini = {}; }
      const flat = [];
      for (const [sec, kv] of Object.entries(ini)) for (const [k, v] of Object.entries(kv)) if (flat.length < 14 && /name|series|team|money|bank|cash|season|race|event|points|car|sponsor|level|rank/i.test(k)) flat.push([sec + ' ' + k, v]);
      let mtime = 0;
      try { mtime = fs.statSync(path.join(root, id)).mtimeMs; } catch (e) { mtime = 0; }
      return { id, values: flat, updated: mtime };
    }).sort((a, b) => b.updated - a.updated);
  }
  logTail(n) {
    const d = this.dir();
    if (!d) return [];
    try {
      const f = path.join(d, LOG), st = fs.statSync(f), len = Math.min(st.size, 64 * 1024), fd = fs.openSync(f, 'r'), buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len); fs.closeSync(fd);
      return buf.toString('latin1').split(/\r?\n/).filter(Boolean).slice(-(n || 80));
    } catch (e) { return []; }
  }
}

module.exports = { RaceLabService, iniRead, iniWrite, FIELDS, BODY_MODES, PANEL_REGIONS, RENDERERS, RENDERER_BACKUP };
