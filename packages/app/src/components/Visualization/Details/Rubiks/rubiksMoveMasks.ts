// src/components/Visualization/Details/rubiksMoveMasks.ts
import { faceIndex, faces } from "./rubiksUtils";

const KEY_RE = /^(up|left|front|right|down|back)([0-2])([0-2])$/;

function keyToIndex(key: string): number {
  const m = KEY_RE.exec(key);
  if (!m) throw new Error(`Invalid sticker key: ${key}`);
  const f = m[1] as keyof typeof faceIndex;
  const i = m[2].charCodeAt(0) - 48; // '0'->0
  const j = m[3].charCodeAt(0) - 48;
  return faceIndex[f] * 9 + i * 3 + j;
}

const STICKER_KEYS: string[] = faces.flatMap((f) => {
  const ks: string[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) ks.push(`${f}${i}${j}`);
  return ks;
});

// Base clockwise mappings: new_key -> old_key
const BASE: Record<string, Record<string, string>> = {
  r: {
    back02: "up02", back12: "up12", back22: "up22",
    up02: "front02", up12: "front12", up22: "front22",
    front02: "down02", front12: "down12", front22: "down22",
    down02: "back02", down12: "back12", down22: "back22",
    right00: "right20", right01: "right10", right02: "right00",
    right10: "right21", right12: "right01",
    right20: "right22", right21: "right12", right22: "right02",
  },
  l: {
    front00: "up00", front10: "up10", front20: "up20",
    down00: "front00", down10: "front10", down20: "front20",
    back00: "down00", back10: "down10", back20: "down20",
    up00: "back00", up10: "back10", up20: "back20",
    left00: "left20", left01: "left10", left02: "left00",
    left10: "left21", left12: "left01",
    left20: "left22", left21: "left12", left22: "left02",
  },
  f: {
    up20: "left20", up21: "left21", up22: "left22",
    right20: "up20", right21: "up21", right22: "up22",
    down00: "right22", down01: "right21", down02: "right20",
    left20: "down02", left21: "down01", left22: "down00",
    front00: "front20", front01: "front10", front02: "front00",
    front10: "front21", front12: "front01",
    front20: "front22", front21: "front12", front22: "front02",
  },
  u: {
    front00: "right20", front01: "right10", front02: "right00",
    left02: "front00", left12: "front01", left22: "front02",
    back22: "left02", back21: "left12", back20: "left22",
    right00: "back20", right10: "back21", right20: "back22",
    up00: "up20", up01: "up10", up02: "up00",
    up10: "up21", up12: "up01",
    up20: "up22", up21: "up12", up22: "up02",
  },
  b: {
    up00: "right00", up01: "right01", up02: "right02",
    left00: "up00", left01: "up01", left02: "up02",
    down20: "left02", down21: "left01", down22: "left00",
    right00: "down22", right01: "down21", right02: "down20",
    back00: "back20", back01: "back10", back02: "back00",
    back10: "back21", back12: "back01",
    back20: "back22", back21: "back12", back22: "back02",
  },
  d: {
    right02: "front22", right12: "front21", right22: "front20",
    front22: "left20", front21: "left10", front20: "left00",
    left20: "back00", left10: "back01", left00: "back02",
    back00: "right02", back01: "right12", back02: "right22",
    down00: "down20", down01: "down10", down02: "down00",
    down10: "down21", down12: "down01",
    down20: "down22", down21: "down12", down22: "down02",
  },
};

function invertMapping(map: Record<string, string>) {
  const inv: Record<string, string> = {};
  for (const [to, from] of Object.entries(map)) inv[from] = to;
  return inv;
}

function doubleMapping(map: Record<string, string>) {
  const res: Record<string, string> = {};
  for (const key of STICKER_KEYS) {
    const inter = map[key] ?? key;
    const final = map[inter] ?? inter;
    if (final !== key) res[key] = final;
  }
  return res;
}

const ALL_MAPS: Record<string, Record<string, string>> = { ...BASE };
(["r", "l", "f", "u", "b", "d"] as const).forEach((b) => {
  ALL_MAPS[`${b}_prime`] = invertMapping(BASE[b]);
  ALL_MAPS[`${b}2`] = doubleMapping(BASE[b]);
});

// Precompute boolean masks (Uint8Array length 54, 1 = touched)
const MOVE_MASKS: Record<string, Uint8Array> = {};
for (const [move, map] of Object.entries(ALL_MAPS)) {
  const mask = new Uint8Array(54);
  for (const key of Object.keys(map)) {
    mask[keyToIndex(key)] = 1;
  }
  MOVE_MASKS[move] = mask;
}

function normalizeMoveToken(tok: string): string | null {
  const t = tok.trim();
  if (!t) return null;
  const base = t[0].toLowerCase();
  if (!"rlfubd".includes(base)) return null;
  if (t.endsWith("2")) return `${base}2`;
  if (t.endsWith("'") || t.endsWith("′")) return `${base}_prime`;
  return base;
}

export function parseActionTokens(action: string): string[] {
  return (action ?? "")
    .split(/\s+/)
    .map(normalizeMoveToken)
    .filter((x): x is string => !!x);
}

export function getTouchedMask(move: string): Uint8Array {
  return MOVE_MASKS[move] ?? EMPTY_MASK;
}

const EMPTY_MASK = new Uint8Array(54);
