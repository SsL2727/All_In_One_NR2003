// racevision.ini: `key = value` lines, `;` comments. Reads and updates keys in place (comments, order and every other
// line stay exactly as they were) — RaceVision rewrites the file itself when you change a setting in its window.
'use strict';
const fs = require('fs');

const LINE = /^(\s*)([A-Za-z0-9_]+)(\s*=\s*)(.*?)(\r?)$/;

function parse(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    if (/^\s*;/.test(raw)) continue;
    const m = LINE.exec(raw);
    if (m) out[m[2]] = m[4].trim();
  }
  return out;
}

// a new text with the given keys set (existing active lines updated in place, missing keys appended at the end)
function update(text, patch) {
  const lines = String(text || '').split('\n');
  const seen = new Set();
  const nl = /\r\n/.test(text || '') ? '\r\n' : '\n';
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*;/.test(lines[i])) continue;
    const m = LINE.exec(lines[i]);
    if (m && Object.prototype.hasOwnProperty.call(patch, m[2]) && !seen.has(m[2])) {
      seen.add(m[2]);
      lines[i] = m[1] + m[2] + m[3] + String(patch[m[2]]) + m[5];
    }
  }
  const missing = Object.keys(patch).filter(k => !seen.has(k));
  let out = lines.join('\n');
  if (missing.length) {
    if (out.length && !out.endsWith('\n')) out += nl;
    out += missing.map(k => `${k} = ${patch[k]}`).join(nl) + nl;
  }
  return out;
}

function readFile(path) { try { return parse(fs.readFileSync(path, 'utf8')); } catch (e) { return {}; } }
function updateFile(path, patch) {
  let text = '';
  try { text = fs.readFileSync(path, 'utf8'); } catch (e) { /* new file */ }
  const next = update(text, patch);
  if (next !== text) fs.writeFileSync(path, next, 'utf8');
  return next !== text;
}

// "19, 20" -> [19, 20] ; "" -> []
const list = v => String(v || '').split(/[,;\s]+/).filter(Boolean).map(s => s.trim());

module.exports = { parse, update, readFile, updateFile, list };
