// What the qualifying graphics show (RaceControl 1.2.0 beta 2's QualBoxNow / SingleBox / BroadcastNow / TrackHeld): the timing box (pole on
// top, the car on its run below with its live gap to pole at that point of the lap, its lap at the line held for a few seconds, or
// OUT LAP / IN LAP) and the broadcast panel (telemetry of the car on its run, its laps, the running order). The overlay windows draw
// these plain objects.
'use strict';
const { fx } = require('./format');
const { Qualifying, LapFmt, BoxShow } = require('./qualifying');
const { QualTiming } = require('./qualtiming');

const HOLD_SECONDS = 4.0;
const QCar = c => c === 0 || c >= 2;
// "+0.000;-0.000;0.000"
const signed = v => (v > 0 ? '+' + fx(v / 1000.0, 3) : v < 0 ? '-' + fx(Math.abs(v) / 1000.0, 3) : '0.000');
const trackOf = (s) => { const t = String(s || '').trim(); return (t.includes('_') ? t.slice(0, t.indexOf('_')) : t).toUpperCase(); };

class QualBoxModel {
  constructor(opts) {
    this.now = (opts && opts.now) || (() => Date.now());
    this.reset();
  }
  reset() {
    this.heldCar = -1; this.heldStamp = 0; this.heldLapMs = 0; this.heldDiffMs = 0; this.heldPos = 0;
    this.thrPeak = new Map(); this.brkPeak = new Map(); this.rpmTop = new Map();
    this.orderCar = -2; this.orderLapStart = -2; this.orderUntil = 0;
  }

  // the lap a car just finished is held on the box for a few seconds, with where it put the car
  trackHeld(qual) {
    for (const [slot, v] of qual.Timing.All) {
      if (v.LastLapMs > 0 && !(v.LastLapAt <= this.heldStamp)) {
        this.heldStamp = v.LastLapAt;
        this.heldCar = slot;
        this.heldLapMs = v.LastLapMs;
        const others = qual.LiveBoard.filter(x => x[0] !== slot).map(x => x[1]);
        this.heldDiffMs = others.length > 0 ? this.heldLapMs - Math.min(...others) : 0;
        this.heldPos = 1 + others.filter(ms => ms < this.heldLapMs).length;
      }
    }
  }

  held() { return this.heldCar >= 0 ? { car: this.heldCar } : null; }

  _base(qual) {
    const d = { Header: qual.LiveHeader, PoleNum: -1, PoleName: '', PoleTime: '', CarNum: -1, CarName: '', CarPos: '--', Right: '', Projected: '', Mode: 0, Faster: false };
    const board = qual.LiveBoard;
    const pole = board.length > 0 ? board[0][0] : -1;
    const poleMs = board.length > 0 ? board[0][1] : 0;
    if (pole >= 0) { d.PoleNum = qual.CarNumber(pole); d.PoleName = qual.LastName(pole); d.PoleTime = LapFmt.Lap(poleMs); }
    return { d, pole, poleMs };
  }

  _heldBox(d, qual) {
    d.CarNum = qual.CarNumber(this.heldCar); d.CarName = qual.LastName(this.heldCar); d.CarPos = this.heldPos + '.';
    d.Projected = LapFmt.Lap(this.heldLapMs); d.Right = signed(this.heldDiffMs); d.Mode = 2; d.Faster = this.heldDiffMs <= 0;
    return d;
  }

  // single car runs and the Indy oval: the box follows the run the game's TV is not necessarily showing
  _singleBox(d, qual, tv, pole, poleMs) {
    let car = qual.BoxCar, kind = qual.BoxKind;
    if (kind !== BoxShow.Result && QCar(tv) && tv !== car && qual.OnTimedLap(tv)) { car = tv; kind = BoxShow.Live; }
    if (!QCar(car) || kind === BoxShow.None) return d;
    d.CarNum = qual.CarNumber(car); d.CarName = qual.LastName(car); d.CarPos = '--';
    if (kind === BoxShow.Result) {
      d.CarPos = qual.ResultPos + '.';
      if (qual.ResultHasDiff) { d.Projected = LapFmt.Lap(qual.ResultBestMs); d.Right = signed(qual.ResultDiffMs); d.Mode = 2; d.Faster = qual.ResultDiffMs <= 0; }
      else { d.Right = LapFmt.Lap(qual.ResultBestMs); d.Mode = 1; }
    } else if (kind === BoxShow.Live && car === qual.BoxCar && qual.BoxLapMs > 0 && qual.BoxLapAge < 4.0) {
      if (pole >= 0) { d.Projected = LapFmt.Lap(qual.BoxLapMs); d.Right = signed(qual.BoxLapMs - poleMs); d.Mode = 2; d.Faster = qual.BoxLapMs <= poleMs; }
      else { d.Right = LapFmt.Lap(qual.BoxLapMs); d.Mode = 1; }
    } else {
      const delta = (kind === BoxShow.Live && pole >= 0) ? qual.Timing.Delta(car, pole, poleMs) : null;
      if (delta !== null) { d.Right = signed(delta); d.Mode = 2; d.Faster = delta <= 0; }
      else { d.Right = '-.--'; d.Mode = 0; }
    }
    return d;
  }

  // -> null when the box has nothing to show (qualifying is not live)
  data(qual, mem) {
    if (!qual.LiveOn) { this.heldCar = -1; return null; }
    this.trackHeld(qual);
    try { LapFmt.TrackM = LapFmt.OfficialLen > 0.0 ? LapFmt.OfficialLen : mem.F64(14339852); } catch (e) { /* keep the last */ }
    const { d, pole, poleMs } = this._base(qual);
    const tv = QualTiming.Focus(mem);
    if (qual.SingleRuns) return this._singleBox(d, qual, tv, pole, poleMs);
    const car = tv;
    const t = QCar(car) ? qual.Timing.Of(car) : null;
    const elapsed = t ? qual.Timing.Elapsed(car) : -1;
    const holding = this.heldCar === car && (this.now() - this.heldStamp) / 1000.0 < HOLD_SECONDS;
    const since = (this.now() - this.heldStamp) / 1000.0;
    const heldOut = QCar(this.heldCar) && !qual.ActiveRunners.includes(this.heldCar);
    const waiting = qual.SingleRuns && QCar(car) && car !== this.heldCar && tv === car && qual.ActiveRunners.includes(car) && elapsed < 0;
    if (heldOut && (since < 4.0 || (elapsed < 0 && !waiting))) return this._heldBox(d, qual);
    if (elapsed >= 0 && !holding) {
      d.CarNum = qual.CarNumber(car); d.CarName = qual.LastName(car); d.CarPos = '--'; d.Projected = '';
      const delta = pole >= 0 ? qual.Timing.Delta(car, pole, poleMs) : null;
      if (delta !== null) { d.Right = signed(delta); d.Mode = 2; d.Faster = delta <= 0; }
      else { d.Right = ''; d.Mode = 0; }
      return d;
    }
    if (waiting) { d.CarNum = qual.CarNumber(car); d.CarName = qual.LastName(car); d.CarPos = '--'; d.Projected = ''; d.Right = ''; d.Mode = 0; return d; }
    if (QCar(this.heldCar) && (qual.SingleRuns || this.heldCar === car)) return this._heldBox(d, qual);
    if (t) {
      d.CarNum = qual.CarNumber(car); d.CarName = qual.LastName(car);
      d.Right = QualTiming.InLap.has(t.State) ? 'IN LAP' : 'OUT LAP'; d.Mode = 0;
    }
    return d;
  }

  // the broadcast panel (telemetry + laps + order); null when nothing is live
  broadcast(qual, mem) {
    if (!qual.LiveOn) return null;
    const out = { Track: '', Session: 'QUALIFYING', Num: -1, First: '', Last: '', Tele: false, Mph: 0, Rpm: 0, RpmTop: 9000, Throttle: 0, Brake: -1, Gear: 0,
      LapNo: 0, LapsTotal: qual.Laps, Current: '', LastLap: '', BestLap: '', LapRows: [], Ahead: true, Order: [], ShowOrder: true };
    out.Track = trackOf(mem.Str(14348560, 64));
    const focus = QualTiming.Focus(mem);
    let car = qual.SingleRuns ? qual.BoxCar : focus;
    if (qual.SingleRuns && qual.BoxKind !== BoxShow.Result && QCar(focus) && focus !== car && qual.OnTimedLap(focus)) car = focus;
    const board = qual.LiveBoard;
    const pole = board.length > 0 ? board[0][0] : -1;
    const poleMs = board.length > 0 ? board[0][1] : 0;
    const list = qual.SingleRuns ? qual.OrderView() : board.map(e => [e[0], e[1], 'f']);
    const li = list.findIndex(v => v[2] === 'l');
    let shown = list.slice(0, 10);
    if (li >= 10) shown = list.slice(0, 7).concat(list.slice(li, li + 3));
    let nFinished = 0;
    for (const item of list) {
      if (item[2] === 'f') nFinished++;
      if (shown.includes(item)) {
        const el = item[2] === 'l' ? qual.Timing.Elapsed(item[0]) : -1;
        out.Order.push([
          item[2] === 'f' ? String(nFinished) : '',
          qual.FirstName(item[0]),
          qual.LastName(item[0]),
          item[2] !== 'f' ? (item[2] !== 'l' ? '' : (el >= 0 ? LapFmt.Time(el) : 'OUT LAP')) : (item[1] > 0 ? LapFmt.Lap(item[1]) : 'NO TIME'),
          item[2],
          Qualifying.Label(qual.CarNumber(item[0])),          // RaceControl 2.0: the car number, for the overlay feed
        ]);
      }
    }
    const live = qual.SingleRuns ? qual.BoxKind === BoxShow.Live : QCar(car);
    const t = QCar(car) ? qual.Timing.Of(car) : null;
    const now = this.now();
    if (t && (car !== this.orderCar || t.LapStart !== this.orderLapStart)) {
      if (car === this.orderCar && t.LapStart >= 0) this.orderUntil = now + 6000;
      this.orderCar = car; this.orderLapStart = t.LapStart;
    }
    out.ShowOrder = !live || now < this.orderUntil;
    if (!QCar(car)) return out;
    out.Num = qual.CarNumber(car); out.First = qual.FirstName(car); out.Last = qual.LastName(car);
    const rec = 12656688 + car * 5560, blk = 11323952 + car * 8724;
    const vx = mem.F32(blk + 6634), vy = mem.F32(blk + 6638);
    out.Mph = Math.fround(Math.sqrt(vx * vx + vy * vy) * 2.2369363);
    out.Rpm = mem.F32(rec + 5384);
    const thr = mem.U8(rec + 1540) / 255, brk = mem.U8(rec + 1541);
    let tp = this.thrPeak.get(car) || 0;
    if (thr > tp) { tp = thr; this.thrPeak.set(car, tp); }
    out.Throttle = Math.max(0, Math.min(1, thr / Math.max(0.85, tp)));
    let bp = this.brkPeak.get(car) || 0;
    if (brk > bp) { bp = brk; this.brkPeak.set(car, bp); }
    out.Brake = out.Throttle >= 0.5 ? 0 : Math.max(0, Math.min(1, (brk - 4) / Math.max(16, bp - 4)));
    const gear = mem.U8(blk + 6390);
    out.Gear = gear <= 10 ? gear - 1 : 0;
    out.Tele = out.Mph >= 0 && out.Mph < 400 && out.Rpm >= 0 && out.Rpm < 30000;
    let rt = this.rpmTop.get(car) || 0;
    if (out.Tele && out.Rpm > rt) { rt = out.Rpm; this.rpmTop.set(car, rt); }
    out.RpmTop = Math.max(6000, rt);
    const rv = qual.RunView(car);
    if (rv) {
      out.LapNo = rv.lapNo;
      out.LapRows = rv.lapMs.map(ms => LapFmt.Lap(ms));
      if (rv.lapMs.length > 0) { out.LastLap = LapFmt.Lap(rv.lapMs[rv.lapMs.length - 1]); out.BestLap = LapFmt.Lap(Math.min(...rv.lapMs)); }
    } else if (t) {
      out.LapNo = 1; out.LapsTotal = 0;
      if (t.LastLapMs > 0) out.LastLap = LapFmt.Lap(t.LastLapMs);
      if (t.BestMs > 0) out.BestLap = LapFmt.Lap(t.BestMs);
    }
    const el = t ? qual.Timing.Elapsed(car) : -1;
    out.Current = el >= 0 ? LapFmt.Time(el) : '-.---';
    if (qual.SingleRuns && qual.BoxKind === BoxShow.Result) out.Ahead = !qual.ResultHasDiff || qual.ResultDiffMs <= 0;
    else if (pole >= 0 && pole !== car) { const delta = qual.Timing.Delta(car, pole, poleMs); if (delta !== null) out.Ahead = delta <= 0; }
    return out;
  }
}

// samples for the "place it" screens
function sampleBox() {
  return { Header: 'ROUND 2  -  4:12', PoleNum: 54, PoleName: 'GIBBS', PoleTime: '26.414', CarNum: 77, CarName: 'HOCEVAR', CarPos: '--', Projected: '26.373', Right: '-0.041', Mode: 2, Faster: true };
}
function sampleBroadcast() {
  return { Track: 'INDIANAPOLIS', Session: 'QUALIFYING', Num: 10, First: 'ALEX', Last: 'PALOU', Tele: true, Mph: 234, Rpm: 11940, RpmTop: 12500, Throttle: 1, Brake: 0, Gear: 6,
    LapNo: 3, LapsTotal: 4, Current: '24.176', LastLap: '38.402', BestLap: '38.402', LapRows: ['38.402', '38.511'], Ahead: true, ShowOrder: false,
    Order: [['1', 'ALEX', 'PALOU', '38.402', 'f'], ['2', 'JOSEF', 'NEWGARDEN', '38.512', 'f'], ['', 'PATO', "O'WARD", '24.176', 'l'], ['', 'COLTON', 'HERTA', '', 'u']] };
}

module.exports = { QualBoxModel, sampleBox, sampleBroadcast, signed, QCar };
