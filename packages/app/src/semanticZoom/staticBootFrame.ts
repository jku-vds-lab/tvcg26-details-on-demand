// src/semanticZoom/staticBootFrame.ts
//
// Static boot select-frame registry (issue #315 insets-at-boot I3).
//
// Client-complete datasets (no backend) may ship a prep-time `bootFrame.json`
// artifact — the settled boot-viewport select frame the local scoring
// pipeline would produce, emitted by generate_boot_select_frames.py through
// the SAME selection port the server lane runs (cluster_select.py). The
// loader fetches it in parallel with the data (fire-and-forget) and registers
// it here, keyed by the dataset's canonical rows array; the boot clustering's
// FIRST zoom pass takes it once and applies it instead of the first local
// scoring result, which the next genuine pass then supersedes.
//
// Semantics this module owns (mirrors the I1 stash shape, scaling/
// bootFrameStash.ts, but lives OPEN-CORE — the public build is the client
// lane):
//  * keyed by rows-array identity — a dataset switch replaces the array, so
//    stale frames are unreachable by construction;
//  * single-consume with a TOMBSTONE: the first take for a dataset is the
//    only one that can ever answer, and a registration arriving AFTER that
//    take is refused — a slow artifact fetch must never resurrect the boot
//    view mid-session (the frame is seq-0/pre-scoring by construction).
//
// Open-core: wire types only, no transport, no `@scaling`.

import type { SelectedActive, SelectFrame } from "../scaling.types";
import type { Viewbox } from "./types";

export const STATIC_BOOT_FRAME_FORMAT = "boot-select-frame-v1";

/** The `bootFrame.json` artifact (rl_trajectories/boot_frame.py). */
export interface StaticBootFrameArtifact {
  format: typeof STATIC_BOOT_FRAME_FORMAT;
  tree: string;
  canvasWidth: number;
  canvasHeight: number;
  viewbox: Viewbox;
  frame: SelectFrame;
}

/** `null` = tombstone: taken (or refused) — never answers again. */
const registry = new WeakMap<object, StaticBootFrameArtifact | null>();

/** Datasets whose take answered a REAL frame (issue #315 R2b): the refs
 * mount degate needs "this dataset boots from a static frame" as a
 * non-consuming predicate that stays true after the boot pass consumed the
 * artifact — a bare tombstone cannot tell a real take from a lost fetch. */
const applied = new WeakSet<object>();

/**
 * Shape-validate a fetched artifact. Returns null for anything that is not a
 * well-formed points-tree v1 frame — a corrupt or foreign file must degrade
 * to the classic boot, never throw inside the zoom pass.
 */
export function parseStaticBootFrame(obj: unknown): StaticBootFrameArtifact | null {
  if (!obj || typeof obj !== "object") return null;
  const artifact = obj as Partial<StaticBootFrameArtifact>;
  if (artifact.format !== STATIC_BOOT_FRAME_FORMAT) return null;
  if (artifact.tree !== "points") return null;
  const frame = artifact.frame as SelectFrame | undefined;
  if (!frame || typeof frame !== "object" || !Array.isArray(frame.actives)) return null;
  for (const active of frame.actives as Array<Partial<SelectedActive>>) {
    if (typeof active?.uid !== "string") return null;
    if (typeof active.size !== "number") return null;
    if (active.group !== 0 && active.group !== 1 && active.group !== 2) return null;
    if (
      !Array.isArray(active.leafRanges) ||
      active.leafRanges.some(
        (range) =>
          !Array.isArray(range) ||
          typeof range[0] !== "number" ||
          typeof range[1] !== "number"
      )
    ) {
      return null;
    }
  }
  return artifact as StaticBootFrameArtifact;
}

/** Register the fetched artifact for this dataset's rows array. Refused after
 * the boot pass already took (tombstoned) this dataset's slot. */
export function registerStaticBootFrame(
  rows: object,
  artifact: StaticBootFrameArtifact
): void {
  if (registry.get(rows) === null) return;
  registry.set(rows, artifact);
}

/** Take (and tombstone) the artifact for this dataset's rows array. The first
 * call is the only one that can ever answer — even when it answers null (the
 * fetch lost the race), so a late arrival can never apply mid-session. */
export function takeStaticBootFrame(rows: object): StaticBootFrameArtifact | null {
  const entry = registry.get(rows) ?? null;
  registry.set(rows, null);
  if (entry) applied.add(rows);
  return entry;
}

/** Non-consuming peek (issue #315 R2b, refs mount degate): true while an
 * artifact is registered and after the boot pass took a real one; false for
 * datasets that never shipped a frame or whose fetch lost the race. */
export function hasStaticBootFrame(rows: object): boolean {
  return registry.get(rows) != null || applied.has(rows);
}
