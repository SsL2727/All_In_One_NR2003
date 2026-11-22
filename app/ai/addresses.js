// NR2003.exe memory map for the AI tweaks (from the "AI EDITING" Cheat Engine trainer: crashing mode,
// "AI pit in second yellow flag lap" injection, damage multiplier).
//
// Everything is stored as an RVA (offset from the image base) so it still works if the module is relocated.
// NR2003.exe is not ASLR'd, so base is normally 0x400000.
'use strict';

const IMAGE_BASE = 0x400000;
const rva = (va) => va - IMAGE_BASE;

const GLOBAL = {
  FLAG_STATE: rva(7795076),                    // int32: 7 = green, anything else = caution/other
  DAMAGE_MULT: 0x7EF700,                       // float, trainer's DAMAGE box (RVA)
};

// code patches: expected original bytes are verified before anything is written
const PATCH = {
  // "or edx,3" — crashing-mode switch in the trainer ("or edx,0" = on)
  CRASHING: { rva: rva(0x52E24B), original: '83ca03', on: '83ca00' },
  // trainer's "AI pit in second yellow flag lap": cmp eax,2 / je +17 / cmp eax,1
  PIT_YELLOW: { rva: rva(0x415A50), pattern: '83f80274 1783f801'.replace(' ', ''), length: 8 },
};

// scan range for the AOB fallback (the .text section)
const TEXT = { start: 0x1000, size: 0x2E8000 };

module.exports = { PROCESS_NAME: 'NR2003.exe', IMAGE_BASE, rva, GLOBAL, PATCH, TEXT };
