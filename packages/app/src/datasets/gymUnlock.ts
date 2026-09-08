// Old-school cheat unlock for the localOnly demo datasets on deployed hosts.
// The gym demo datasets are gitignored and their insets need the local render
// services, so the hosted app shows them disabled ("server build only" chip).
// Entering the Konami code toggles an unlock (persisted in localStorage) that
// makes them clickable; their files are then fetched from the local static
// data server (rl_trajectories/static_server.py, port 8530).
import { useSyncExternalStore } from "react";

const STORAGE_KEY = "gymDatasetsUnlocked";

const KONAMI = [
  "arrowup",
  "arrowup",
  "arrowdown",
  "arrowdown",
  "arrowleft",
  "arrowright",
  "arrowleft",
  "arrowright",
  "b",
  "a",
];

const listeners = new Set<() => void>();

export function isGymUnlocked(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setGymUnlocked(unlocked: boolean): void {
  try {
    if (unlocked) window.localStorage.setItem(STORAGE_KEY, "1");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable (private mode) — the unlock just won't persist
  }
  listeners.forEach((listener) => listener());
}

export function subscribeGymUnlock(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Re-renders the consumer when the cheat unlock toggles. */
export function useGymUnlocked(): boolean {
  return useSyncExternalStore(subscribeGymUnlock, isGymUnlocked, () => false);
}

/**
 * Installs the Konami-code keydown listener (toggles the unlock).
 * Returns the cleanup function.
 */
export function installGymCheatcode(target: Window = window): () => void {
  let progress = 0;
  const onKeyDown = (event: KeyboardEvent) => {
    // Ignore keys typed into inputs (arrow keys move the caret there).
    const el = event.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
      return;
    }
    const key = event.key?.toLowerCase();
    progress = key === KONAMI[progress] ? progress + 1 : key === KONAMI[0] ? 1 : 0;
    if (progress === KONAMI.length) {
      progress = 0;
      const next = !isGymUnlocked();
      setGymUnlocked(next);
      console.info(
        next
          ? "🕹️ Gym demo datasets unlocked. They need the local data + render services (see RUN-LOCALLY-GYM.md)."
          : "🕹️ Gym demo datasets locked again."
      );
    }
  };
  target.addEventListener("keydown", onKeyDown);
  return () => target.removeEventListener("keydown", onKeyDown);
}
