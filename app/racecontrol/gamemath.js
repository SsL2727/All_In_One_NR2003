// Small game-clock helper shared by the qualifying code (RaceControl 1.1.0's Addr.GameSeconds): the game's own tick
// counter divided by its tick rate, so times stay right with time acceleration. Falls back to the session clock.
'use strict';

function gameSeconds(m) {
  const ticks = m.I32(12500469);
  if (ticks <= 0) return m.F64(9927172);
  let rate = (m.I32(7690776) !== 0) ? 36 : m.I32(7690676);
  if (rate <= 0 || rate > 10000) rate = 36;
  return ticks / rate;
}

module.exports = { gameSeconds };
