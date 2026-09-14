// Normalization and case folding over the COMMITTED Unicode tables
// (§4.1b, point 2). Never uses String.prototype.normalize/toLowerCase: the
// host runtime's ICU decides those, runtimes disagree, and a package must get
// one verdict everywhere.
import { CASE_FOLD, DECOMP, CCC, COMPOSE } from "./unicode-tables.ts";

// Hangul (Unicode 3.12): algorithmic, so no table entries exist for it.
const S_BASE = 0xac00;
const L_BASE = 0x1100;
const V_BASE = 0x1161;
const T_BASE = 0x11a7;
const L_COUNT = 19;
const V_COUNT = 21;
const T_COUNT = 28;
const N_COUNT = V_COUNT * T_COUNT;
const S_COUNT = L_COUNT * N_COUNT;

function ccc(cp: number): number {
  return CCC.get(cp) ?? 0;
}

function decomposeInto(cp: number, out: number[]): void {
  const sIndex = cp - S_BASE;
  if (sIndex >= 0 && sIndex < S_COUNT) {
    const l = L_BASE + Math.floor(sIndex / N_COUNT);
    const v = V_BASE + Math.floor((sIndex % N_COUNT) / T_COUNT);
    const t = T_BASE + (sIndex % T_COUNT);
    out.push(l, v);
    if (sIndex % T_COUNT !== 0) out.push(t);
    return;
  }
  const seq = DECOMP.get(cp);
  if (!seq) {
    out.push(cp);
    return;
  }
  for (const c of seq) decomposeInto(c, out);
}

/** Canonical decomposition + canonical ordering (NFD). */
export function toNFD(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) decomposeInto(ch.codePointAt(0)!, out);
  // canonical ordering: stable bubble over runs of non-starters
  for (let i = 1; i < out.length; i++) {
    const c = ccc(out[i]!);
    if (c === 0) continue;
    let j = i;
    while (j > 0 && ccc(out[j - 1]!) > c) {
      const tmp = out[j - 1]!;
      out[j - 1] = out[j]!;
      out[j] = tmp;
      j -= 1;
    }
  }
  return out;
}

function composePair(a: number, b: number): number | undefined {
  const lIndex = a - L_BASE;
  if (lIndex >= 0 && lIndex < L_COUNT) {
    const vIndex = b - V_BASE;
    if (vIndex >= 0 && vIndex < V_COUNT) return S_BASE + (lIndex * V_COUNT + vIndex) * T_COUNT;
  }
  const sIndex = a - S_BASE;
  if (sIndex >= 0 && sIndex < S_COUNT && sIndex % T_COUNT === 0) {
    const tIndex = b - T_BASE;
    if (tIndex > 0 && tIndex < T_COUNT) return a + tIndex;
  }
  return COMPOSE.get(`${a},${b}`);
}

/** Canonical composition (NFC), computed from the committed tables. */
export function toNFC(s: string): string {
  const d = toNFD(s);
  if (d.length === 0) return "";
  const out: number[] = [d[0]!];
  let starterPos = 0;
  let lastCcc = ccc(d[0]!) === 0 ? -1 : ccc(d[0]!);
  for (let i = 1; i < d.length; i++) {
    const cp = d[i]!;
    const c = ccc(cp);
    const starter = out[starterPos]!;
    const blocked = lastCcc >= c && lastCcc !== -1;
    if (!blocked && ccc(starter) === 0) {
      const composed = composePair(starter, cp);
      if (composed !== undefined) {
        out[starterPos] = composed;
        continue;
      }
    }
    out.push(cp);
    if (c === 0) {
      starterPos = out.length - 1;
      lastCcc = -1;
    } else {
      lastCcc = c;
    }
  }
  return String.fromCodePoint(...out);
}

/** True when the string is already in canonical composed form. */
export function isNFC(s: string): boolean {
  return toNFC(s) === s;
}

/**
 * Unicode default full case fold over the committed table, applied to the
 * canonical form so that NFC and NFD spellings of one path share a key.
 */
export function foldKey(s: string): string {
  let folded = "";
  for (const ch of toNFC(s)) {
    folded += CASE_FOLD.get(ch.codePointAt(0)!) ?? ch;
  }
  return toNFC(folded);
}

export { UNICODE_VERSION, CASE_FOLD } from "./unicode-tables.ts";
