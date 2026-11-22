'use strict';

const fs = require('fs');
const path = require('path');
const gameExe = require('../gameexe');   // the game's process names (RaceLab's builds too)
const { Win32Memory } = require('../ai/memory');

const MAP_SIZE = 0xB2B10, FILE_MAP_ALL_ACCESS = 0xF001F;
const MAGIC = 0x3243524E, VERSION = 0x412, BUILD = 0x2DE586C4;
const MODE = { figgy: 0x1, playerPhysics: 0x4, pro: 0x80, betterDamage: 0x800 };
const OFF = { flags: 0x08, heartbeat: 0x0C, status: 0x10, figgySpeed: 0x34, playerSpeed: 0x40, standardCap: 0x44,
  standardForce: 0x4C, playerForce: 0x50, proSpeed: 0x68, proAngle: 0x6C, proMultipliers: 0x70,
  pitchDelay: 0x98, rollDelay: 0x9C, hover: 0xA0, proCap: 0xB4, skippedLaps: 0x18, activeFlips: 0x2C };
const DEFAULT = Object.freeze({ controlEnabled: false, figgyEnabled: false, playerPhysicsEnabled: false, proEnabled: false, betterDamageEnabled: false,
  figgyTakeoffSpeed: 180, playerTakeoffSpeed: 180, proTakeoffSpeed: 180, standardMaxCars: 1, proMaxCars: 3,
  figgyForce: 1, playerForce: 1, proTakeoffAngle: 180,
  pro: { initial_spin_decay: 1, lift: 1, pitch: 1, roll: 1, speed_decay: 1, pitch_decay: 1, roll_decay: 1, pitch_delay_ms: 0, roll_delay_ms: 0, hover_time_ms: 0 } });
const clamp = (v, lo, hi, d) => Number.isFinite(Number(v)) ? Math.max(lo, Math.min(hi, Number(v))) : d;

class WindTunnelControl {
  constructor({ userData, getConfig, guiRunning = () => false } = {}) {
    this.file = path.join(userData, 'windtunnel', 'control.json'); this.getConfig = getConfig; this.guiRunning = guiRunning;
    this.settings = this._load(); this.timer = null; this.pid = 0; this.mapHandle = null; this.view = null; this.memory = null; this.error = ''; this.mapBaseline = null;
    this._k = null; this.lastState = { connected: false, message: 'Waiting for Wind Tunnel Deluxe to connect to NR2003.' };
  }

  _load() { try { const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')); return this._normalize(raw); } catch (e) { return this._normalize({}); } }
  _normalize(raw) {
    const s = raw && typeof raw === 'object' ? raw : {}, p = Object.assign({}, DEFAULT.pro, s.pro || {});
    for (const k of Object.keys(p)) p[k] = k.endsWith('_ms') ? clamp(p[k], 0, k === 'hover_time_ms' ? 2000 : 1000, DEFAULT.pro[k]) : clamp(p[k], 0, 5, DEFAULT.pro[k]);
    return { controlEnabled: !!s.controlEnabled, figgyEnabled: !!s.figgyEnabled, playerPhysicsEnabled: !!s.playerPhysicsEnabled, proEnabled: !!s.proEnabled, betterDamageEnabled: !!s.betterDamageEnabled,
      figgyTakeoffSpeed: Math.round(clamp(s.figgyTakeoffSpeed, 0, 360, DEFAULT.figgyTakeoffSpeed)), playerTakeoffSpeed: Math.round(clamp(s.playerTakeoffSpeed, 0, 360, DEFAULT.playerTakeoffSpeed)),
      proTakeoffSpeed: Math.round(clamp(s.proTakeoffSpeed, 0, 360, DEFAULT.proTakeoffSpeed)), standardMaxCars: Math.round(clamp(s.standardMaxCars, 0, 47, DEFAULT.standardMaxCars)),
      proMaxCars: Math.round(clamp(s.proMaxCars, 0, 47, DEFAULT.proMaxCars)), figgyForce: clamp(s.figgyForce, 0, 3, DEFAULT.figgyForce), playerForce: clamp(s.playerForce, 0, 3, DEFAULT.playerForce),
      proTakeoffAngle: Math.round(clamp(s.proTakeoffAngle, 0, 180, DEFAULT.proTakeoffAngle)), pro: p };
  }

  _bindings() {
    if (this._k) return this._k;
    const koffi = require('koffi'), k32 = koffi.load('kernel32.dll');
    this._k = { koffi,
      OpenFileMappingW: k32.func('void *OpenFileMappingW(uint32 access, bool inherit, const char16_t *name)'),
      MapViewOfFile: k32.func('void *MapViewOfFile(void *mapping, uint32 access, uint32 offsetHigh, uint32 offsetLow, size_t bytes)'),
      UnmapViewOfFile: k32.func('bool UnmapViewOfFile(void *address)'), CloseHandle: k32.func('bool CloseHandle(void *handle)'),
      InterlockedExchange: k32.func('int32_t InterlockedExchange(int32_t *target, int32_t value)'),
      GetTickCount: k32.func('uint32_t GetTickCount(void)'),
    };
    return this._k;
  }

  _closeMap() {
    if (!this._k) return;
    this._restoreMap();
    try { if (this.view) this._k.UnmapViewOfFile(this.view); } catch (e) { /* mapping can close with NR2003 */ }
    try { if (this.mapHandle) this._k.CloseHandle(this.mapHandle); } catch (e) { /* ignore */ }
    this.view = null; this.mapHandle = null; this.pid = 0; this.mapBaseline = null;
  }

  _open() {
    const exe = this.getConfig()?.nr2003_exe || 'NR2003.exe';
    if (!this.memory) this.memory = new Win32Memory(() => gameExe.names(this.getConfig()), () => this.getConfig()?.nr2003_exe || '');
    const pid = this.memory.findPid();
    if (!pid) { this._closeMap(); return false; }
    if (pid === this.pid && this.view) return true;
    this._closeMap();
    const k = this._bindings(), name = `Local\\NR2003Companion.v2.${pid}`;
    const h = k.OpenFileMappingW(FILE_MAP_ALL_ACCESS, false, name);
    if (!h) return false;
    const v = k.MapViewOfFile(h, FILE_MAP_ALL_ACCESS, 0, 0, MAP_SIZE);
    if (!v) { k.CloseHandle(h); return false; }
    this.mapHandle = h; this.view = v; this.pid = pid;
    if (this._read(0x00) !== MAGIC || this._read(0x04) !== VERSION || this._read(0x5C) !== BUILD) { this._closeMap(); this.error = 'Wind Tunnel shared-memory build marker did not match.'; return false; }
    this.error = '';
    return true;
  }

  _read(offset) { try { return this._k.koffi.decode(this.view, offset, 'uint32'); } catch (e) { return null; } }
  _write(offset, value) {
    const k = this._bindings(), ptr = k.koffi.as(k.koffi.address(this.view) + BigInt(offset), 'int32_t *');
    return k.InterlockedExchange(ptr, Number(value) | 0);
  }
  _snapshotMap() {
    const b = { flags: this._read(OFF.flags), figgySpeed: this._read(OFF.figgySpeed), playerSpeed: this._read(OFF.playerSpeed), standardCap: this._read(OFF.standardCap),
      standardForce: this._read(OFF.standardForce), playerForce: this._read(OFF.playerForce), proSpeed: this._read(OFF.proSpeed), proAngle: this._read(OFF.proAngle),
      proMultipliers: Array.from({ length: 7 }, (_, i) => this._read(OFF.proMultipliers + i * 4)), pitchDelay: this._read(OFF.pitchDelay), rollDelay: this._read(OFF.rollDelay),
      hover: this._read(OFF.hover), proCap: this._read(OFF.proCap) };
    return Object.values(b).some(v => v === null) || b.proMultipliers.some(v => v === null) ? null : b;
  }
  _restoreMap() {
    const b = this.mapBaseline;
    if (!b || !this.view) return;
    try {
      for (const k of ['figgySpeed', 'playerSpeed', 'standardCap', 'standardForce', 'playerForce', 'proSpeed', 'proAngle', 'pitchDelay', 'rollDelay', 'hover', 'proCap']) this._write(OFF[k], b[k]);
      b.proMultipliers.forEach((v, i) => this._write(OFF.proMultipliers + i * 4, v)); this._write(OFF.flags, b.flags);
    } catch (e) { /* game may be shutting down */ }
    this.mapBaseline = null;
  }
  _apply() {
    if (!this.view || !this.settings.controlEnabled) return false;
    if (!this.mapBaseline) this.mapBaseline = this._snapshotMap();
    if (!this.mapBaseline) return false;
    const s = this.settings, bitMask = MODE.figgy | MODE.playerPhysics | MODE.pro | MODE.betterDamage;
    const currentFlags = this._read(OFF.flags); if (currentFlags === null) return false;
    let flags = currentFlags;
    flags &= ~bitMask;
    if (s.figgyEnabled) flags |= MODE.figgy;
    if (s.playerPhysicsEnabled) flags |= MODE.playerPhysics;
    if (s.proEnabled) flags |= MODE.pro;
    if (s.betterDamageEnabled) flags |= MODE.betterDamage;
    this._write(OFF.flags, flags);
    this._write(OFF.figgySpeed, s.figgyTakeoffSpeed); this._write(OFF.playerSpeed, s.playerTakeoffSpeed);
    this._write(OFF.standardCap, s.standardMaxCars); this._write(OFF.proCap, s.proMaxCars);
    this._write(OFF.standardForce, Math.round(s.figgyForce * 100)); this._write(OFF.playerForce, Math.round(s.playerForce * 100));
    this._write(OFF.proSpeed, s.proTakeoffSpeed); this._write(OFF.proAngle, s.proTakeoffAngle);
    const order = ['initial_spin_decay', 'lift', 'pitch', 'roll', 'speed_decay', 'pitch_decay', 'roll_decay'];
    order.forEach((name, i) => this._write(OFF.proMultipliers + i * 4, Math.round(s.pro[name] * 100)));
    this._write(OFF.pitchDelay, s.pro.pitch_delay_ms); this._write(OFF.rollDelay, s.pro.roll_delay_ms); this._write(OFF.hover, s.pro.hover_time_ms);
    return true;
  }

  tick() {
    try {
      const connected = this._open();
      if (!connected) { this.lastState = { connected: false, error: this.error, settings: this.settings, controlEnabled: this.settings.controlEnabled, message: this.error || 'Start Wind Tunnel Deluxe and connect it to NR2003 to enable native physics controls.' }; return this.lastState; }
      if (this.settings.controlEnabled) {
        const applied = this._apply();
        if (applied && !this.guiRunning()) this._write(OFF.heartbeat, this._bindings().GetTickCount());
      }
      const flags = this._read(OFF.flags) || 0, status = this._read(OFF.status) || 0;
      this.lastState = { connected: true, pid: this.pid, controlEnabled: this.settings.controlEnabled, settings: this.settings,
        modes: { figgy: !!(flags & MODE.figgy), playerPhysics: !!(flags & MODE.playerPhysics), pro: !!(flags & MODE.pro), betterDamage: !!(flags & MODE.betterDamage), director: !!(flags & 0x8000) },
        status, skippedLaps: this._read(OFF.skippedLaps) || 0, activeFlips: this._read(OFF.activeFlips) || 0, message: 'Wind Tunnel runtime connected.' };
      return this.lastState;
    } catch (e) { this.error = String(e && e.message || e); this.lastState = { connected: false, error: this.error, message: this.error }; return this.lastState; }
  }

  setSettings(patch) {
    const wasControlling = this.settings.controlEnabled;
    if (wasControlling && patch && patch.controlEnabled === false) this._restoreMap();
    const p = patch && typeof patch === 'object' ? patch : {}, next = Object.assign({}, this.settings, p, { pro: Object.assign({}, this.settings.pro, p.pro || {}) });
    this.settings = this._normalize(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file, JSON.stringify(this.settings, null, 2), 'utf8');
    if (this.view && this.settings.controlEnabled) this._apply();
    return this.tick();
  }

  start() { if (this.timer) return; this.timer = setInterval(() => this.tick(), 500); if (this.timer.unref) this.timer.unref(); }
  stop() { clearInterval(this.timer); this.timer = null; this._restoreMap(); this._closeMap(); try { this.memory?.detach(); } catch (e) { /* game may be closed */ } }
}

module.exports = { WindTunnelControl, DEFAULT, OFF, MODE, MAP_SIZE, MAGIC, VERSION, BUILD };
