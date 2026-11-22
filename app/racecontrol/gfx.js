// What RaceControl's broadcast graphics show, decided from the engine's state: the choose cone board (RaceControl's TV-style board:
// five rows at a time, filled in as each car picks its lane, with the spots gained or lost, then the rows slide away for the next five)
// and a caution panel (phase, pit road, who is waved / sent around / free pass). Pure: the window and the web page just draw these objects.
'use strict';

const ROWS = 5;

class ConeBoardModel {
  // opts: { now: () => ms, scroll: seconds a full page stays up, doneHold: seconds the finished board stays }
  constructor(opts) {
    this.now = (opts && opts.now) || (() => Date.now());
    this.scroll = opts && opts.scroll > 0 ? opts.scroll : 6;
    this.doneHold = opts && opts.doneHold > 0 ? opts.doneHold : 8;
    this.reset();
  }
  reset() { this.board = null; this.page = 0; this.fullSince = 0; this.doneAt = 0; }

  // board = engine.ConeBoard ({ Title, Cars, Inside[], Outside[], Version, Done }); -> null when nothing should show
  update(board, flag, scroll) {
    if (scroll > 0) this.scroll = scroll;
    const now = this.now();
    if (!board || flag === 7 || flag === 0) { this.reset(); return null; }
    if (board !== this.board) { this.board = board; this.page = 0; this.fullSince = 0; this.doneAt = 0; }
    if (board.Done && !this.doneAt) this.doneAt = now;
    if (this.doneAt && (now - this.doneAt) / 1000 > this.doneHold) return null;
    const byRow = new Map();
    for (const e of board.Inside) byRow.set(e.Row, Object.assign(byRow.get(e.Row) || {}, { inside: e }));
    for (const e of board.Outside) byRow.set(e.Row, Object.assign(byRow.get(e.Row) || {}, { outside: e }));
    const last = byRow.size ? Math.max(...byRow.keys()) : 0;
    const want = last > 0 ? Math.floor((last - 1) / ROWS) : 0;          // the page the newest pick is on
    const pageFull = (p) => { for (let r = p * ROWS + 1; r <= p * ROWS + ROWS; r++) { const x = byRow.get(r); if (!x || !x.inside || !x.outside) return false; } return true; };
    if (this.page < want) {
      // the page being shown is full: it stays up for `scroll` seconds, then the next five slide in
      if (!this.fullSince) this.fullSince = now;
      if ((now - this.fullSince) / 1000 >= this.scroll) { this.page++; this.fullSince = 0; }
    } else if (board.Done && this.page < Math.floor((Math.max(last, 1) - 1) / ROWS)) this.page++;
    else this.fullSince = pageFull(this.page) ? (this.fullSince || now) : 0;
    const rows = [];
    for (let r = this.page * ROWS + 1; r <= this.page * ROWS + ROWS; r++) {
      const x = byRow.get(r) || {};
      rows.push({ n: r, inside: x.inside ? pick(x.inside) : null, outside: x.outside ? pick(x.outside) : null });
    }
    const placed = board.Inside.length + board.Outside.length;
    return { title: board.Title, cars: board.Cars, placed, done: !!board.Done, page: this.page + 1, pages: Math.max(this.page + 1, Math.ceil(Math.max(board.Cars, placed) / 2 / ROWS)), rows };
  }
}

const pick = (e) => ({ num: e.Num, from: e.From, to: e.To, gained: e.Gained, player: !!e.Player });

const PHASES = { 0: 'GREEN', 1: 'CAUTION', 2: 'CAUTION', 3: 'CAUTION', 4: 'CAUTION', 5: 'ONE TO GO', 6: 'DOUBLE FILE', 7: 'GREEN' };

// the caution panel; null outside a caution
function statusOf(e) {
  if (!e || !(e.flag >= 1 && e.flag <= 6)) return null;
  const num = (i) => e.CarNumber(i);
  const decided = (what) => Array.from(e.decided.entries()).filter(kv => kv[1] === what).map(kv => num(kv[0])).sort((a, b) => a - b);
  const going = Array.from(e.eligible.keys()).filter(i => e.GoingAround(i)).map(num).sort((a, b) => a - b);
  const choosing = e.flag === 6 || (e.ConeBoard && !e.ConeBoard.Done);
  return {
    phase: choosing && e.flag >= 5 ? (e.Cone && e.PreferredLane !== 0 ? 'CHOOSE CONE' : 'DOUBLE FILE') : PHASES[e.flag],
    lap: e.lap, flag: e.flag,
    pits: e.pitsOpen ? 'OPEN' : 'CLOSED',
    hold: !!e.holdingOneToGo,
    pitted: e.pitted.size,
    free: e.freePassIdx >= 0 ? num(e.freePassIdx) : null,
    waved: decided('waved'),
    around: going,
    stayedOut: decided('behind').concat(decided('around')),
  };
}

function sampleCone() {
  const mk = (num, lane, row, from) => ({ Num: num, From: from, To: lane === 1 ? 2 * row - 1 : 2 * row, Lane: lane, Row: row, Gained: from - (lane === 1 ? 2 * row - 1 : 2 * row), Player: false });
  return { Title: 'CHOOSE CONE', Cars: 40, Done: false, Version: 1,
    Inside: [mk(48, 1, 1, 1), mk(24, 1, 2, 5), mk(5, 1, 3, 4), mk(11, 1, 4, 9)], Outside: [mk(9, 2, 1, 2), mk(8, 2, 2, 3), mk(23, 2, 3, 8)] };
}
const sampleStatus = () => ({ phase: 'ONE TO GO', lap: 148, flag: 5, pits: 'OPEN', hold: false, pitted: 26, free: 77, waved: [1, 22, 43], around: [10], stayedOut: [] });

// a made-up AIMOD pit board (the shape aimod.pitboard.payload returns) for "Show a sample"
const samplePit = () => ({
  flag: 'caution', lap: 148, total: 200, now: 100, mode: 'race_off', track: 'SAMPLE', on_pit_road: 2, stayed_out: [{ pos: 1, number: '48', last: 'Hamlin', color: '#d7261e' }, { pos: 2, number: '9', last: 'Elliott', color: '#1f4e9c' }],
  coming_in: [{ number: '17', last: 'Buescher', pos: 6, color: '#c99a2e' }],
  stops: [
    { number: '5', last: 'Larson', label: '4 TIRES', state: 'road', pos_in: 3, pos_out: null, pos_now: 3, gained: null, service: 6.4, road: 11.2, color: '#d7261e', reason: 'CAUTION' },
    { number: '24', last: 'Byron', label: 'FUEL ONLY', state: 'out', pos_in: 8, pos_out: 5, pos_now: 5, gained: 3, service: 3.1, road: 14.0, color: '#1f4e9c', reason: 'CAUTION' },
    { number: '11', last: 'Hamlin', label: '2 TIRES, NO FUEL', state: 'out', pos_in: 4, pos_out: 7, pos_now: 7, gained: -3, service: 5.0, road: 15.1, color: '#c99a2e', reason: 'CAUTION' },
  ],
});

module.exports = { ConeBoardModel, statusOf, sampleCone, sampleStatus, samplePit, ROWS };
