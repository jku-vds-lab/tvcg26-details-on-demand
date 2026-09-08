// src/layout/layoutStore.ts
import { useSyncExternalStore } from "react";

export type Pos = { x: number; y: number };
export type LayoutState = { version: number; positions: Map<string, Pos> };

let state: LayoutState = { version: 0, positions: new Map() };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function getSnapshot(): LayoutState {
  return state;
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function same(a?: Pos, b?: Pos) {
  return !!a && !!b && a.x === b.x && a.y === b.y;
}

function commit(nextPositions: Map<string, Pos>, changed: boolean) {
  if (!changed) return; // no version bump, no re-render
  state = { version: state.version + 1, positions: nextPositions };
  emit();
}

export function setPositions(next: Map<string, Pos>): void {
  // full replace but only if something differs
  let changed = false;
  if (next.size !== state.positions.size) {
    changed = true;
  } else {
    for (const [id, p] of next) {
      if (!same(state.positions.get(id), p)) {
        changed = true;
        break;
      }
    }
  }
  commit(new Map(next), changed);
}

export function applyPartial(patch: Map<string, Pos>): void {
  if (patch.size === 0) return;
  const next = new Map(state.positions);
  let changed = false;
  patch.forEach((p, id) => {
    const prev = next.get(id);
    if (!same(prev, p)) {
      next.set(id, p);
      changed = true;
    }
  });
  commit(next, changed);
}

export function setPosition(id: string, p: Pos): void {
  const prev = state.positions.get(id);
  if (same(prev, p)) return;
  const next = new Map(state.positions);
  next.set(id, p);
  commit(next, true);
}

export function useLayout(): LayoutState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePosition(id: string): Pos | undefined {
  return useSyncExternalStore(
    subscribe,
    () => state.positions.get(id),
    () => state.positions.get(id)
  );
}

// rAF batching
let rafId: number | null = null;
let pending = new Map<string, Pos>();
const raf =
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame
    : (cb: FrameRequestCallback) => (setTimeout(cb, 16) as unknown as number);

export function schedulePatch(patch: Map<string, Pos>) {
  patch.forEach((p, id) => pending.set(id, p));
  if (rafId == null) {
    rafId = raf(() => {
      applyPartial(pending);
      pending = new Map();
      rafId = null;
    });
  }
}
