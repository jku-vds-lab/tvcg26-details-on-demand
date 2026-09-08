// PhaseEstimator.ts
type Weights = { net: number; parse: number; prepare: number };
type Durations = { netMs: number; parseMs: number; prepareMs: number };

const DEFAULT_W: Weights = { net: 0.7, parse: 0.25, prepare: 0.05 };
const DEFAULT_D: Durations = { netMs: 300, parseMs: 1500, prepareMs: 300 }; // safe UX defaults
const ALPHA = 0.3;

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

function keyFor(path: string): string {
  try {
    const url = new URL(path, location.origin);
    return url.pathname; // persist per file path, ignore query
  } catch {
    return path;
  }
}

export function getWeights(path: string): Weights {
  const key = keyFor(path);
  try {
    const raw = localStorage.getItem(`phaseWeights:${key}`);
    if (!raw) return DEFAULT_W;
    const w = JSON.parse(raw) as Weights;
    const s = w.net + w.parse + w.prepare || 1;
    return { net: w.net / s, parse: w.parse / s, prepare: w.prepare / s };
  } catch {
    return DEFAULT_W;
  }
}

export function updateWeights(path: string, timesMs: { net: number; parse: number; prepare: number }) {
  const key = keyFor(path);
  const total = Math.max(1, timesMs.net + timesMs.parse + timesMs.prepare);
  const newW: Weights = {
    net: clamp01(timesMs.net / total),
    parse: clamp01(timesMs.parse / total),
    prepare: clamp01(timesMs.prepare / total),
  };
  const prev = getWeights(path);
  const blended: Weights = {
    net: prev.net * (1 - ALPHA) + newW.net * ALPHA,
    parse: prev.parse * (1 - ALPHA) + newW.parse * ALPHA,
    prepare: prev.prepare * (1 - ALPHA) + newW.prepare * ALPHA,
  };
  localStorage.setItem(`phaseWeights:${key}`, JSON.stringify(blended));

  // Also keep EMA durations for predictive animation
  const prevD = getPredictedDurations(path);
  const nextD: Durations = {
    netMs: prevD.netMs * (1 - ALPHA) + timesMs.net * ALPHA,
    parseMs: prevD.parseMs * (1 - ALPHA) + timesMs.parse * ALPHA,
    prepareMs: prevD.prepareMs * (1 - ALPHA) + timesMs.prepare * ALPHA,
  };
  localStorage.setItem(`phaseDurations:${key}`, JSON.stringify(nextD));
}

export function getPredictedDurations(path: string): Durations {
  const key = keyFor(path);
  try {
    const raw = localStorage.getItem(`phaseDurations:${key}`);
    if (!raw) return DEFAULT_D;
    const d = JSON.parse(raw) as Partial<Durations>;
    return {
      netMs: d.netMs ?? DEFAULT_D.netMs,
      parseMs: d.parseMs ?? DEFAULT_D.parseMs,
      prepareMs: d.prepareMs ?? DEFAULT_D.prepareMs,
    };
  } catch {
    return DEFAULT_D;
  }
}
