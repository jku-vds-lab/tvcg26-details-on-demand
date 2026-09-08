// src/models/VisualElement.ts

import * as d3 from "d3";
import type { BaseInsetRenderer, Transform } from "src/components/Visualization/Details/BaseInsetRenderer";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getSnapshot as layoutGet, setPosition as layoutSetPosition } from "src/layout/layoutStore";
import store, { RootState } from "src/store";
import { instantiateRenderer } from "src/utils/clusterDataUtils";

export enum VisualElementType {
  Annotation = "annotation",
  Inset = "inset",
}

export type ElementKind = "node" | "edge";

export function makeElementId(
  kind: ElementKind,
  type: VisualElementType,
  uid: string
): string {
  return `${kind}-${type}-${uid}`;
}

export function parseClusterUid(id: string): string {
  const match = id.match(/^[^-]+-[^-]+-(.+)$/);
  const uid = match ? match[1] : id;
  const suffixIdx = uid.indexOf("::");
  return suffixIdx >= 0 ? uid.slice(0, suffixIdx) : uid;
}

// Exported interface for leader line geometry.
export interface LeaderLineGeometry {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * For edge relation insets (kind==="edge", connecting two active node clusters
 * A→B), these are the uids of the two clusters.  Used by the dual-leader-line
 * renderer to look up the corresponding ClusterConvexHull objects at render time.
 * Absent on node insets and legacy midpoint-cluster edge insets.
 */
export interface RelationAnchors {
  /** Canonical first cluster uid (uidA ≤ uidB lexicographically). */
  uidA: string;
  /** Canonical second cluster uid. */
  uidB: string;
  /** Raw score for the uidA→uidB direction (0 when no transitions). */
  forwardScore: number;
  /** Raw score for the uidB→uidA direction (0 when no transitions). */
  backwardScore: number;
  /** True when both clusters are singletons: inset is pinned to the spline
   *  midpoint and shown without leader lines. */
  onSpline: boolean;
}

export class VisualElement {
  public readonly id: string;
  public readonly kind: ElementKind;
  public readonly type: VisualElementType;

  public currentZoomScale: number = 1;

  public initialTemperature: number;
  public temperature: number;

  /**
   * User-dragged placement (issue #290). While true, every warm path must
   * leave this element alone — the selective-reheat loop, the zoom reheat,
   * the cartographic reset, and reconcile's membership reseed all skip it —
   * so the dropped position persists until the user drags it again. The
   * element still participates as an obstacle: overlapping *others* reheat
   * and move away. Cleared only by element re-creation (cluster deactivation).
   */
  public pinned: boolean = false;

  public movement: number;
  public position: { x: number; y: number };
  public renderer: BaseInsetRenderer;
  public samples: DataPoint[];
  public datasetType: string;
  public sourcePosition: { x: number; y: number };
  public currentCssScale: number = 1;

  /**
   * Present only on cluster-conditioned edge relation insets.
   * Absent on node insets and legacy midpoint-cluster edge insets.
   */
  public relationAnchors?: RelationAnchors;

  constructor(
    id: string,
    kind: ElementKind,
    type: VisualElementType,
    temperature: number = 1,
    movement: number = 0,
    datasetType: string,
    samples?: DataPoint[],
    /** Creation fast path (issue #315): reconcile already has O(1) prefix
     * centroids and React's first render measures content anyway — passing
     * `center` skips the O(members) reduce, `deferMeasure` skips the
     * synthesis-for-measurement (the annealer self-corrects one frame later
     * when the real bbox lands). Omitted = exact legacy behavior. */
    opts?: { center?: { x: number; y: number }; deferMeasure?: boolean }
  ) {
    this.id = id;
    this.kind = kind;
    this.type = type;

    this.initialTemperature = temperature;
    this.temperature = temperature;

    this.movement = movement;
    this.datasetType = datasetType;
    this.renderer = instantiateRenderer(datasetType);

    if (!samples || samples.length === 0) {
      console.warn(
        `VisualElement created with empty or undefined samples for id: ${id}.`
      );
      this.samples = [];
      const initialTransform = this.renderer.getTransform();
      this.position = { x: initialTransform.x, y: initialTransform.y };
    } else {
      this.samples = samples;
      let center = opts?.center;
      if (!center) {
        // Allocation-free centroid (the reduce allocated two objects per
        // member — 1.7M allocations for one 840k-member inset).
        let sx = 0;
        let sy = 0;
        for (let i = 0; i < samples.length; i++) {
          sx += samples[i].x;
          sy += samples[i].y;
        }
        center = { x: sx / samples.length, y: sy / samples.length };
      }
      this.position = { x: center.x, y: center.y };
      this.renderer.setTransform({ x: center.x, y: center.y, scale: 1 });
      if (!opts?.deferMeasure) this.updateBoundingBox();
    }
    this.sourcePosition = { ...this.position };
  }

  public setCssScale(invk: number) {
    this.currentCssScale = invk;
  }

  get globalBoundingBox() {
    const transform: Transform = this.renderer.getTransform();
    const localBbox = this.renderer.getBoundingBox();
    return {
      minX: this.position.x + localBbox.minX * transform.scale,
      minY: this.position.y + localBbox.minY * transform.scale,
      maxX: this.position.x + localBbox.maxX * transform.scale,
      maxY: this.position.y + localBbox.maxY * transform.scale,
      x: this.position.x + localBbox.x * transform.scale,
      y: this.position.y + localBbox.y * transform.scale,
      width: localBbox.width * transform.scale,
      height: localBbox.height * transform.scale,
    };
  }

  public getScreenBoundingBox(
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>
  ) {
    const invk = this.currentCssScale;
    const centerX = xScale(this.center.x);
    const centerY = yScale(this.center.y);
    const intrinsic = this.renderer.getBoundingBox();
    return {
      x: centerX - (intrinsic.width  * invk) / 2,
      y: centerY - (intrinsic.height * invk) / 2,
      width:  intrinsic.width  * invk,
      height: intrinsic.height * invk,
    };
  }

  public getScreenBoundingBoxFor(
    center: { x: number; y: number },
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>
  ) {
    const invk = this.currentCssScale;
    const centerX = xScale(center.x);
    const centerY = yScale(center.y);
    const intrinsic = this.renderer.getBoundingBox();
    return {
      x: centerX - (intrinsic.width * invk) / 2,
      y: centerY - (intrinsic.height * invk) / 2,
      width: intrinsic.width * invk,
      height: intrinsic.height * invk,
    };
  }

  /**
   * Like getScreenBoundingBoxFor, but for the visually rendered inset body
   * (renderer.getVisualBoundingBox() — excludes the overlay-label region the
   * layout bbox reserves). `extraScale` accounts for transient CSS scaling of
   * the rendered div (e.g. insetHoverScale on the hovered inset) so leader
   * tips keep touching the border at any rendered size. `cssScale` must be
   * the live 1/k when the caller knows it (issue #345): the stored
   * currentCssScale is only corrected by an effect after the commit that
   * already baked the caller's geometry, so render-time clipping against the
   * field-scaled box goes stale when the zoom changes without a position
   * change. The default keeps legacy callers unchanged.
   */
  public getScreenVisualBoundingBoxFor(
    center: { x: number; y: number },
    xScale: d3.ScaleLinear<number, number>,
    yScale: d3.ScaleLinear<number, number>,
    extraScale: number = 1,
    cssScale: number = this.currentCssScale
  ) {
    const s = cssScale * extraScale;
    const centerX = xScale(center.x);
    const centerY = yScale(center.y);
    const intrinsic = this.renderer.getVisualBoundingBox();
    return {
      x: centerX - (intrinsic.width * s) / 2,
      y: centerY - (intrinsic.height * s) / 2,
      width: intrinsic.width * s,
      height: intrinsic.height * s,
    };
  }

  get center() {
    return layoutGet().positions.get(this.id) ?? this.position;
  }

  set center(newCenter: { x: number; y: number }) {
    this.position = { ...newCenter };
    layoutSetPosition(this.id, newCenter);
  }

  public move(dx: number, dy: number): void {
    const newPos = { x: this.position.x + dx, y: this.position.y + dy };
    this.position = newPos;
    const currentTransform = this.renderer.getTransform();
    this.updateTransform({ x: newPos.x, y: newPos.y, scale: currentTransform.scale });
    this.movement = Math.sqrt(dx * dx + dy * dy);
  }

  public updateTransform(newTransform: Transform): void {
    this.renderer.setTransform(newTransform);
    // Position-only change: translating the bbox never requires re-running
    // content synthesis. The full updateBoundingBox() re-synthesis branch is
    // for MEMBERSHIP changes (reconcile) — routing position patches through
    // it made every annealer tick re-render any inset whose content hadn't
    // measured yet (backend insets awaiting their payload), the measured
    // inset lag-spike at 1M (issue #315). An unmeasured bbox stays unmeasured
    // here; the React content render sets it when the payload lands.
    if (this.renderer.hasIntrinsicBoundingBox()) {
      this.renderer.updateBoundingBoxForPositionChange();
    }
  }

  public updateBoundingBox(): void {
    if (this.renderer.hasIntrinsicBoundingBox()) {
      this.renderer.updateBoundingBoxForPositionChange();
    } else {
      if (this.kind === "node" && this.type === VisualElementType.Annotation) {
        if (this.samples.length === 1) {
          this.renderer.renderSingleNodeAnnotation(this.samples);
        } else {
          this.renderer.renderGroupNodeAnnotation(this.samples);
        }
      } else if (this.kind === "node" && this.type === VisualElementType.Inset) {
        if (this.samples.length === 1) {
          this.renderer.renderSingleNodeInset(this.samples);
        } else {
          this.renderer.renderGroupNodeInset(this.samples);
        }
      } else if (this.kind === "edge" && this.type === VisualElementType.Annotation) {
        if (this.samples.length === 1) {
          this.renderer.renderSingleEdgeAnnotation(this.samples);
        } else {
          this.renderer.renderGroupEdgeAnnotation(this.samples);
        }
      } else if (this.kind === "edge" && this.type === VisualElementType.Inset) {
        if (this.samples.length === 1) {
          this.renderer.renderSingleEdgeInset(this.samples);
        } else {
          this.renderer.renderGroupEdgeInset(this.samples);
        }
      }
    }
  }

  public coolDown(beta: number): void {
    this.temperature *= beta;
  }

  public getLeaderLineGeometry(
    zoomedXScale: d3.ScaleLinear<number, number>,
    zoomedYScale: d3.ScaleLinear<number, number>
  ): LeaderLineGeometry {
    return {
      x1: zoomedXScale(this.sourcePosition.x),
      y1: zoomedYScale(this.sourcePosition.y),
      x2: zoomedXScale(this.center.x),
      y2: zoomedYScale(this.center.y),
    };
  }

  public renderLeaderLine(
    zoomedXScale: d3.ScaleLinear<number, number>,
    zoomedYScale: d3.ScaleLinear<number, number>
  ): JSX.Element {
    const { x1, y1, x2, y2 } = this.getLeaderLineGeometry(zoomedXScale, zoomedYScale);

    const {
      leaderOutlineThickness,
      leaderThickness,
      leaderGray,
      leaderDashLength,
      leaderDashGap,
    } = (store.getState() as RootState).clusterSettings;

    const gray = Math.round(leaderGray * 255);
    const strokeColor = `rgb(${gray},${gray},${gray})`;
    const dashArray =
    leaderDashLength > 0 || leaderDashGap > 0
      ? `${leaderDashLength * this.currentCssScale} ${leaderDashGap * this.currentCssScale}`
      : undefined;


    return (
      <g>
        {/* white outline */}
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="white"
          strokeWidth={leaderOutlineThickness * this.currentCssScale}
        />
        {/* main leader line */}
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={strokeColor}
          strokeWidth={leaderThickness * this.currentCssScale}
          strokeDasharray={dashArray}
        />
      </g>
    );
  }
}
