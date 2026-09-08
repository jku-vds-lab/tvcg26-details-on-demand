// src/utils/insetLedger.ts
//
// Issue #315 Arc 1 Task 2 — inset-latency attribution ledger (diagnosis, not
// a fix). Records per-id pipeline stage timestamps across the inset content
// chain (cut stash → active dispatch → reconcile → shell mount → transport
// queue → fetch → ready) plus a bounded global event log, exposed as
// `window.__insetLedger` for headless harnesses (same convention as
// `__semanticZoomDebug` / `__baseDrawDebug`).
//
// Two id namespaces, joined by the harness:
//  - cluster uids (server cut hex uid, or the element uid `<num>::h<hier>`),
//  - transport/cache keys prefixed `k:` (the request signature key; range
//    keys embed the same leafRange spans recorded via the `spans` note).
//
// Cost: a Map write per stage EVENT (cut arrivals, mounts, fetches — never
// per frame), hard-capped sizes; safe to leave on in production.

interface LedgerStage {
  /** First occurrence (performance.now()). */
  t0: number;
  /** Latest occurrence. */
  tLast: number;
  /** Occurrence count — repeats reveal reset/supersede loops. */
  n: number;
}

interface LedgerEntry {
  stages: Record<string, LedgerStage>;
  notes?: Record<string, string>;
}

const MAX_ENTRIES = 8000;
const MAX_EVENTS = 8000;

const entries = new Map<string, LedgerEntry>();
const events: Array<{ t: number; name: string; info?: string }> = [];
let dropped = 0;

function entryFor(id: string): LedgerEntry | null {
  let e = entries.get(id);
  if (!e) {
    if (entries.size >= MAX_ENTRIES) {
      dropped++;
      return null;
    }
    e = { stages: {} };
    entries.set(id, e);
  }
  return e;
}

/** Record `stage` for `id` at now(): first timestamp kept, repeats counted. */
export function ledgerMark(id: string, stage: string): void {
  const e = entryFor(id);
  if (!e) return;
  const t = performance.now();
  const s = e.stages[stage];
  if (s) {
    s.tLast = t;
    s.n++;
  } else {
    e.stages[stage] = { t0: t, tLast: t, n: 1 };
  }
}

/** Attach a small string note to `id` (e.g. leafRange spans for key joins). */
export function ledgerNote(id: string, name: string, value: string): void {
  const e = entryFor(id);
  if (!e) return;
  (e.notes ??= {})[name] = value;
}

/** Append a global pipeline event (cut fetches, resets, breaker trips). */
export function ledgerEvent(name: string, info?: string): void {
  if (events.length >= MAX_EVENTS) {
    dropped++;
    return;
  }
  events.push({ t: performance.now(), name, info });
}

function snapshot(): {
  now: number;
  dropped: number;
  events: Array<{ t: number; name: string; info?: string }>;
  entries: Record<string, LedgerEntry>;
} {
  return {
    now: performance.now(),
    dropped,
    events: events.slice(),
    entries: Object.fromEntries(entries),
  };
}

function reset(): void {
  entries.clear();
  events.length = 0;
  dropped = 0;
}

declare global {
  interface Window {
    __insetLedger?: { snapshot: typeof snapshot; reset: typeof reset };
  }
}

if (typeof window !== "undefined") {
  window.__insetLedger = { snapshot, reset };
}
