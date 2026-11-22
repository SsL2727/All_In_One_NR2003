// .NET-compatible number formatting for the log lines: "0.00" style formats round the 15-significant-digit decimal
// form of a double half away from zero (so 1.095 -> "1.10"), where JS toFixed works on the exact binary value.
'use strict';

function fx(v, d) {
  if (!Number.isFinite(v)) return String(v);
  const neg = v < 0 || Object.is(v, -0);      // .NET keeps the sign: -0.001 -> "-0.00"
  const [m, e] = Math.abs(v).toExponential(14).split('e');
  const N = BigInt(m.replace('.', ''));
  const sh = parseInt(e, 10) - 14 + d;
  let R;
  if (sh >= 0) R = N * (10n ** BigInt(sh));
  else { const div = 10n ** BigInt(-sh); R = (N * 2n + div) / (2n * div); }
  let s = R.toString().padStart(d + 1, '0');
  if (d > 0) s = s.slice(0, s.length - d) + '.' + s.slice(s.length - d);
  return (neg ? '-' : '') + s;
}

const r0 = (v) => fx(v, 0);
const f2 = (v) => fx(v, 2);
const f1 = (v) => fx(v, 1);
// "0.###": up to 3 decimals, trailing zeros dropped
const f3t = (v) => fx(v, 3).replace(/\.?0+$/, (m) => (m.startsWith('.') ? '' : (fx(v, 3).includes('.') ? '' : m)));
const pct = (v) => fx(v * 100, 0) + '%';

module.exports = { fx, r0, f2, f1, f3t, pct };
