// NR2003.exe addresses used by the RaceControl port (absolute virtual addresses, image base 0x400000), taken from
// RaceControl's own Addr class. Per-car arrays are indexed by car idx; the pace car is idx 1, the player idx 0.
'use strict';

module.exports = {
  Ocd: 8724,
  CarNum: 11328594, Laps: 11325312, Dlong: 11330202, PaceLap: 11330746, Dlat: 11330230,
  CarClass: 11325382, CarClassLoad: 11328586,
  Pitting: 11332070, PenaltyStop: 11332071, PitCheckValue: 11331563,
  PlayerIdx: 0, PaceCarIdx: 1,
  OnPitRoad: 7781132, HasSpawned: 7779164, HasNotRetired: 8025816, RacedBack: 7779115,
  RetireEngine: 11326070, ReasonOut: 11328868,
  PacingInside1st: 7777536, PacingOutside1st: 7777540, NumPacingLines: 7778540,
  PacingLineIdx: 7777920, PacingRow: 7777924, PacingWaved: 7777928,
  LapsComplete: 7795072, FlagState: 7795076, NumCars: 9932816, TrackLength: 14339852,
  SimState: 12500272, SessionNum: 12500457, NumSessions: 12500383, SessionClock: 9927172,
  Yellow: 7779163,
  DriverInCar: 12609492, GameTicks: 12500469, TickRateFlag: 7690776, TickRateValue: 7690676,
  RaceLength: 12500413, RaceLengthQuickRace: 12500397,
  RaceLengthDisplay: 12609967, RaceLengthDisplayQuickRace: 12609951,
  TrackName: 14348560,
  PitState: 7779065, PitGate: 7796067, PitGateCar: 7796075,
  ClosedPitPenalty: 8837052, PaceCarPenalty: 8849552, PenaltyList: 12433880,
  CrossTable: 7862678, StandingsCache: 7960982,
  RepairNeed: 11330915,
};
