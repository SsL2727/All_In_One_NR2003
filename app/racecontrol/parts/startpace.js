// RaceControl engine part (RaceControl 2.0.0-beta, RaceEngine.Start.cs): more pace laps before the green.
// NR2003 starts every race at one to go: race init (0x415737) sets laps complete to -1 and the flag to 5, so the field gets the
// one pace lap. In flag 5 the game asks its "caution still needed" check (0x4185F0, true while the caution request byte Yellow is
// set) and, if so, goes to flag 4 (delayed green, 0x419467) instead. In flag 4 it goes back to one to go once the check says no:
// when the pace car's pace lap count moves on at the line (0x419367 -> 0x41938E) or as the pace car passes its pit-entry window
// (track.ini value at 0xBDE260, +100 m; 0x4193B4). Every flag change clears the byte (0x417FF0).
// So Race Control sets the byte at the start and keeps it set until the last extra lap: released once the pace car is past its
// window on the lap before one to go, the line crossing then gives one to go for the last lap. Every step is logged
// ("start pacing: ...") to calibrate on the first races (RaceControl says this was not live checked either).
'use strict';
const A = require('../addr');
const { r0 } = require('../format');

const PACE_WINDOW_AT = 0xBDE260;         // float metres, the pace car's pit-entry window start (+100 m)
const fr = Math.fround;

module.exports = function (RaceEngine) {
  const P = RaceEngine.prototype;

  P.ResetStartPace = function () {
    this.startPacing = this.startReleased = this.startLogged = this.startSawBeforeWindow = this.startNoTakeLogged = false;
    this.startPaceLap0 = this.startLastPaceLap = null; this.startFlag = this.startLastLc = -1; this.startCrossings = 0;
    this.startLastDl = NaN; this.startHeldAt5 = NaN;
  };

  P.PaceCarPaceLap = function () { return this.m.I32(A.PaceLap + A.PaceCarIdx * A.Ocd); };

  // ticked before the green (laps complete -1, or still pacing after Race Control asked for more laps)
  P.StartPaceTick = function (lc) {
    if (this.StartPaceLaps <= 1 && !this.startPacing) return;
    const m = this.m;
    const trackLen = m.F64(A.TrackLength);
    if (trackLen <= 100 || Number.isNaN(trackLen)) return;
    const pl = this.PaceCarPaceLap();
    const dl = this.DlongOf(A.PaceCarIdx), win = m.F32(PACE_WINDOW_AT);
    const winOk = win > 0 && fr(win + 100) < trackLen;
    if (this.startPaceLap0 !== null && pl < this.startPaceLap0) this.ResetStartPace();   // the race was restarted
    if (this.startPaceLap0 === null) this.startPaceLap0 = this.startLastPaceLap = pl;
    // our own count of the pace car's line crossings, as a guard if its pace lap count doesn't move
    if (!Number.isNaN(this.startLastDl) && this.startLastDl > trackLen * 0.75 && dl < trackLen * 0.25) this.startCrossings++;
    this.startLastDl = dl;
    if (pl !== this.startLastPaceLap) {
      this.startLastPaceLap = pl; this.startSawBeforeWindow = false;
      this.Log(`start pacing: pace car lap count ${pl} (${pl - this.startPaceLap0} done of ${this.StartPaceLaps} pace laps), laps complete ${lc}`);
    }
    if (winOk && dl < win) this.startSawBeforeWindow = true;
    if (this.flag !== this.startFlag) {
      this.Log(`start pacing: flag ${this.startFlag} -> ${this.flag} (pace car lap count ${pl}, at ${r0(dl)} m, window ${r0(win)} m, laps complete ${lc}, caution byte ${m.U8(A.Yellow)})`);
      this.startFlag = this.flag;
    }
    if (this.flag !== 7) this.startLastLc = lc;

    const done = pl - this.startPaceLap0;
    let want = !this.startReleased && (this.flag === 4 || this.flag === 5) && this.StartPaceLaps > 1;
    if (want) {
      // the last extra lap: let go once past the window, so the next line crossing gives one to go
      const last = done >= this.StartPaceLaps - 1 || (done >= this.StartPaceLaps - 2 && (!winOk || (this.startSawBeforeWindow && dl > fr(win + 100))));
      const runaway = this.startCrossings > this.StartPaceLaps + 2;
      if (last || runaway) {
        this.startReleased = true; want = false;
        if (m.U8(A.Yellow) !== 0 && this.flag !== 7) m.W8(A.Yellow, 0);
        this.Log(runaway ? `start pacing: let go after ${this.startCrossings} line crossings (the pace car's lap count didn't move as expected)`
          : `start pacing: let go at ${r0(dl)} m with ${done} pace lap(s) done: one to go next`);
      }
    }
    if (want) {
      if (m.U8(A.Yellow) === 0) m.W8(A.Yellow, 1);
      if (!this.startLogged) this.Log(`start pacing: ${this.StartPaceLaps} pace laps before the green (the game's own is 1): holding the caution request`);
      this.startLogged = this.startPacing = true;
      // the game only asks while its yellow option is on (0xBEBD84 bit 0x100000): flag 5 held for long = not taken
      if (this.flag === 5 && done === 0) {
        if (Number.isNaN(this.startHeldAt5)) this.startHeldAt5 = this.Now;
        else if (this.Now - this.startHeldAt5 > 20 && !this.startNoTakeLogged) {
          this.startNoTakeLogged = true;
          this.Log("start pacing: the game hasn't taken the extra lap after 20 s at one to go (are yellow flags on in the game's options?)");
        }
      }
    }
  };

  // the green after start pacing: the race laps the game counted under it are added back
  P.StartPaceGreen = function (lc) {
    if (!this.startPacing) return;
    this.startPacing = false;
    const counted = this.startLastLc + 1;          // -1 at one to go = none counted
    this.Log(`start pacing: green (laps complete ${this.startLastLc} at the last pace lap: ${counted} counted as race laps)`);
    if (counted > 0 && this.StartPaceAddLaps) {
      const len = this.m.U16(this.RaceLengthAddr);
      if (len > 0 && len < 5000) {
        this.m.W16(this.RaceLengthAddr, len + counted);
        this.m.W16(this.RaceLengthDisplayAddr, len + counted);
        this.Log(`start pacing: race length ${len} -> ${len + counted} laps (the pace laps counted are added back)`);
      }
    }
  };
};
