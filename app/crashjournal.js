// Crash journal — a flight recorder for the built-in RaceControl and AIMOD.
//
// NR2003 sometimes disappears without a Windows crash report. This keeps the last few hundred memory writes All In One NR2003 made to
// the game (who, where, what) and the last log lines of both services, in one time-ordered ring, and writes them to
// <userData>\crash-journal-<time>.txt as soon as the game goes away, so the moments before it died can be read afterwards.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX = 800;
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

class CrashJournal {
  constructor() { this.dir = ''; this.ring = []; this.timer = null; this.gone = []; this.lastDump = 0; this.dumps = []; this.last = new Map(); }
  setDir(dir) { this.dir = dir; }

  _push(e) { e.t = Date.now(); this.ring.push(e); if (this.ring.length > MAX) this.ring.shift(); }
  // a write that puts the same bytes where this service last put them changes nothing: it is not recorded (AIMOD re-writes the same pit
  // plan every tick, which used to push everything else out of the ring)
  write(tag, addr, bytes, ok) {
    const hex = Buffer.from(bytes).subarray(0, 16).toString('hex'), key = tag + ':' + addr;
    if (ok !== false && this.last.get(key) === hex) return;
    if (this.last.size > 20000) this.last.clear();
    this.last.set(key, hex);
    this._push({ k: 'w', tag, addr, hex, len: bytes.length, ok: ok !== false });
  }
  text(tag, msg) { this._push({ k: 't', tag, msg: String(msg) }); }

  // a service saw NR2003 disappear; several services see it within a moment, so they share one dump
  gameGone(source, note) {
    this.gone.push(`${source}: ${note || 'NR2003 went away'}`);
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; const why = this.gone.join('; '); this.gone = []; this.dump(why); }, 1500);
    if (this.timer.unref) this.timer.unref();
  }

  format(reason) {
    const lines = [`All In One NR2003 crash journal — ${new Date().toString()}`, `reason: ${reason}`, `${this.ring.length} most recent events, oldest first (RC = RaceControl, AIMOD = AIMOD pit strategy)`, ''];
    for (const e of this.ring) {
      const t = stamp(new Date(e.t));
      lines.push(e.k === 'w' ? `${t}  ${e.tag.padEnd(5)} write 0x${e.addr.toString(16).toUpperCase()} len ${e.len} = ${e.hex}${e.ok ? '' : '  (FAILED)'}` : `${t}  ${e.tag.padEnd(5)} ${e.msg}`);
    }
    return lines.join('\n') + '\n';
  }

  dump(reason) {
    if (!this.dir || !this.ring.length) return '';
    try {
      const d = new Date();
      const file = path.join(this.dir, `crash-journal-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`);
      fs.writeFileSync(file, this.format(reason));
      this.dumps.push(file);
      // keep the newest 10
      const all = fs.readdirSync(this.dir).filter(f => /^crash-journal-.*\.txt$/.test(f)).sort();
      for (const f of all.slice(0, Math.max(0, all.length - 10))) { try { fs.unlinkSync(path.join(this.dir, f)); } catch (e) { /* ignore */ } }
      this.ring = []; this.last.clear();               // the next game starts a fresh record
      return file;
    } catch (e) { return ''; }
  }
}

module.exports = { CrashJournal, journal: new CrashJournal() };
