// src/hooks/useLayoutEngine.ts
import * as d3 from "d3";
import { useEffect, useRef } from "react";
import {
    AnnealingSettings,
    ContourObstacle,
    DerivedInset,
    OptimizationWeights,
    optimizeVisualElementsPositions,
} from "src/annealing/InsetOptimization";
import type { AnnealingDiagnostics } from "src/annealing/simulatedAnnealing";
import type { NodeSearchIndex } from "src/dataPreprocessing/nodeIndex";
import type { EdgeSearchIndex } from "src/annealing/InsetOptimization";
import {
    ANNEAL_FRAME_BUDGET_MS,
    isConvergedFrame,
    SLEEP_AFTER_CONVERGED_FRAMES,
    SLEEP_WATCHDOG_INTERVAL_MS,
} from "src/layout/engineIdle";
import type { Pos } from "src/layout/layoutStore";
import {
    applyPartial as layoutApplyPartial,
    getSnapshot as layoutGet,
    subscribe as layoutSubscribe,
} from "src/layout/layoutStore";
import { VisualElement } from "src/models/VisualElement";
import { leadersIntersect } from "src/utils/geometryUtils";

export interface ObstacleAABB {
  // screen-space AABB
  x: number; y: number; width: number; height: number;
}

export type LayoutPositioningMode = "annealing" | "cartographic";

const SELECTIVE_REHEAT_TEMPERATURE = 0.6;
const SELECTIVE_REHEAT_OVERLAP_EPS_AREA = 1e-6;
const SELECTIVE_REHEAT_OVERLAP_MIN_RATIO = 0.08;
const SELECTIVE_REHEAT_COOLDOWN_MS = 500;
/** Bounded effort on unsatisfiable constraints (issue #315): after this many
 * consecutive reheats whose cause never cleared, the element stops being
 * re-warmed until the environment changes (viewport, membership, pinning).
 * Without the cap, an inset that CANNOT escape — e.g. every screen position
 * lies inside some foreign cluster contour at a 1M overview — livelocks the
 * loop: reheat → anneal → still overlapping → cooldown → reheat, forever.
 * Profiled at 12.8 s of main-thread energy evaluation over a 30 s at-rest
 * window (43% duty) when boot happened to end in that state. */
const SELECTIVE_REHEAT_MAX_ATTEMPTS = 3;

type ScreenBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
};

function parseClusterUid(id: string): string {
  const match = id.match(/^[^-]+-[^-]+-(.+)$/);
  const uid = match ? match[1] : id;
  const suffixIdx = uid.indexOf("::");
  return suffixIdx >= 0 ? uid.slice(0, suffixIdx) : uid;
}

function toScreenBox(sb: { x: number; y: number; width: number; height: number }): ScreenBox {
  const area = Math.max(1e-9, sb.width * sb.height);
  return {
    minX: sb.x,
    minY: sb.y,
    maxX: sb.x + sb.width,
    maxY: sb.y + sb.height,
    area,
  };
}

function overlapArea(a: ScreenBox, b: ScreenBox): number {
  const ix = Math.max(0, Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX));
  const iy = Math.max(0, Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY));
  return ix * iy;
}

function pointInRect(px: number, py: number, r: { minX: number; minY: number; maxX: number; maxY: number }) {
  return px >= r.minX && px <= r.maxX && py >= r.minY && py <= r.maxY;
}

function pointInPolygon(point: [number, number], polygon: Array<[number, number]>): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a: [number, number], b: [number, number], p: [number, number]): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsIntersect(a1: [number, number], a2: [number, number], b1: [number, number], b2: [number, number]): boolean {
  const o1 = orientation(a1, a2, b1);
  const o2 = orientation(a1, a2, b2);
  const o3 = orientation(b1, b2, a1);
  const o4 = orientation(b1, b2, a2);

  if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0)) return true;
  if (Math.abs(o1) < 1e-9 && onSegment(a1, a2, b1)) return true;
  if (Math.abs(o2) < 1e-9 && onSegment(a1, a2, b2)) return true;
  if (Math.abs(o3) < 1e-9 && onSegment(b1, b2, a1)) return true;
  if (Math.abs(o4) < 1e-9 && onSegment(b1, b2, a2)) return true;
  return false;
}

function polygonIntersectsRect(
  polygon: Array<[number, number]>,
  rect: { minX: number; minY: number; maxX: number; maxY: number }
): boolean {
  if (!polygon.length) return false;

  for (const [x, y] of polygon) {
    if (pointInRect(x, y, rect)) return true;
  }

  const rectPts: Array<[number, number]> = [
    [rect.minX, rect.minY],
    [rect.maxX, rect.minY],
    [rect.maxX, rect.maxY],
    [rect.minX, rect.maxY],
  ];

  for (const p of rectPts) {
    if (pointInPolygon(p, polygon)) return true;
  }

  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    for (let j = 0; j < rectPts.length; j++) {
      const c = rectPts[j];
      const d = rectPts[(j + 1) % rectPts.length];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }

  return false;
}

/** Hard clamp a single element into the current viewbox (data-space), or return null if already inside. */
function clampIntoView(
  el: VisualElement,
  pos: Pos,
  x: d3.ScaleLinear<number, number>,
  y: d3.ScaleLinear<number, number>,
  viewbox: { minX: number; minY: number; maxX: number; maxY: number }
): Pos | null {
  const sb = el.getScreenBoundingBoxFor(pos, x, y);
  const left = x.invert(sb.x);
  const right = x.invert(sb.x + sb.width);
  const top = y.invert(sb.y);
  const bottom = y.invert(sb.y + sb.height);

  // match neighbor()'s hysteresis so clamp isn't too twitchy
  const HYS = 0.06;
  const mb = {
    minX: viewbox.minX + (viewbox.maxX - viewbox.minX) * HYS,
    maxX: viewbox.maxX - (viewbox.maxX - viewbox.minX) * HYS,
    minY: viewbox.minY + (viewbox.maxY - viewbox.minY) * HYS,
    maxY: viewbox.maxY - (viewbox.maxY - viewbox.minY) * HYS,
  };

  const inside =
    left >= mb.minX &&
    right <= mb.maxX &&
    // note inverted y: top is "greater" when above
    top <= mb.maxY &&
    bottom >= mb.minY;
  if (inside) return null;

  // clamp bbox center into margin box
  const cx = x.invert(sb.x + sb.width / 2);
  const cy = y.invert(sb.y + sb.height / 2);
  const nx = Math.min(Math.max(cx, mb.minX), mb.maxX);
  const ny = Math.min(Math.max(cy, mb.minY), mb.maxY);
  if (nx === pos.x && ny === pos.y) return null;
  return { x: nx, y: ny };
}

export function useLayoutEngine(params: {
  elements: VisualElement[];                          // movable only
  obstacles: ObstacleAABB[];                          // pinned AABBs (screen-space)
  contours?: ContourObstacle[];
  zoomKRef: React.MutableRefObject<number>;
  scalesRef: React.MutableRefObject<{ x: d3.ScaleLinear<number,number>, y: d3.ScaleLinear<number,number> } | null>;
  viewboxRef: React.MutableRefObject<{ minX:number;minY:number;maxX:number;maxY:number }>;
  weightsRef: React.MutableRefObject<OptimizationWeights>;
  annealRef: React.MutableRefObject<AnnealingSettings>;
  positioningModeRef: React.MutableRefObject<LayoutPositioningMode>;
  nodeTreeRef: React.MutableRefObject<NodeSearchIndex>;
  segTreeRef:  React.MutableRefObject<EdgeSearchIndex>;
  isZoomingRef?: React.MutableRefObject<boolean>;
  /** Floating diff insets whose positions are derived from their two parent node insets. */
  derivedInsetsRef?: React.MutableRefObject<DerivedInset[]>;
  onAnnealingDiagnostics?: (diag: AnnealingDiagnostics) => void;
}) {
  const elemsRef = useRef<VisualElement[]>([]);
  const obstaclesRef = useRef<ObstacleAABB[]>([]);
  const contoursRef = useRef<ContourObstacle[]>([]);
  const aliveRef = useRef(true);
  const rafRef = useRef<number | null>(null);
  const lastSelectiveReheatMsRef = useRef<Map<string, number>>(new Map());
  // Consecutive fruitless reheats per element + the elements given up on
  // (see SELECTIVE_REHEAT_MAX_ATTEMPTS). Both reset when the environment
  // signature changes — a new viewport/membership/pin state deserves a
  // fresh chance at resolving the conflict.
  const reheatAttemptsRef = useRef<Map<string, number>>(new Map());
  // Separate counter for parents warmed via derived-diff overlap: the node
  // pass resets `reheatAttemptsRef` whenever an element has no OWN conflict,
  // which is the normal state for such parents — sharing the counter would
  // let the derived path re-warm them forever.
  const reheatDerivedAttemptsRef = useRef<Map<string, number>>(new Map());
  const reheatGivenUpRef = useRef<Set<string>>(new Set());
  const reheatEnvSigRef = useRef("");

  // Sleep/wake gating (see engineIdle.ts): after SLEEP_AFTER_CONVERGED_FRAMES
  // frames with no work and no pending work, stop scheduling rAF. Every input
  // channel wakes the loop; a signature watchdog covers missed wiring.
  const convergedFramesRef = useRef(0);
  const sleepingRef = useRef(false);
  const inStepRef = useRef(false);
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wakeRef = useRef<() => void>(() => {});
  // Stable identity so consumers can call engine.wake() inside effects
  // without widening their dependency arrays.
  const stableHandleRef = useRef({ wake: () => wakeRef.current() });

  // keep refs up-to-date without restarting rAF; input changes wake the loop
  useEffect(() => { elemsRef.current = params.elements; wakeRef.current(); }, [params.elements]);
  useEffect(() => { obstaclesRef.current = params.obstacles; wakeRef.current(); }, [params.obstacles]);
  useEffect(() => { contoursRef.current = params.contours ?? []; wakeRef.current(); }, [params.contours]);

  useEffect(() => {
    aliveRef.current = true;

    const step = () => {
      if (!aliveRef.current) return;
      inStepRef.current = true;
      const versionBefore = layoutGet().version;
      let reheatApplied = false;
      let reheatSuppressed = false;
      const scales = params.scalesRef.current;
      if (scales) {
        const nowMs = performance.now();
        const isZooming = params.isZoomingRef?.current ?? false;

        // Keep all labels/insets in-view by clamping first, without warming them.
        // This preserves the mental map during interaction while still preventing
        // obvious off-screen drift.
        const { positions } = layoutGet();
        const vb = params.viewboxRef.current;
        const elements = elemsRef.current;

        const clampPatch = new Map<string, Pos>();
        for (const el of elements) {
          if (el.pinned) continue; // user placement wins, even near the edge (#290)
          const cur = positions.get(el.id) ?? el.center;
          const next = clampIntoView(el, cur, scales.x, scales.y, vb);
          if (next) clampPatch.set(el.id, next);
        }
        if (clampPatch.size) {
          layoutApplyPartial(clampPatch);
        }

        // Do not reheat while a zoom/pan gesture is active; evaluate reheating
        // only after interaction settles.
        if (!isZooming) {
          const latestPositions = layoutGet().positions;
          const screenBoxes = new Map<string, ScreenBox>();

          for (const el of elements) {
            const cur = latestPositions.get(el.id) ?? el.center;
            const sb = el.getScreenBoundingBoxFor(cur, scales.x, scales.y);
            screenBoxes.set(el.id, toScreenBox(sb));
          }

          // A changed environment (viewport, membership, contour set, pin
          // state) resets the bounded-reheat bookkeeping — every element
          // gets a fresh chance at resolving its conflict.
          const envSig =
            `${params.zoomKRef.current}|${vb.minX},${vb.minY},${vb.maxX},${vb.maxY}|` +
            `${elements.length}|${contoursRef.current.length}|` +
            `${elements.reduce((n, el) => n + (el.pinned ? 1 : 0), 0)}`;
          if (envSig !== reheatEnvSigRef.current) {
            reheatEnvSigRef.current = envSig;
            reheatAttemptsRef.current.clear();
            reheatDerivedAttemptsRef.current.clear();
            reheatGivenUpRef.current.clear();
          }

          for (const el of elements) {
            if (el.temperature > 0) continue;
            // Pinned (user-dragged) elements are never re-warmed; overlap is
            // symmetric, so the *other* element's own pass reheats it and the
            // annealer moves it away from the pinned box (#290).
            if (el.pinned) continue;
            // Bounded effort: conflicts this element could not anneal away
            // in SELECTIVE_REHEAT_MAX_ATTEMPTS tries are unsatisfiable in
            // the current environment — stop burning CPU on them.
            if (reheatGivenUpRef.current.has(el.id)) continue;

            const cur = latestPositions.get(el.id) ?? el.center;
            const outside = clampIntoView(el, cur, scales.x, scales.y, vb) !== null;
            let severeOverlap = false;
            let foreignContourOverlap = false;
            let leaderCrossing = false;
            const boxA = screenBoxes.get(el.id);

            if (boxA) {
              for (const other of elements) {
                if (other.id === el.id) continue;
                const boxB = screenBoxes.get(other.id);
                if (!boxB) continue;
                const ov = overlapArea(boxA, boxB);
                const overlapRatio = ov / Math.max(1e-9, Math.min(boxA.area, boxB.area));
                if (
                  ov > SELECTIVE_REHEAT_OVERLAP_EPS_AREA &&
                  overlapRatio >= SELECTIVE_REHEAT_OVERLAP_MIN_RATIO
                ) {
                  severeOverlap = true;
                  break;
                }
              }
            }

            if (boxA && el.type === "inset" && contoursRef.current.length) {
              const ownClusterUid = parseClusterUid(el.id);
              const centerA: [number, number] = [
                (boxA.minX + boxA.maxX) / 2,
                (boxA.minY + boxA.maxY) / 2,
              ];

              for (const contour of contoursRef.current) {
                if (contour.clusterUid === ownClusterUid) continue;
                if (
                  boxA.maxX < contour.minX ||
                  boxA.minX > contour.maxX ||
                  boxA.maxY < contour.minY ||
                  boxA.minY > contour.maxY
                ) {
                  continue;
                }

                if (pointInPolygon(centerA, contour.points) || polygonIntersectsRect(contour.points, boxA)) {
                  foreignContourOverlap = true;
                  break;
                }
              }
            }

            if (el.samples.length > 1) {
              for (const other of elements) {
                if (other.id === el.id) continue;
                if (other.samples.length <= 1) continue;
                if (leadersIntersect(el, other, latestPositions, scales.x, scales.y)) {
                  leaderCrossing = true;
                  break;
                }
              }
            }

            if (!outside && !severeOverlap && !foreignContourOverlap && !leaderCrossing) {
              // Conflict cleared — earlier reheats did their job.
              reheatAttemptsRef.current.delete(el.id);
              continue;
            }

            // Dev-only observability (issue #315): `window.__annealDebug = true`
            // counts reheat causes so headless harnesses can attribute an
            // annealer that never sleeps. No cost when the flag is unset.
            if ((window as unknown as { __annealDebug?: boolean }).__annealDebug) {
              const w = window as unknown as Record<string, Record<string, number>>;
              const c = (w.__annealReheats ??= { outside: 0, severeOverlap: 0, foreignContourOverlap: 0, leaderCrossing: 0, applied: 0, suppressed: 0 });
              if (outside) c.outside++;
              if (severeOverlap) c.severeOverlap++;
              if (foreignContourOverlap) c.foreignContourOverlap++;
              if (leaderCrossing) c.leaderCrossing++;
            }

            const last = lastSelectiveReheatMsRef.current.get(el.id) ?? 0;
            if (nowMs - last < SELECTIVE_REHEAT_COOLDOWN_MS) {
              // Cooldown-deferred reheat: keep the loop awake until it fires.
              reheatSuppressed = true;
              continue;
            }

            const attempts = (reheatAttemptsRef.current.get(el.id) ?? 0) + 1;
            reheatAttemptsRef.current.set(el.id, attempts);
            if (attempts > SELECTIVE_REHEAT_MAX_ATTEMPTS) {
              reheatGivenUpRef.current.add(el.id);
              continue;
            }
            lastSelectiveReheatMsRef.current.set(el.id, nowMs);
            el.temperature = Math.max(el.temperature, SELECTIVE_REHEAT_TEMPERATURE);
            reheatApplied = true;
          }

          // Check derived (floating diff) inset overlap and warm their parent node insets.
          // A diff inset's position is the midpoint of its two parents, so the only way to
          // resolve a diff overlap is to move those parents — we warm them here so the annealer
          // (which now receives derivedInsets in the cost function) can find separation.
          const derivedInsets = params.derivedInsetsRef?.current ?? [];
          if (derivedInsets.length > 0) {
            // Precompute each derived box from current parent midpoints.
            const derivedScreenBoxes: Array<{
              box: ScreenBox; nodeIdA: string; nodeIdB: string;
            } | null> = derivedInsets.map(({ element: dEl, nodeIdA, nodeIdB }) => {
              const pA = latestPositions.get(nodeIdA);
              const pB = latestPositions.get(nodeIdB);
              if (!pA || !pB) return null;
              const mid = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
              const sb = dEl.getScreenBoundingBoxFor(mid, scales.x, scales.y);
              return { box: toScreenBox(sb), nodeIdA, nodeIdB };
            });

            for (let d = 0; d < derivedInsets.length; ++d) {
              const derived = derivedScreenBoxes[d];
              if (!derived) continue;

              let hasOverlap = false;

              // diff-vs-node insets (skip own parents)
              for (const el of elements) {
                if (el.id === derived.nodeIdA || el.id === derived.nodeIdB) continue;
                const boxB = screenBoxes.get(el.id);
                if (!boxB) continue;
                const ov = overlapArea(derived.box, boxB);
                const ratio = ov / Math.max(1e-9, Math.min(derived.box.area, boxB.area));
                if (ov > SELECTIVE_REHEAT_OVERLAP_EPS_AREA && ratio >= SELECTIVE_REHEAT_OVERLAP_MIN_RATIO) {
                  hasOverlap = true;
                  break;
                }
              }

              // diff-vs-other-diff
              if (!hasOverlap) {
                for (let d2 = 0; d2 < derivedScreenBoxes.length; ++d2) {
                  if (d2 === d) continue;
                  const other = derivedScreenBoxes[d2];
                  if (!other) continue;
                  const ov = overlapArea(derived.box, other.box);
                  const ratio = ov / Math.max(1e-9, Math.min(derived.box.area, other.box.area));
                  if (ov > SELECTIVE_REHEAT_OVERLAP_EPS_AREA && ratio >= SELECTIVE_REHEAT_OVERLAP_MIN_RATIO) {
                    hasOverlap = true;
                    break;
                  }
                }
              }

              if (!hasOverlap) continue;

              // Warm both parents — honoring the same cooldown + bounded-effort
              // guards used for node insets (a diff overlap the parents cannot
              // anneal away would otherwise livelock the loop just the same).
              for (const parentId of [derived.nodeIdA, derived.nodeIdB]) {
                const parentEl = elements.find((e) => e.id === parentId);
                if (!parentEl || parentEl.temperature > 0 || parentEl.pinned) continue;
                if (reheatGivenUpRef.current.has(parentId)) continue;
                const last = lastSelectiveReheatMsRef.current.get(parentId) ?? 0;
                if (nowMs - last < SELECTIVE_REHEAT_COOLDOWN_MS) {
                  reheatSuppressed = true;
                  continue;
                }
                const attempts = (reheatDerivedAttemptsRef.current.get(parentId) ?? 0) + 1;
                reheatDerivedAttemptsRef.current.set(parentId, attempts);
                if (attempts > SELECTIVE_REHEAT_MAX_ATTEMPTS) {
                  reheatGivenUpRef.current.add(parentId);
                  continue;
                }
                lastSelectiveReheatMsRef.current.set(parentId, nowMs);
                parentEl.temperature = Math.max(parentEl.temperature, SELECTIVE_REHEAT_TEMPERATURE);
                reheatApplied = true;
              }
            }
          }
        }
      }

      const isZoomingNow = params.isZoomingRef?.current ?? false;
      const positioningMode = params.positioningModeRef.current;
      if (!isZoomingNow) {
        const elements = elemsRef.current;
        if (elements.length && scales) {
          const { positions: currentPositions } = layoutGet();
          let patch: Map<string, Pos>;
          if (positioningMode === "cartographic") {
            patch = new Map(
              elements
                .filter((el) => !el.pinned) // dragged placement survives the per-frame reset (#290)
                .map((el) => [el.id, { ...el.sourcePosition }] as const)
            );
          } else {
            const run = optimizeVisualElementsPositions(
              elements,
              new Map(currentPositions),
              params.zoomKRef.current,
              scales.x,
              scales.y,
              params.weightsRef.current,
              params.nodeTreeRef.current,
              params.segTreeRef.current,
              params.viewboxRef.current,
              // Bound the annealer's per-frame wall-clock so warm frames
              // (inset pop-in, reheat) never block the rAF callback.
              { ...params.annealRef.current, frameBudgetMs: ANNEAL_FRAME_BUDGET_MS },
              obstaclesRef.current,
              contoursRef.current,
              params.derivedInsetsRef?.current
            );
            patch = run.patch;
            params.onAnnealingDiagnostics?.(run.diagnostics);
          }
          if (patch.size) layoutApplyPartial(patch);
        }
      }

      inStepRef.current = false;

      const converged = isConvergedFrame({
        isZooming: isZoomingNow,
        storeChanged: layoutGet().version !== versionBefore,
        reheatApplied,
        reheatSuppressed,
        anyWarm: elemsRef.current.some((el) => el.temperature > 0),
        positioningMode,
      });
      if ((window as unknown as { __annealDebug?: boolean }).__annealDebug) {
        const w = window as unknown as Record<string, Record<string, number>>;
        const c = (w.__annealSteps ??= { steps: 0, converged: 0, storeChanged: 0, reheatApplied: 0, reheatSuppressed: 0, warm: 0, sleeps: 0 });
        c.steps++;
        if (converged) c.converged++;
        if (layoutGet().version !== versionBefore) c.storeChanged++;
        if (reheatApplied) c.reheatApplied++;
        if (reheatSuppressed) c.reheatSuppressed++;
        if (elemsRef.current.some((el) => el.temperature > 0)) c.warm++;
      }
      convergedFramesRef.current = converged ? convergedFramesRef.current + 1 : 0;

      if (convergedFramesRef.current >= SLEEP_AFTER_CONVERGED_FRAMES) {
        sleep();
        return;
      }
      rafRef.current = requestAnimationFrame(step);
    };

    // While sleeping, compare a cheap input signature on a slow cadence so a
    // missed wake channel degrades to <= SLEEP_WATCHDOG_INTERVAL_MS latency
    // instead of a stuck layout.
    const signature = () =>
      `${layoutGet().version}|${params.zoomKRef.current}|${elemsRef.current.length}|` +
      `${obstaclesRef.current.length}|${contoursRef.current.length}|` +
      `${params.derivedInsetsRef?.current?.length ?? 0}|${params.positioningModeRef.current}|` +
      `${params.isZoomingRef?.current ?? false}|` +
      // External reheats (reheatRef) warm temperatures directly.
      `${elemsRef.current.some((el) => el.temperature > 0)}|` +
      // Unpinning (#290) re-exposes an element to the selective-reheat pass —
      // wake within a watchdog tick even though no position changed.
      `${elemsRef.current.reduce((n, el) => n + (el.pinned ? 1 : 0), 0)}`;

    let sleepSignature = "";
    const sleep = () => {
      if ((window as unknown as { __annealDebug?: boolean }).__annealDebug) {
        const w = window as unknown as Record<string, Record<string, number>>;
        if (w.__annealSteps) w.__annealSteps.sleeps++;
      }
      sleepingRef.current = true;
      rafRef.current = null;
      sleepSignature = signature();
      if (watchdogRef.current == null) {
        watchdogRef.current = setInterval(() => {
          if (signature() !== sleepSignature) wake();
        }, SLEEP_WATCHDOG_INTERVAL_MS);
      }
    };

    const wake = () => {
      if (!aliveRef.current) return;
      convergedFramesRef.current = 0;
      if (!sleepingRef.current) return;
      sleepingRef.current = false;
      if (watchdogRef.current != null) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
    };
    wakeRef.current = wake;

    // External layoutStore writers (midpoint pinning, hover nudges, seeding
    // effects) must restart the loop; our own in-step patches are ignored.
    const unsubscribe = layoutSubscribe(() => {
      if (!inStepRef.current) wake();
    });

    rafRef.current = requestAnimationFrame(step);
    return () => {
      aliveRef.current = false;
      unsubscribe();
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (watchdogRef.current != null) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
    };
  // empty deps => persistent loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return stableHandleRef.current;
}

