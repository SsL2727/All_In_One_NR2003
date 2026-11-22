// RaceControl engine part: lineups, double file, choose cone, untangling, restart diagnostics.
'use strict';
const { r0, f2, f1, f3t, pct } = require('../format');
const A = require('../addr');

const mod = (a, b) => { const n = a % b; return n < 0 ? n + b : n; };
const range = (n) => Array.from({ length: n }, (_, i) => i);
const stableBy = (arr, key, desc) => arr.map((v, i) => [v, i]).sort((a, b) => { const d = desc ? key(b[0]) - key(a[0]) : key(a[0]) - key(b[0]); return d || (a[1] - b[1]); }).map(x => x[0]);

module.exports = function (E) {
  const P = E.prototype;

  P.KeepPlanInStep = function () {
    const list = this.Field();
    if (list == null) return false;
    let changed = false;
    for (const l of [this.lineup, this.inside, this.outside, this.coneInside, this.coneOutside]) {
      if (l) {
        let removed = 0;
        for (let i = l.length - 1; i >= 0; i--) if (!this.Running(l[i])) { l.splice(i, 1); removed++; }
        changed = changed || removed > 0;
      }
    }
    for (const item of stableBy(list, c => c.Gap)) {
      if (this.planKey.has(item.Idx)) continue;
      if (this.inside != null && this.Classic && (this.eligible.has(item.Idx) || this.HasPenalty(item.Idx))) (this.outside.length >= this.inside.length ? this.outside : this.inside).push(item.Idx);
      else if (this.inside != null && this.Classic) (this.DownOf(item) >= 1.0 ? this.inside : this.outside).push(item.Idx);
      else if (this.inside != null) (this.inside.length <= this.outside.length ? this.inside : this.outside).push(item.Idx);
      if (this.lineup != null && !this.lineup.includes(item.Idx)) {
        const obj = new Set(list.filter(o => o.Down >= 1.0 && !this.eligible.has(o.Idx)).map(o => o.Idx));
        const num = (!this.WavedToTail(item.Idx) && (item.Down < 1.0 || this.eligible.has(item.Idx))) ? this.lineup.findIndex(x => obj.has(x)) : -1;
        this.lineup.splice(num < 0 ? this.lineup.length : num, 0, item.Idx);
      }
      this.Log(`#${item.Num} joined the line${this.inside != null ? ' at the end of the ' + (this.inside.includes(item.Idx) ? 'inside' : 'outside') + ' lane' : ''}`);
      changed = true;
    }
    return changed;
  };

  P.LineUp = function (when) {
    const m = this.m;
    const f = this.FieldFull();
    if (f == null) { this.Log(when + ': track length or pace car position unavailable, line left as it is'); return; }
    const { list, leader } = f;
    if (this.leaderIdx < 0) this.leaderIdx = leader.Idx;
    const g2 = [], g3 = [], g4 = [], g5 = [];
    let text = '';
    for (const item of list) {
      if (this.WaitingForOneToGo(item.Idx) && item.Ahead) g5.push(item);
      else if (this.WavedToTail(item.Idx)) {
        if (item.Ahead) text += ' #' + item.Num;
        g4.push(item);
      } else if (this.eligible.has(item.Idx)) {
        if (item.Ahead) text += ' #' + item.Num;
        if (item.Down < 1.0 || item.Ahead) g2.push(item); else g3.push(item);
      } else if (item.Ahead && item.Down >= 1.0) {
        this.excused.add(item.Idx);
        g3.push(item);
        if (!this.settle.has(item.Idx)) this.settle.set(item.Idx, { Down: Math.ceil(item.Down - 0.001), Waved: false, Before: item.Down, LeadLap: false, FreePass: false, Credited: false });
      } else if (item.Down < 1.0) {
        if (item.Ahead) this.excused.add(item.Idx);
        g2.push(item);
      } else g3.push(item);
    }
    const first = this.lineup == null;
    const forfeit = [];
    const back = (g) => { const f = g.filter(i => this.Forfeited(i)); forfeit.push(...f); return g.filter(i => !this.Forfeited(i)).concat(f); };
    const source = stableBy(g5, c => c.Gap).map(c => c.Idx).concat(back(this.Merge(g2, this.lineup))).concat(back(this.Merge(g3, this.lineup))).concat(this.Merge(g4, this.lineup));
    if (forfeit.length > 0 && first) this.Log(`${when}: in the wreck or on pit road at the yellow, behind the other cars of their group:${forfeit.map(i => ' #' + this.CarNumber(i)).join('')}`);
    const num = source.filter((idx, i) => m.I32(A.PacingRow + idx * 13) !== i + 1).length;
    this.lineup = source;
    this.inside = this.outside = null;
    this.WritePlan();
    this.Log(`${when}: leader #${leader.Num}, ${g2.length} lead lap, ${g3.length} lapped, ${g4.length} waved at the tail, ${g5.length > 0 ? g5.length + ' in front waiting to go around at one to go, ' : ''}${num} cars given a new spot; order${source.map(i => ' #' + this.CarNumber(i)).join('')}`);
    if (text !== '') this.Log(`waved cars not yet around at ${when}:${text}`);
    if (this.WaveAroundOn && first) this.Log(this.FirstTimeBySummary());
  };

  P.Merge = function (group, old) {
    let kept = [];
    if (old != null) kept = stableBy(group.filter(c => old.includes(c.Idx)), c => old.indexOf(c.Idx));
    for (const c2 of stableBy(group.filter(c => !kept.includes(c)), c => c.Prog, true)) {
      const num = kept.findIndex(k => k.Prog < c2.Prog);
      kept.splice(num < 0 ? kept.length : num, 0, c2);
    }
    return kept.map(c => c.Idx);
  };

  P.EarlyLineUpTick = function () {
    if (this.earlyLineupDone || this.flag < 2 || this.pitOpenLap < 0 ||
      (!range(this.maxIdx + 1).every(i => i === 1 || !this.Running(i) || this.decided.has(i)) && this.lap < this.pitOpenLap + 2)) return;
    let any = false;
    for (let j = 0; j <= this.maxIdx; j++) { if (any) break; any = j !== 1 && this.OnPitRoad(j) && this.Running(j); }
    if (any) { this.noPitSince = NaN; return; }
    if (Number.isNaN(this.noPitSince)) this.noPitSince = this.Now;
    if (!(this.Now - this.noPitSince < 3.0)) { this.earlyLineupDone = true; this.LineUp('lineup after the pit stops'); }
  };

  P.Entry = function (idx, lane, row) {
    const from = this.coneFrom.has(idx) ? this.coneFrom.get(idx) : 0;
    const to = lane === 1 ? 2 * row - 1 : 2 * row;
    return { Idx: idx, Num: this.CarNumber(idx), From: from, To: to, Lane: lane, Row: row, Player: idx === 0, Gained: (from !== 1 && from !== 0) ? from - to : 0 };
  };

  P.BoardAdd = function (idx, toInside, row) {
    if (this.ConeBoard) { (toInside ? this.ConeBoard.Inside : this.ConeBoard.Outside).push(this.Entry(idx, toInside ? 1 : 2, row)); this.ConeBoard.Version++; }
  };

  // ── random choose cone ──────────────────────────────────────────────────────────────────────────────────────
  // The fixed options (preferred lane, rows given up, front rows, cone point) are the "base". With ConeRandom on, the first time the
  // cone is needed in a caution they are rolled within the user's limits and kept until the restart, then the base comes back.
  P.SetConeBase = function (base) {
    this.coneBase = base;
    if (!this.coneRoll) { this.PreferredLane = base.PreferredLane; this.GiveUpRows = base.GiveUpRows; this.FrontRows = base.FrontRows; this.ConePoint = base.ConePoint; }
  };

  P.RollCone = function () {
    if (!this.ConeRandom || this.coneRoll || !this.coneBase || !this.Cone) return;
    const R = this.ConeRanges, rnd = this.Rnd;
    const norm = ([a, b]) => { a = Math.max(0, Math.round(Number(a) || 0)); b = Math.max(0, Math.round(Number(b) || 0)); return a <= b ? [a, b] : [b, a]; };
    const pick = (r) => { const [lo, hi] = norm(r); return lo + Math.min(hi - lo, Math.floor(rnd() * (hi - lo + 1))); };
    const lane = this.ConeLanes === 'inside' ? 1 : (this.ConeLanes === 'outside' ? 2 : (rnd() < 0.5 ? 1 : 2));
    const giveUp = pick(R.giveUp), front = pick(R.front);
    const [plo, phi] = norm(R.point);
    const point = phi > 0 ? plo + Math.round(rnd() * (phi - plo)) : NaN;
    this.coneRoll = { lane, giveUp, front, point };
    this.PreferredLane = lane; this.GiveUpRows = giveUp; this.FrontRows = front; this.ConePoint = point > 0 ? point : NaN;
    this.Log(`random choose cone: ${lane === 1 ? 'inside' : 'outside'} lane preferred, up to ${giveUp} rows given up, front ${front} rows, cone ${Number.isNaN(this.ConePoint) ? 'where the pace car is' : 'at ' + r0(this.ConePoint) + ' m'}`);
  };

  P.UnrollCone = function () {
    if (!this.coneRoll) return;
    this.coneRoll = null;
    if (this.coneBase) { this.PreferredLane = this.coneBase.PreferredLane; this.GiveUpRows = this.coneBase.GiveUpRows; this.FrontRows = this.coneBase.FrontRows; this.ConePoint = this.coneBase.ConePoint; }
  };

  P.ChoosePlayerLane = function (lane) { if (this.playerOffer != null && (lane === 1 || lane === 2)) this.playerChoice = lane; };

  P.ChoosesInside = function (ins, outs) {
    if (!this.Cone || this.PreferredLane === 0) return ins.length <= outs.length;
    const a = this.PreferredLane === 1 ? ins : outs;
    const b = this.PreferredLane === 1 ? outs : ins;
    const r = Math.min(a.length, b.length) >= this.FrontRows ? (a.length - b.length <= this.GiveUpRows) : (a.length <= b.length);
    return r === (this.PreferredLane === 1);
  };

  P.Lapped = function (c) { return c.Down >= 1.0 && !this.eligible.has(c.Idx) && !this.WaitingForOneToGo(c.Idx); };
  P.Chose = function (idx) { return this.coneInside != null ? (this.coneInside.includes(idx) || this.coneOutside.includes(idx)) : false; };
  P.LappedInTheWay = function (cars) { return cars.filter(c => this.Lapped(c) && cars.some(o => !this.Lapped(o) && !this.WavedToTail(o.Idx) && o.Gap > c.Gap)); };

  P.OneToGoConeTick = function () {
    const list = this.Field();
    const list2 = list == null ? [] : this.LappedInTheWay(list);
    if (this.flag === 5 && list2.length > 0) {
      const text = list2.map(c => ' #' + c.Num).join('');
      if (!this.coneWaiting) { this.coneWaiting = true; this.coneWaitSince = this.Now; this.Log('cone waits for lapped car(s)' + text + ' to drop behind the lead lap cars'); }
      this.coneWaitCars = text;
    } else {
      this.doubleFileDone = true;
      if (this.coneWaiting) this.Log(list2.length === 0 ? `cone opens: the lapped cars are behind the lead lap cars (${r0(this.Now - this.coneWaitSince)} s)` : 'cone opens at double file with lapped car(s) still in the way:' + this.coneWaitCars);
      this.coneWaiting = false;
      this.StartCone(true);
    }
  };

  P.ConeOnOneToGoLap = function () {
    this.RollCone();
    const num = this.m.F64(A.TrackLength);
    if (Number.isNaN(this.ConePoint) || num <= 100.0 || this.ConePoint < 0.0 || this.ConePoint >= num) return false;
    const n2 = (!Number.isNaN(this.DoubleFileAt) && this.DoubleFileAt > 0.0 && this.DoubleFileAt < num) ? this.DoubleFileAt : num * 0.5;
    return this.ConePoint < n2 - 50.0;
  };

  P.LearnDoubleFileAt = function () {
    if (this.flag === 6 && this.coneFlagSeen === 5) {
      const num = this.DlongOf(1);
      const n2 = this.m.F64(A.TrackLength);
      if (n2 > 100.0 && num > 0.0 && num < n2 && (Number.isNaN(this.DoubleFileAt) || Math.abs(num - this.DoubleFileAt) > 25.0)) {
        this.DoubleFileAt = num;
        this.Log(`the field goes double file with the pace car at ${r0(num)} m at this track`);
        if (this.DoubleFileAtLearned) this.DoubleFileAtLearned(num);
      }
    }
    this.coneFlagSeen = this.flag;
  };

  P.LineOrder = function (cars) {
    const list = stableBy(cars, c => c.Gap);
    if (this.lineup == null) return list;
    const at = new Map();
    this.lineup.forEach((v, j) => at.set(v, j));
    return stableBy(list.map((c, i) => ({ c, k: at.has(c.Idx) ? at.get(c.Idx) : 1000 + i })), x => x.k).map(x => x.c);
  };

  P.StartCone = function (oneToGo) {
    this.RollCone();
    const num = this.m.F64(A.TrackLength);
    this.coneInside = []; this.coneOutside = [];
    this.coneRunning = true; this.playerOffer = null; this.playerChoice = 0;
    this.pastCone.clear(); this.toCone.clear(); this.coneFrom.clear(); this.onConeLap.clear(); this.lastConeDlong.clear();
    this.coneNeedsLine = oneToGo && !Number.isNaN(this.ConePoint);
    this.queueLane = this.PreferredLane !== 2 ? 1 : 2;
    const list = num > 100.0 ? this.Field() : null;
    const num2 = this.DlongOf(1);
    let text = '';
    this.coneAt = (!Number.isNaN(this.ConePoint) && this.ConePoint >= 0.0 && this.ConePoint < num) ? this.ConePoint : num2;
    if (Number.isNaN(this.ConePoint)) text = ' (where the pace car is now)';
    else if (oneToGo) text = ' on the one to go lap (it comes before where the field goes double file)';
    else if (list != null && list.length > 0) {
      const num3 = this.DlongOf(stableBy(list, c => c.Gap)[0].Idx);
      const num4 = Math.max(...list.map(c => c.Gap));
      const a = mod(num2 - this.coneAt, num) <= num4;
      const b = mod(this.coneAt - num3, num) < mod(0.0 - num3, num) - 30.0;
      if (!a && !b) {
        text = ` (the cone at ${r0(this.coneAt)} m would come after the green: the pace car is at ${r0(num2)} m at double file, the restart line at 0 m)`;
        this.coneAt = num2;
      }
    }
    if (list != null && this.coneNeedsLine) this.ConeLapFromPaceCar(list, num2, num);
    else if (list != null) {
      for (const item of list) {
        const n5 = this.DlongOf(item.Idx);
        if (mod(n5 - this.coneAt, num) <= mod(num2 - this.coneAt, num) && mod(num2 - this.coneAt, num) < num / 2.0) this.pastCone.add(item.Idx);
      }
    }
    if (text === '' && !Number.isNaN(this.ConePoint)) text = ` (pace car at ${r0(num2)} m)`;
    this.Log(`double file: cars choose their lane at the cone, ${r0(this.coneAt)} m from the line${text}`);
    if (list != null) {
      let n6 = 0;
      for (const item2 of this.LineOrder(list)) { n6 = n6 + 1; this.coneFrom.set(item2.Idx, n6); }
    }
    this.ConeBoard = { Title: (this.Cone && this.PreferredLane !== 0) ? 'CHOOSE CONE' : 'DOUBLE FILE', Cars: this.coneFrom.size, Inside: [], Outside: [], Version: 0, Done: false };
    this.lastConeTick = -1.0;
    this.coneLapChecked = false;
    this.ConeTick();
  };

  P.ConeLapFromPaceCar = function (cars, pc, trackLen) {
    const num = (!Number.isNaN(this.DoubleFileAt) && this.DoubleFileAt > 0.0 && this.DoubleFileAt < trackLen) ? this.DoubleFileAt : trackLen * 0.5;
    if (this.flag !== 6 && pc >= num + 50.0) return;
    for (const car of cars) {
      const n2 = this.DlongOf(car.Idx);
      if (!(n2 > pc)) {
        this.onConeLap.add(car.Idx);
        if (n2 >= this.coneAt && pc >= this.coneAt) this.pastCone.add(car.Idx);
      }
    }
  };

  P.ConeTick = function () {
    if (!this.coneRunning || (this.Now - this.lastConeTick < 0.1 && this.playerChoice === 0)) return;
    this.lastConeTick = this.Now;
    const num = this.m.F64(A.TrackLength);
    const cars = this.Field();
    if (cars == null || num <= 100.0) return;
    const list = this.LineOrder(cars);
    if (this.coneNeedsLine && this.flag === 6 && !this.coneLapChecked) { this.coneLapChecked = true; this.ConeLapFromPaceCar(cars, this.DlongOf(1), num); }
    for (const item of cars) {
      const n2 = this.DlongOf(item.Idx);
      if (this.coneNeedsLine && this.lastConeDlong.has(item.Idx) && this.lastConeDlong.get(item.Idx) > num * 0.75 && n2 < num * 0.25) this.onConeLap.add(item.Idx);
      this.lastConeDlong.set(item.Idx, n2);
      const n3 = mod(this.coneAt - n2, num);
      if (this.toCone.has(item.Idx) && this.toCone.get(item.Idx) < num * 0.25 && n3 > num * 0.75 && (!this.coneNeedsLine || this.onConeLap.has(item.Idx))) this.pastCone.add(item.Idx);
      this.toCone.set(item.Idx, n3);
    }
    const chosen = new Set(this.coneInside.concat(this.coneOutside));
    let changed = false;
    for (const item2 of list) {
      if (chosen.has(item2.Idx)) continue;
      const playerTurn = item2.Idx === 0 && this.PlayerChoosesLane && this.PlayerDriving;
      if ((playerTurn && !this.PlayerTurn(item2)) || (!playerTurn && !this.pastCone.has(item2.Idx))) break;
      let text = '';
      let toInside;
      if (playerTurn) {
        toInside = this.playerChoice === 1;
        text = " (player's choice)";
        if (this.playerChoice === 0) { toInside = this.ChoosesInside(this.coneInside, this.coneOutside); text = ' (player did not choose in time: the cone rule chose)'; }
        this.playerOffer = null; this.playerChoice = 0;
      } else toInside = this.ChoosesInside(this.coneInside, this.coneOutside);
      const l2 = toInside ? this.coneInside : this.coneOutside;
      l2.push(item2.Idx);
      chosen.add(item2.Idx);
      this.BoardAdd(item2.Idx, toInside, l2.length);
      changed = true;
      if (playerTurn) this.Log(`cone: #${item2.Num} chose the ${toInside ? 'inside' : 'outside'} lane, row ${l2.length}${text}`);
    }
    const n4 = this.queueLane === 1 ? this.coneInside.length : this.coneOutside.length;
    const n5 = this.queueLane === 1 ? this.coneOutside.length : this.coneInside.length;
    if (n5 > n4) { this.queueLane = 3 - this.queueLane; changed = true; }
    const rest = list.filter(c => !chosen.has(c.Idx)).map(c => c.Idx);
    if (!changed && this.inside != null) return;
    this.inside = this.coneInside.slice();
    this.outside = this.coneOutside.slice();
    (this.queueLane === 1 ? this.inside : this.outside).push(...rest);
    this.WritePlan();
    if (rest.length > 0) return;
    this.coneRunning = false;
    if (this.ConeBoard) { this.ConeBoard.Done = true; this.ConeBoard.Version++; }
    const n6 = cars.filter(c => c.Down >= 1.0 && cars.some(o => o.Down < 1.0 && o.Gap > c.Gap)).length;
    const fn = (l) => l.map(i => ' #' + this.CarNumber(i)).join('');
    this.Log(((this.Cone && this.PreferredLane !== 0) ? `choose cone done (${this.PreferredLane === 1 ? 'inside' : 'outside'} lane preferred, up to ${this.GiveUpRows} rows given up for it, front ${this.FrontRows} rows take the best spot)` : 'double file done') + ': inside' + fn(this.coneInside) + '; outside' + fn(this.coneOutside) + (n6 > 0 ? `; ${n6} lapped car(s) among the lead lap cars` : ''));
  };

  P.PlayerTurn = function (c) {
    if (this.playerChoice !== 0) return true;
    if (this.playerOffer != null) return this.Now - this.playerOfferTime > 10.0;
    const v = this.toCone.get(c.Idx);
    if (!this.pastCone.has(c.Idx) && (v === undefined || !(v <= 100.0) || (this.coneNeedsLine && !this.onConeLap.has(c.Idx)))) return false;
    const l1 = this.coneInside.map(i => this.CarNumber(i));
    const l2 = this.coneOutside.map(i => this.CarNumber(i));
    this.playerOffer = {
      Inside: l1, Outside: l2,
      InsideCars: this.coneInside.map((i, k) => this.Entry(i, 1, k + 1)), OutsideCars: this.coneOutside.map((i, k) => this.Entry(i, 2, k + 1)),
      PlayerNum: c.Num, PlayerFrom: this.coneFrom.has(c.Idx) ? this.coneFrom.get(c.Idx) : 0,
      Title: this.ConeBoard ? this.ConeBoard.Title : 'CHOOSE CONE',
      Recommended: this.ChoosesInside(this.coneInside, this.coneOutside) ? 1 : 2, PreferredLane: this.Cone ? this.PreferredLane : 0,
    };
    this.playerOfferTime = this.Now;
    this.Log(`cone: the player's turn - inside would be row ${l1.length + 1}, outside row ${l2.length + 1}`);
    if (this.PlayerLaneNeeded) this.PlayerLaneNeeded(this.playerOffer);
    return false;
  };

  P.UntangleTick = function () {
    if (!this.planActive || this.Now - this.lastUntangle < 0.5) return;
    this.lastUntangle = this.Now;
    const list = this.Field();
    if (list == null) return;
    let list2 = [];
    if (this.inside == null) list2 = stableBy(list.filter(c => this.planKey.has(c.Idx)), c => c.Gap);
    else for (const lane of [0, 1]) {
      list2.push(...stableBy(list.filter(c => this.planKey.has(c.Idx) && this.planKey.get(c.Idx) % 2 === lane), c => c.Gap));
      list2.push(null);
    }
    const lim = this.flag === 6 ? 6 : 12;
    const maxKey = this.planKey.size > 0 ? Math.max(...this.planKey.values()) : 0;
    const seen = new Set();
    for (let j = 0; j + 1 < list2.length; j++) {
      const car = list2[j], car2 = list2[j + 1];
      if (car == null || car2 == null || (this.PlayerChoosesLane && (car.Idx === 0 || car2.Idx === 0))) continue;
      const k1 = this.planKey.get(car.Idx), k2 = this.planKey.get(car2.Idx);
      const back = (this.Lapped(car) && this.Lapped(car2)) || (k1 >= maxKey * 0.75 && k2 >= maxKey * 0.75);
      if (k1 > k2 && !(car2.Gap - car.Gap > (back ? 150 : 25)) && (!this.Lapped(car) || this.Lapped(car2)) && !this.GoingAround(car.Idx) && !this.GoingAround(car2.Idx) &&
        (!this.coneRunning || this.Chose(car.Idx) === this.Chose(car2.Idx)) && (this.inside == null || !(car2.Gap - car.Gap < 3.0))) {
        const key = car.Idx * 1000 + car2.Idx;
        seen.add(key);
        if (!this.stuckSince.has(key)) this.stuckSince.set(key, this.Now);
        else if (!(this.Now - this.stuckSince.get(key) < (back ? Math.min(lim, 3.0) : lim))) {
          this.Swap(car.Idx, car2.Idx);
          this.Log(`untangled: #${car.Num} could not get behind #${car2.Num} for ${r0(this.Now - this.stuckSince.get(key))} s; they keep the order they have on track`);
          seen.delete(key);
        }
      }
    }
    for (const p of Array.from(this.stuckSince.keys()).filter(p => !seen.has(p))) this.stuckSince.delete(p);
  };

  P.Swap = function (x, y) {
    for (const l of [this.lineup, this.inside, this.outside, this.coneInside, this.coneOutside]) {
      if (!l) continue;
      const a = l.indexOf(x), b = l.indexOf(y);
      if (l === this.lineup || (a >= 0 && b >= 0)) {
        if (a >= 0) l[a] = y;
        if (b >= 0) l[b] = x;
      }
    }
    this.WritePlan();
  };

  P.OutOfPlace = function () {
    const m = this.m;
    const list = this.Field();
    if (list == null) return { count: 0, placed: 0 };
    const key = new Map();
    for (const item of list) {
      const n = m.I32(A.PacingLineIdx + item.Idx * 13), n2 = m.I32(A.PacingRow + item.Idx * 13);
      if (n >= 0 && n <= 1 && n2 >= 0) key.set(item.Idx, (n2 + n) * 2 - n);
    }
    const list2 = stableBy(list.filter(c => key.has(c.Idx)), c => key.get(c.Idx));
    const list3 = stableBy(list2, c => c.Gap);
    const placed = list2.length;
    const slack = m.U8(A.NumPacingLines) >= 2 ? 1 : 0;
    let n4 = 0;
    for (let i = 0; i < list2.length; i++) if (Math.abs(list3.indexOf(list2[i]) - i) > slack) n4++;
    return { count: n4, placed };
  };

  P.LineCheck = function () {
    const m = this.m;
    const cars = this.Field();
    if (cars == null) return null;
    const lines = m.U8(A.NumPacingLines);
    const list = [], key = new Map();
    for (const item of cars) {
      const n2 = m.I32(A.PacingLineIdx + item.Idx * 13), n3 = m.I32(A.PacingRow + item.Idx * 13);
      if (n2 >= 0 && n2 <= 1 && n3 >= 0) { key.set(item.Idx, (n3 + n2) * 2 - n2); list.push(item); }
    }
    const source = stableBy(list, c => key.get(c.Idx));
    const actual = stableBy(list, c => c.Gap);
    const slack = lines >= 2 ? 1 : 0;
    const bad = stableBy(source.map((c, i) => ({ c, want: i, at: actual.indexOf(c) })).filter(x => Math.abs(x.want - x.at) > slack), x => Math.abs(x.want - x.at), true);
    const spot = (c) => (key.has(c.Idx) ? (lines < 2 ? key.get(c.Idx) : Math.trunc((key.get(c.Idx) - 1) / 2)) : -1);
    const atTail = (c) => this.eligible.has(c.Idx) || c.Idx === this.freePassIdx;
    const n4 = cars.filter(c => c.Down >= 1.0 && cars.some(o => o.Down < 1.0 && !atTail(o) && ((spot(c) < 0 || spot(o) < 0) ? (o.Gap > c.Gap) : (spot(o) > spot(c))))).length;
    return `${lines} lines, ${list.length} cars placed, ${bad.length} out of place${bad.length > 0 ? ' (now->wanted: ' + bad.slice(0, 8).map(x => `#${x.c.Num} ${this.eligible.has(x.c.Idx) ? '(waved) ' : ''}${x.at + 1}->${x.want + 1}`).join(', ') + ')' : ''}${bad.length > 0 ? ', worst ' + Math.abs(bad[0].want - bad[0].at) + ' spots' : ''}; ${n4} lapped car(s) still ahead of a lead lap car`;
  };

  // classic (2004) rules double file: lead lap cars on the outside, lapped cars on the inside (laps down at the yellow), the waved and penalised at
  // the tail of the shorter line; no lapped cars: single file
  P.ClassicDoubleFile = function () {
    this.doubleFileDone = true;
    const f = this.FieldFull();
    if (f == null) { this.Log("double file (2004 rules): track length or pace car position unavailable, the game's line left as it is"); return; }
    const { list, leader } = f;
    if (this.leaderIdx < 0) this.leaderIdx = leader.Idx;
    const src = list.map((c, k) => [c, k]).sort((a, b) => (b[0].Prog - a[0].Prog) || (a[1] - b[1])).map(x => x[0]);
    const tail = (c) => this.eligible.has(c.Idx) || this.HasPenalty(c.Idx);
    const lead = src.filter(c => !tail(c) && this.DownOf(c) < 1.0).map(c => c.Idx);
    const lapped = src.filter(c => !tail(c) && this.DownOf(c) >= 1.0).map(c => c.Idx);
    const tails = src.filter(tail).map(c => c.Idx);
    const out = lead.slice(), ins = lapped.slice();
    for (const i of tails) (out.length >= ins.length ? out : ins).push(i);
    const nums = (l) => l.map(i => ' #' + this.CarNumber(i)).join('');
    for (const i of [...ins, ...out]) this.excused.add(i);
    const t = tails.length > 0 ? ', at the tail' + nums(tails) : '';
    if (ins.length === 0) {
      this.inside = this.outside = null; this.lineup = out; this.WritePlan();
      this.Log(`one to go (classic rules): no lapped cars, single file${t}: order${nums(out)}`);
      return;
    }
    this.lineup = null; this.inside = ins; this.outside = out; this.WritePlan();
    this.Log(`double file (2004 rules): ${lead.length} lead lap outside, ${lapped.length} lapped inside${t}: outside${nums(out)}; inside${nums(ins)}`);
  };

  P.RestartDiagnostics = function () {
    const now = this.Now;
    if (this.flag !== this.prevFlag) {
      if (this.flag === 7 && this.prevFlag === 6 && this.lastLineCheck != null) this.Log('line check just before the green: ' + this.lastLineCheck);
      if (this.flag === 5) this.lineCheck5Done = false;
      if (this.flag === 6) this.lineCheck6Done = false;
      this.prevFlag = this.flag; this.flagSince = now; this.lastLineCheck = null;
    }
    if (this.flag === 5 && !this.lineCheck5Done && now - this.flagSince >= 10.0) {
      this.lineCheck5Done = true;
      const t = this.LineCheck();
      if (t != null) this.Log('line check 10 s after one to go: ' + t);
    }
    if (this.flag !== 6) return;
    if (!this.lineCheck6Done && now - this.flagSince >= 1.0) {
      this.lineCheck6Done = true;
      const t = this.LineCheck();
      if (t != null) this.Log('line check after double file: ' + t);
    }
    if (now - this.lastLineCheckTime >= 0.25) { this.lastLineCheckTime = now; this.lastLineCheck = this.LineCheck(); }
  };

  P.ResetLineup = function () {
    this.lineup = this.inside = this.outside = this.coneInside = this.coneOutside = null;
    this.coneRunning = false; this.playerOffer = null; this.playerChoice = 0; this.planActive = false;
    this.planKey.clear(); this.stuckSince.clear();
    this.lineupDone = this.earlyLineupDone = this.doubleFileDone = this.delayedGreenHandled = false;
    this.coneWaiting = false; this.noPitSince = NaN;
  };

  P.LineupTick = function () {
    this.RestartDiagnostics();
    this.LowLineTick();
    if (this.flag === 7) return;
    if (this.flag === 4 && (this.lineupDone || this.doubleFileDone) && !this.delayedGreenHandled) {
      this.delayedGreenHandled = true;
      const { count: num, placed } = this.OutOfPlace();
      if (this.inside != null && this.planActive && placed > 0 && num * 4 <= placed) {
        this.Log(`delayed green: ${num} of ${placed} cars out of place, the double file is kept (lanes locked)`);
        this.WritePlan();
      } else {
        this.Log(`delayed green: ${num} of ${placed} cars out of place, the lineup and double file will be redone`);
        this.lineupDone = this.doubleFileDone = this.coneWaiting = false;
        this.inside = this.outside = this.coneInside = this.coneOutside = null;
        this.coneRunning = false; this.playerOffer = null; this.planActive = false; this.stuckSince.clear();
      }
    }
    if (this.flag !== 4) this.delayedGreenHandled = false;
    const lapped = this.WaveAroundOn || this.LappedToBack;
    if (lapped && this.EarlyLineup && this.flag >= 2 && this.flag <= 4) this.EarlyLineUpTick();
    if (this.flag === 5 && lapped && !this.lineupDone && this.inside == null) { this.lineupDone = true; this.LineUp('one to go'); }
    this.LearnDoubleFileAt();
    if (this.Classic) {                   // 2004 rules: lead lap cars outside, lapped cars inside, no cone choice
      if ((this.flag === 5 || this.flag === 6) && this.DoubleFile && !this.doubleFileDone) this.ClassicDoubleFile();
    } else if ((this.flag === 5 || (this.flag === 6 && this.coneWaiting)) && this.DoubleFile && !this.doubleFileDone && this.ConeOnOneToGoLap() && (this.lineupDone || !lapped)) this.OneToGoConeTick();
    if (this.flag === 6 && this.DoubleFile && !this.doubleFileDone) { this.doubleFileDone = true; this.StartCone(false); }
    if (this.flag === 5 || this.flag === 6) this.ConeTick();
    if (this.flag >= 2 && this.flag <= 6) this.HoldPlan();
    if (this.Untangle && (this.flag === 3 || this.flag === 5 || this.flag === 6)) this.UntangleTick();
  };
};
