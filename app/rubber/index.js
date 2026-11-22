// NR2003 Dynamic Rubber, built in: progressive tire rubber on the cars' body paint during a race, drawn by a ReShade add-on
// (NR2003BodyRubber.addon32, shipped in app/beta/dynamic-rubber) that follows the race through NR2003's replay telemetry.
//
// The same install the community "NR2003 Dynamic Rubber Setup" does (read from its source), with the same checks and backups:
//   - core.ini [Replay]: record_telem=1 and every record_telem_state_a bit on (| 0x3FF) - the add-on reads the race from that telemetry;
//   - Direct3D: NR2003 draws with Direct3D 8, so d3d8to9 (d3d8.dll) has to be there and ReShade 6.8.0 with full add-on support (its
//     32-bit runtime as d3d9.dll). An existing d3d8to9 is kept; a DXVK d3d9.dll is kept too, loaded by ReShade as its proxy
//     (d3d9-rubber-dxvk.dll, ReShade.ini [PROXY]); a ReShade 6.8.0 or older is replaced by 6.8.0; anything else needs a manual setup.
//     Missing pieces are downloaded from their official pages and checked against the setup's SHA-256 hashes;
//   - the add-on next to NR2003.exe (or in ReShade's AddonPath inside the game folder).
// Every file it adds or changes is listed in "NR2003 Dynamic Rubber Backups\<time>\Install record.txt" with the old copies beside it,
// the setup's own format, so Restore undoes an install made here or by the setup. On / off renames the add-on (.addon32 / .disabled).
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const ADDON = 'NR2003BodyRubber.addon32';
const DISABLED = 'NR2003BodyRubber.disabled';
const BACKUPS = 'NR2003 Dynamic Rubber Backups';
const RECORD = 'Install record.txt';
const DXVK_PROXY = 'd3d9-rubber-dxvk.dll';
const RESHADE = { url: 'https://reshade.me/downloads/ReShade_Setup_6.8.0_Addon.exe', archive: 'AFE4C8F13048306307983B8B3D41D5BF00A86820440B0E57DEA10950E1176445', dll: 'DA430E0A9C6EECEFA0D1B27D05E16C426FB5D04E808B194D914EAAC4B31BC0F8', name: 'ReShade 6.8.0 with full add-on support' };
const D3D8TO9 = { url: 'https://github.com/crosire/d3d8to9/releases/download/v1.16.0/d3d8.dll', hash: '122928CFE225C25D30DECF7184A5D37E490CECF3B58256BA3206C7E1853F8AB8', name: 'd3d8to9 1.16.0' };
const USER_AGENT = 'NR2003-Dynamic-Rubber-Setup/1.0';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex').toUpperCase();
const readIf = (p) => { try { return fs.readFileSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null; throw e; } };

// ── a PE's facts: 32-bit DLL, and its version strings / numbers (VS_VERSIONINFO) ──
function isX86Dll(b) {
  if (!b || b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return false;
  const pe = b.readInt32LE(60);
  return pe >= 64 && pe <= b.length - 24 && b.readUInt32LE(pe) === 0x4550 && b.readUInt16LE(pe + 4) === 0x14c && (b.readUInt16LE(pe + 22) & 0x2000) !== 0;
}
function verString(b, key) {
  if (!b) return '';
  const k = Buffer.from(key + '\0', 'utf16le');
  let i = b.indexOf(k);
  while (i >= 0) {
    let j = i + k.length; j += (4 - (j % 4)) % 4;                  // the value starts on the next 32-bit boundary
    let end = j; while (end + 1 < b.length && (b[end] || b[end + 1])) end += 2;
    const v = b.toString('utf16le', j, end);
    if (v && /^[\x20-\x7e -ÿ]+$/.test(v)) return v;
    i = b.indexOf(k, i + 2);
  }
  return '';
}
function fileVersion(b) {
  const i = b ? b.indexOf(Buffer.from([0xbd, 0x04, 0xef, 0xfe])) : -1;   // VS_FIXEDFILEINFO signature
  if (i < 0 || i + 16 > b.length) return null;
  const ms = b.readUInt32LE(i + 8), ls = b.readUInt32LE(i + 12);
  return [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
}
const verLE = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; } return true; };

// ── ini files kept line by line (comments, order and line endings stay) ──
class Ini {
  constructor(buf, enc) {
    this.enc = enc;
    const t = buf ? buf.toString(enc) : '';
    this.eol = !t || /\r\n/.test(t) ? '\r\n' : '\n';
    this.trail = !t || /\n$/.test(t);
    this.lines = t ? t.split(/\r\n|\n/) : [];
    if (this.trail && this.lines.length && this.lines[this.lines.length - 1] === '') this.lines.pop();
  }
  _sec(s) { return this.lines.findIndex(l => { const m = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/.exec(l); return m && m[1].trim().toLowerCase() === s.toLowerCase(); }); }
  _key(si, k) {
    if (si < 0) return -1;
    const rx = new RegExp('^(\\s*' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*)([^;#]*?)(\\s*(?:[;#].*)?)$', 'i');
    for (let i = si + 1; i < this.lines.length && !/^\s*\[/.test(this.lines[i]); i++) if (rx.test(this.lines[i])) return i;
    return -1;
  }
  get(s, k) { const i = this._key(this._sec(s), k); if (i < 0) return ''; const m = /=\s*([^;#]*?)\s*(?:[;#].*)?$/.exec(this.lines[i]); return m ? m[1].trim() : ''; }
  set(s, k, v) {
    let si = this._sec(s);
    if (si < 0) { if (this.lines.length && this.lines[this.lines.length - 1].trim() !== '') this.lines.push(''); this.lines.push('[' + s + ']'); si = this.lines.length - 1; }
    const i = this._key(si, k);
    if (i >= 0) { this.lines[i] = this.lines[i].replace(/^(\s*[^=]+?\s*=\s*)([^;#]*?)(\s*(?:[;#].*)?)$/, (m, a, b, c) => a + v + c); return; }
    let end = si + 1; while (end < this.lines.length && !/^\s*\[/.test(this.lines[end])) end++;
    while (end > si + 1 && this.lines[end - 1].trim() === '') end--;
    this.lines.splice(end, 0, k + '=' + v);
  }
  bytes() { return Buffer.from(this.lines.join(this.eol) + (this.trail && this.lines.length ? this.eol : ''), this.enc); }
}

// ── ReShade32.dll out of the official setup (a zip appended to the exe) ──
function reshadeFromSetup(exe) {
  for (let i = 0; i + 4 <= exe.length; i += 512) {
    if (exe.readUInt32LE(i) !== 0x04034b50) continue;
    const zip = exe.subarray(i);
    let e = zip.length - 22;
    while (e >= 0 && zip.readUInt32LE(e) !== 0x06054b50) e--;
    if (e < 0) break;
    const n = zip.readUInt16LE(e + 10); let p = zip.readUInt32LE(e + 16);
    for (let k = 0; k < n && p + 46 <= zip.length && zip.readUInt32LE(p) === 0x02014b50; k++) {
      const method = zip.readUInt16LE(p + 10), csize = zip.readUInt32LE(p + 20), nl = zip.readUInt16LE(p + 28), xl = zip.readUInt16LE(p + 30), cl = zip.readUInt16LE(p + 32), lho = zip.readUInt32LE(p + 42);
      const name = zip.toString('latin1', p + 46, p + 46 + nl);
      if (name === 'ReShade32.dll') {
        const data = lho + 30 + zip.readUInt16LE(lho + 26) + zip.readUInt16LE(lho + 28);
        const raw = zip.subarray(data, data + csize);
        return method === 8 ? zlib.inflateRawSync(raw) : method === 0 ? Buffer.from(raw) : null;
      }
      p += 46 + nl + xl + cl;
    }
    break;
  }
  return null;
}

// a download from its official page (redirects followed), checked against its hash
function download(url, maxBytes = 12 * 1024 * 1024, timeoutMs = 35000, hops = 0) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: timeoutMs }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 5) { res.resume(); resolve(download(new URL(res.headers.location, url).href, maxBytes, timeoutMs, hops + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const parts = []; let n = 0;
      res.on('data', (c) => { n += c.length; if (n > maxBytes) { req.destroy(new Error('the download is larger than expected')); return; } parts.push(c); });
      res.on('end', () => resolve(Buffer.concat(parts)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
  });
}

class RubberService {
  // opts: { getConfig, appDir, log, gameRunning() -> bool, fetch?(url) -> Promise<Buffer> (tests), now?() }
  constructor(opts) {
    this.opts = opts;
    this.fetch = opts.fetch || ((u) => download(u));
    this.src = { reshade: Object.assign({}, RESHADE, (opts.sources || {}).reshade), d3d8: Object.assign({}, D3D8TO9, (opts.sources || {}).d3d8) };
    this.now = opts.now || (() => new Date());
    this.busy = false; this.lastMessage = '';
  }
  log(m) { if (this.opts.log) this.opts.log('[rubber] ' + m); }
  addonFile() { return path.join(this.opts.appDir, 'beta', 'dynamic-rubber', ADDON); }
  gameDir() { const e = (this.opts.getConfig() || {}).nr2003_exe || ''; return e ? path.resolve(path.dirname(e)) : ''; }

  // everything about the game folder, and what Install would do -> { ok, error, ... , plan: { changes, downloads, confirm, blocker } }
  inspect() {
    const root = this.gameDir();
    const out = { root, ok: false, error: '', running: false, installed: false, enabled: false, addonPath: '', current: false, telemetry: null, d3d8: '', d3d9: '', proxy: false, plan: null, backups: [] };
    if (!root) { out.error = 'Choose NR2003 on the main page first.'; return out; }
    const core = path.join(root, 'core.ini');
    if (!fs.existsSync(path.join(root, 'NR2003.exe')) || !fs.existsSync(core) || !fs.existsSync(path.join(root, 'series'))) { out.error = 'The NR2003 folder needs NR2003.exe, core.ini and the series folder: ' + root; return out; }
    try { out.running = !!(this.opts.gameRunning && this.opts.gameRunning()); } catch (e) { out.running = false; }
    const bundled = readIf(this.addonFile());
    if (!bundled) { out.error = 'This install is missing the rubber add-on (' + this.addonFile() + ').'; return out; }
    const plan = { changes: [], downloads: [], confirm: '', blocker: '' };
    out.plan = plan;
    try {
      // core.ini: the replay telemetry the add-on follows
      const coreBuf = fs.readFileSync(core), ci = new Ini(coreBuf, 'latin1');
      const st = parseInt(ci.get('Replay', 'record_telem_state_a'), 10) || 0;
      out.telemetry = { record_telem: ci.get('Replay', 'record_telem'), state_a: st, ok: ci.get('Replay', 'record_telem') === '1' && (st & 0x3ff) === 0x3ff };
      ci.set('Replay', 'record_telem', '1'); ci.set('Replay', 'record_telem_state_a', String(st | 0x3ff));
      // ReShade's settings: where it lives and where it loads add-ons from (both inside the game folder)
      const rsIniPath = path.join(root, 'ReShade.ini'), rsBuf = readIf(rsIniPath), rsIni = new Ini(rsBuf, 'utf8');
      let base = rsIni.get('INSTALL', 'BasePath') || process.env.RESHADE_BASE_PATH_OVERRIDE || '';
      let baseDir = this._inside(root, base);
      if (!fs.existsSync(baseDir)) baseDir = root;
      const ini2Path = path.join(baseDir, 'ReShade.ini'), ini2Buf = baseDir === root ? rsBuf : readIf(ini2Path), ini2 = baseDir === root ? rsIni : new Ini(ini2Buf, 'utf8');
      out.proxy = ini2.get('PROXY', 'EnableProxyLibrary') === '1' && !!ini2.get('PROXY', 'ProxyLibrary');      // as it is now (before the plan below)
      const addonDir = this._inside(root, path.resolve(baseDir, ini2.get('ADDON', 'AddonPath') || '.'));      // an absolute AddonPath stays absolute
      const addonPath = path.join(addonDir, ADDON), disabledPath = path.join(addonDir, DISABLED);
      out.addonPath = addonPath;
      const have = readIf(addonPath), off = readIf(disabledPath);
      out.installed = !!(have || off); out.enabled = !!have; out.current = !!((have || off) && (have || off).equals(bundled));
      if ((ini2.get('ADDON', 'DisabledAddons') || '').split(',').some(n => n.trim().endsWith('@' + ADDON))) throw new Error('Dynamic Rubber is switched off in ReShade (Add-ons tab). Switch it on there, then try again.');
      // Direct3D 8 -> 9
      const d8p = path.join(root, 'd3d8.dll'), d8 = readIf(d8p);
      if (!d8) { out.d3d8 = 'missing'; plan.downloads.push(this.src.d3d8.name); }
      else if (sha(d8) === this.src.d3d8.hash) out.d3d8 = 'd3d8to9 1.16.0';
      else if (isX86Dll(d8) && verString(d8, 'FileDescription') === 'd3d8to9') out.d3d8 = 'd3d8to9 ' + (fileVersion(d8) || []).slice(0, 3).join('.');
      else throw new Error('Another Direct3D 8 wrapper (d3d8.dll) is installed. It needs a manual ReShade setup, so nothing was changed.');
      // Direct3D 9: ReShade 6.8.0, keeping a DXVK backend behind it
      const d9p = path.join(root, 'd3d9.dll'), d9 = readIf(d9p);
      const needReshade = !d9 || sha(d9) !== this.src.reshade.dll;
      const changes = [];
      if (!d9) out.d3d9 = 'none';
      else if (!needReshade) out.d3d9 = 'ReShade 6.8.0';
      else if (isX86Dll(d9) && verString(d9, 'ProductName') === 'DXVK') {
        out.d3d9 = 'DXVK';
        const proxyPath = path.join(baseDir, DXVK_PROXY), proxy = readIf(proxyPath), pl = ini2.get('PROXY', 'ProxyLibrary');
        if ((proxy && !proxy.equals(d9)) || (ini2.get('PROXY', 'EnableProxyLibrary') === '1' && pl && pl !== DXVK_PROXY)) throw new Error('ReShade is already set to load another graphics library (ReShade.ini [PROXY]). That needs a manual setup.');
        plan.confirm = 'Your DXVK graphics backend (d3d9.dll) will be kept and loaded through ReShade: it is copied to ' + DXVK_PROXY + ' and ReShade.ini gets a [PROXY] entry. The original d3d9.dll is backed up.';
        changes.push({ target: proxyPath, prev: proxy, next: d9 });
        ini2.set('PROXY', 'EnableProxyLibrary', '1'); ini2.set('PROXY', 'ProxyLibrary', DXVK_PROXY);
        changes.push({ target: ini2Path, prev: ini2Buf, next: ini2.bytes() });
      } else {
        const v = fileVersion(d9);
        if (!isX86Dll(d9) || verString(d9, 'ProductName') !== 'ReShade' || verString(d9, 'OriginalFilename').toLowerCase() !== 'reshade32.dll' || !v || !verLE(v, [6, 8, 0])) throw new Error('A custom or newer d3d9.dll is installed. That graphics setup needs a manual ReShade install, so nothing was changed.');
        out.d3d9 = 'ReShade ' + v.slice(0, 3).join('.');
        plan.confirm = 'ReShade ' + v.slice(0, 3).join('.') + ' (d3d9.dll) will be replaced by ReShade 6.8.0 with full add-on support. Your ReShade settings and presets stay; the old d3d9.dll is backed up.';
      }
      if (needReshade) plan.downloads.push(this.src.reshade.name);
      plan.d3d8Missing = !d8; plan.needReshade = needReshade;
      // the add-on and core.ini
      const coreNext = ci.bytes();
      plan.coreNext = coreNext; plan.corePrev = coreBuf;
      plan.addonTarget = out.enabled || !out.installed ? addonPath : null;
      plan.changesFixed = changes;
      plan.changes = changes.map(c => this._rel(root, c.target)).concat(
        !d8 ? ['d3d8.dll (d3d8to9 1.16.0)'] : [], needReshade ? ['d3d9.dll (ReShade 6.8.0)'] : [],
        !coreBuf.equals(coreNext) ? ['core.ini ([Replay] telemetry on)'] : [],
        plan.addonTarget && !(have && have.equals(bundled)) ? [this._rel(root, addonPath)] : []);
      if (out.installed && !out.enabled) plan.changes = plan.changes.filter(x => !/addon32$/.test(x));
    } catch (e) { plan.blocker = e.message; }
    out.backups = this.backups(root);
    out.ok = true;
    return out;
  }
  _inside(root, p) {
    const full = path.resolve(root, p || '').replace(/[\\/]+$/, '');
    if (full.toLowerCase() !== root.toLowerCase() && !full.toLowerCase().startsWith(root.toLowerCase() + path.sep)) throw new Error('ReShade is set up to use a shared folder outside NR2003 (' + full + '). Install the add-on there by hand.');
    return full;
  }
  _rel(root, p) { return path.relative(root, p) || path.basename(p); }

  state() {
    const s = this.inspect();
    const p = s.plan || {};
    return { root: s.root, ok: s.ok, error: s.error, running: s.running, installed: s.installed, enabled: s.enabled, current: s.current, addonPath: s.addonPath,
      telemetry: s.telemetry, d3d8: s.d3d8, d3d9: s.d3d9, proxy: s.proxy, backups: s.backups, busy: this.busy, message: this.lastMessage,
      plan: { changes: p.changes || [], downloads: p.downloads || [], confirm: p.confirm || '', blocker: p.blocker || '' } };
  }

  // Install (confirmed = the user agreed to the graphics change when plan.confirm asked) -> { ok, message }
  async install(confirmed) {
    if (this.busy) return { ok: false, message: 'Already working.' };
    this.busy = true;
    try {
      const s = this.inspect();
      if (!s.ok) return this._done(false, s.error);
      if (s.running) return this._done(false, 'Close NR2003, then install.');
      const p = s.plan;
      if (p.blocker) return this._done(false, p.blocker);
      if (p.confirm && !confirmed) return this._done(false, 'Not confirmed: ' + p.confirm);
      const root = s.root, changes = p.changesFixed.slice();
      if (p.d3d8Missing) changes.push({ target: path.join(root, 'd3d8.dll'), prev: null, next: await this._get(this.src.d3d8.url, this.src.d3d8.hash, this.src.d3d8.name) });
      if (p.needReshade) {
        const exe = await this._get(this.src.reshade.url, this.src.reshade.archive, this.src.reshade.name);
        const dll = reshadeFromSetup(exe);
        if (!dll) return this._done(false, "The official ReShade download is missing its 32-bit runtime.");
        if (sha(dll) !== this.src.reshade.dll) return this._done(false, "ReShade's 32-bit runtime did not pass the download integrity check.");
        changes.push({ target: path.join(root, 'd3d9.dll'), prev: readIf(path.join(root, 'd3d9.dll')), next: dll });
      }
      changes.push({ target: path.join(root, 'core.ini'), prev: p.corePrev, next: p.coreNext });
      if (p.addonTarget) changes.push({ target: p.addonTarget, prev: readIf(p.addonTarget), next: fs.readFileSync(this.addonFile()) });
      const real = changes.filter(c => !c.prev || !c.prev.equals(c.next));
      if (!real.length) return this._done(true, 'Dynamic Rubber is already installed. Start NR2003 as usual.');
      if (this.opts.gameRunning && this.opts.gameRunning()) return this._done(false, 'Close NR2003, then install.');
      const dir = this._apply(root, real);
      this.log('installed: ' + real.map(c => this._rel(root, c.target)).join(', ') + ' (backups in ' + dir + ')');
      return this._done(true, 'Installed. Start NR2003 as usual and watch the front bumper, hood edge and lower sides as the laps go by. Backups: ' + this._rel(root, dir));
    } catch (e) {
      return this._done(false, e.message);
    } finally { this.busy = false; }
  }
  async _get(url, hash, name) {
    this.lastMessage = 'Downloading ' + name + ' from its official page...';
    let b;
    try { b = await this.fetch(url); } catch (e) { throw new Error('Could not download ' + name + ' (' + e.message + '). Check the connection and try again.'); }
    if (sha(b) !== hash) throw new Error(name + ' did not pass the download integrity check.');
    return b;
  }
  _done(ok, message) { this.lastMessage = message; return { ok, message }; }

  // write everything or nothing: stage each file, then swap them in with the old copies in a new backup folder (the setup's record format)
  _apply(root, changes) {
    const tag = crypto.randomBytes(4).toString('hex');
    const ts = this.now(); const pad = (n) => String(n).padStart(2, '0');
    const dir = path.join(root, BACKUPS, `${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}-${tag}`);
    const done = [];
    try {
      for (const c of changes) {
        fs.mkdirSync(path.dirname(c.target), { recursive: true });
        const now = readIf(c.target);
        if ((now === null) !== (c.prev === null) || (now && !now.equals(c.prev))) throw new Error(path.basename(c.target) + ' changed while installing. Close NR2003 and try again.');
        c.stage = c.target + '.' + tag + '.tmp';
        fs.writeFileSync(c.stage, c.next, { flag: 'wx' });
      }
      fs.mkdirSync(dir, { recursive: true });
      for (const c of changes) {
        if (c.prev) { c.backup = path.join(dir, path.basename(c.target)); fs.copyFileSync(c.target, c.backup); }
        fs.renameSync(c.stage, c.target); c.stage = null;
        done.push(c);
      }
      fs.writeFileSync(path.join(dir, RECORD), changes.map(c => (c.backup ? 'Updated ' : 'Added   ') + path.relative(root, c.target)).join('\r\n') + '\r\n');
      return dir;
    } catch (e) {
      const stuck = [];
      for (const c of done.reverse()) { try { if (c.backup) fs.copyFileSync(c.backup, c.target); else fs.rmSync(c.target, { force: true }); } catch (err) { stuck.push(c.target); } }
      if (stuck.length) throw new Error('Could not put back ' + stuck.join(', ') + '. The old copies are in ' + dir + '. (' + e.message + ')');
      throw e;
    } finally { for (const c of changes) if (c.stage) { try { fs.rmSync(c.stage, { force: true }); } catch (e) { /* ignore */ } } }
  }

  // on / off: the add-on renamed (.addon32 = on, .disabled = off), as the setup's read me describes
  setEnabled(on) {
    const s = this.inspect();
    if (!s.ok) return { ok: false, message: s.error };
    if (s.running) return { ok: false, message: 'Close NR2003 first.' };
    if (!s.installed) return { ok: false, message: 'Install Dynamic Rubber first.' };
    const a = s.addonPath, d = path.join(path.dirname(a), DISABLED);
    try {
      if (on && !fs.existsSync(a)) fs.renameSync(d, a);
      if (!on && fs.existsSync(a)) { fs.rmSync(d, { force: true }); fs.renameSync(a, d); }
    } catch (e) { return { ok: false, message: e.message }; }
    this.log(on ? 'switched on' : 'switched off');
    return { ok: true, message: on ? 'Dynamic Rubber is on.' : 'Dynamic Rubber is off (the add-on is renamed to ' + DISABLED + ').' };
  }

  // the install backups (newest first): { name, added, updated }
  backups(root = this.gameDir()) {
    const base = path.join(root, BACKUPS);
    let names = [];
    try { names = fs.readdirSync(base).filter(n => fs.existsSync(path.join(base, n, RECORD))).sort().reverse(); } catch (e) { return []; }
    return names.map(n => {
      const lines = fs.readFileSync(path.join(base, n, RECORD), 'utf8').split(/\r?\n/).filter(Boolean);
      return { name: n, added: lines.filter(l => l.startsWith('Added')).map(l => l.slice(8).trim()), updated: lines.filter(l => l.startsWith('Updated')).map(l => l.slice(8).trim()) };
    });
  }
  // Restore an install (the newest by default): added files removed, updated ones put back - except core.ini, where only the two replay
  // telemetry values go back (game settings changed since then are kept), as the setup's read me advises
  restore(name) {
    const root = this.gameDir();
    if (this.opts.gameRunning && this.opts.gameRunning()) return { ok: false, message: 'Close NR2003 first.' };
    const b = this.backups(root).find(x => !name || x.name === name);
    if (!b) return { ok: false, message: 'No Dynamic Rubber install to undo.' };
    const dir = path.join(root, BACKUPS, b.name), failed = [];
    for (const rel of b.added) {
      const t = path.join(root, rel);
      try { fs.rmSync(t, { force: true }); if (/\.addon32$/i.test(t)) fs.rmSync(path.join(path.dirname(t), DISABLED), { force: true }); } catch (e) { failed.push(rel); }
    }
    for (const rel of b.updated) {
      const t = path.join(root, rel), old = path.join(dir, path.basename(rel));
      try {
        if (path.basename(rel).toLowerCase() === 'core.ini') {
          const was = new Ini(fs.readFileSync(old), 'latin1'), cur = new Ini(fs.readFileSync(t), 'latin1');
          for (const k of ['record_telem', 'record_telem_state_a']) { const v = was.get('Replay', k); if (v !== '') cur.set('Replay', k, v); }
          fs.writeFileSync(t, cur.bytes());
        } else fs.copyFileSync(old, t);
      } catch (e) { failed.push(rel); }
    }
    try { fs.renameSync(dir, dir + ' (restored)'); } catch (e) { /* keep it */ }
    this.log('restored ' + b.name + (failed.length ? ' - could not restore ' + failed.join(', ') : ''));
    return failed.length ? { ok: false, message: 'Could not restore ' + failed.join(', ') + '. The old copies are in ' + dir + '.' } : { ok: true, message: 'Undone: ' + b.added.length + ' file(s) removed, ' + b.updated.length + ' put back.' };
  }

  registerIpc({ ipcMain }) {
    ipcMain.handle('rubber:state', () => this.state());
    ipcMain.handle('rubber:install', (e, confirmed) => this.install(!!confirmed));
    ipcMain.handle('rubber:enable', (e, on) => this.setEnabled(!!on));
    ipcMain.handle('rubber:restore', (e, name) => this.restore(name));
  }
}

module.exports = { RubberService, Ini, isX86Dll, verString, fileVersion, reshadeFromSetup, sha, ADDON, DISABLED, BACKUPS, RECORD, DXVK_PROXY, RESHADE, D3D8TO9 };
