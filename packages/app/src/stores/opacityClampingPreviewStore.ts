import { useSyncExternalStore } from "react";

export type OpacityClampingPreview = {
  min: number;
  max: number;
} | null;

let state: OpacityClampingPreview = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function samePreview(a: OpacityClampingPreview, b: OpacityClampingPreview): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.min === b.min && a.max === b.max;
}

export function getOpacityClampingPreview(): OpacityClampingPreview {
  return state;
}

export function subscribeOpacityClampingPreview(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setOpacityClampingPreview(next: OpacityClampingPreview): void {
  if (samePreview(state, next)) return;
  state = next ? { min: next.min, max: next.max } : null;
  emit();
}

export function clearOpacityClampingPreview(): void {
  setOpacityClampingPreview(null);
}

export function useOpacityClampingPreview(): OpacityClampingPreview {
  return useSyncExternalStore(
    subscribeOpacityClampingPreview,
    getOpacityClampingPreview,
    getOpacityClampingPreview,
  );
}