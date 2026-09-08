/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the component by design; dev HMR full-reloads this file (CS 2026-07-09) */
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import store, { RootState } from "src/store";
import { majorityVoteBy } from "src/utils/majorityVote";
import { groupClusterUidOf } from "src/clustering/groupClusterUid";
import { groupFirstRow, groupMembersOf, groupVoteRows } from "src/clustering/groupMembers";
import { columnMajorityColumnarOf } from "src/utils/actionMajority";
import {
  ensureResidentColumns,
  pendingDeferredColumns,
} from "src/dataPreprocessing/lazyColumns";

export const ANNOTATION_LABEL_SCALE_PREVIEW_MULT_VAR = "--annotation-label-scale-preview-mult";
export const ASSIGNED_LABEL_OVERRIDE_FEATURE = "__assignedLabel";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Transform {
  x: number;
  y: number;
  scale: number;
}

export function previewScaledFontSizePx(fontSizePx: number): string {
  return `calc(${fontSizePx}px * var(${ANNOTATION_LABEL_SCALE_PREVIEW_MULT_VAR}, 1))`;
}

export type PreviewableSvgTextProps = {
  label: string;
  x: number;
  y: number;
  fontSizePx: number;
  dy?: string;
  textAnchor?: "start" | "middle" | "end";
  fontFamily?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  paintOrder?: string;
  dominantBaseline?: "auto" | "middle" | "hanging" | "central" | "text-after-edge" | "text-before-edge";
};

/**
 * Shared “single source of truth” text element that supports the hot-path preview multiplier.
 * Only fontSize is preview-scaled; strokeWidth stays stable to better match commit rendering.
 */
export function PreviewableSvgText({
  label,
  x,
  y,
  fontSizePx,
  dy,
  textAnchor = "middle",
  fontFamily = "sans-serif",
  fill = "black",
  stroke = "white",
  strokeWidth = 4,
  paintOrder = "stroke fill markers",
  dominantBaseline,
}: PreviewableSvgTextProps): JSX.Element {
  return (
    <text
      x={x}
      y={y}
      dy={dy}
      textAnchor={textAnchor}
      dominantBaseline={dominantBaseline}
      paintOrder={paintOrder}
      fontFamily={fontFamily}
      fontSize={fontSizePx}
      style={{ fontSize: previewScaledFontSizePx(fontSizePx) }}
      fill={fill}
      stroke={stroke}
      strokeWidth={strokeWidth}
      vectorEffect="non-scaling-stroke"
    >
      {label}
    </text>
  );
}

/**
 * Safely extracts the annotation value from a DataPoint for a given column.
 */
export function getAnnotationValue(point: DataPoint, column: string): string {
  const override = point.features?.[ASSIGNED_LABEL_OVERRIDE_FEATURE];
  if (override !== undefined && override !== null && String(override).trim().length > 0) {
    return String(override);
  }

  const featureValue = point.features?.[column];
  if (featureValue !== undefined && featureValue !== null && String(featureValue).trim().length > 0) {
    return String(featureValue);
  }

  if (column in point) return String(point[column as keyof DataPoint] ?? "");
  return "";
}

/** Per-sample action label for single-pass majority votes (issue #315 I2):
 * avoids materializing an O(members) string array per inset render. */
export function actionLabelOf(point: DataPoint): string {
  const raw = point.action;
  if (raw === undefined || raw === null) return "";
  return typeof raw === "string" ? raw : String(raw);
}

export function getAnnotationValueOrPlaceholder(
  point: DataPoint,
  column: string,
  placeholder: string
): string {
  const raw = getAnnotationValue(point, column).trim();
  return raw.length > 0 ? raw : placeholder;
}

export type InsetBoundingBoxOptions = {
  mode: "text";
  annotationText: string;
  fontSize: number;
};

type TextLabelStyle = {
  fontFamily?: string;
  dy?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  paintOrder?: string;
  dominantBaseline?: PreviewableSvgTextProps["dominantBaseline"];
};

type RenderTextLabelOptions = {
  /** Whether to call setBoundingBox(bbox). IMPORTANT: keep false for overlays. */
  setBBox?: boolean;
  style?: TextLabelStyle;
};

/** Majority-vote group labels by samples-array identity (see
 * resolveGroupNodeLabel) — inner map key is `${column}|${placeholder}`. */
let groupLabelCache = new WeakMap<DataPoint[], Map<string, string>>();

/**
 * Drops every cached majority vote. The votes read the per-row
 * `__assignedLabel` overrides, which the labeling write-back
 * (`syncAssignmentsIntoVisualizationImpl`) mutates in place on arrays whose
 * identity does not change — so it must call this, or unchanged clusters
 * keep showing pre-assignment labels until a re-cluster (issue #352).
 */
export function invalidateGroupLabelCache(): void {
  groupLabelCache = new WeakMap();
}

export abstract class BaseInsetRenderer {
  public id: string = Math.random().toString(36).substring(7);

  protected currentTransform: Transform = { x: 0, y: 0, scale: 1 };
  protected currentBoundingBox: BoundingBox = {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
  };

  public boundingBoxCallCount: number = 0;

  abstract renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderGroupNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderSingleEdgeAnnotation(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderGroupEdgeAnnotation(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderSingleNodeInset(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderGroupNodeInset(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderSingleEdgeInset(clusterSamples: DataPoint[]): JSX.Element;
  abstract renderGroupEdgeInset(clusterSamples: DataPoint[]): JSX.Element;

  // Subclasses accept their own option unions (method params are bivariant).
  abstract computeInsetBoundingBox(options: unknown): BoundingBox;

  protected computeScaleFactor(clusterSamples: DataPoint[]): number {
    const { insetMinScale, insetMaxScale, scaleExponent } = (store.getState() as RootState).clusterSettings;
    const raw = Math.pow(clusterSamples.length, scaleExponent);
    return Math.min(Math.max(raw, insetMinScale), insetMaxScale);
  }

  protected computeEdgeScaleFactor(clusterSamples: DataPoint[]): number {
    const { edgeInsetMinScale, edgeInsetMaxScale, edgeScaleExponent } = (store.getState() as RootState).visualizationSettings;
    const raw = Math.pow(Math.max(clusterSamples.length, 1), edgeScaleExponent);
    return Math.min(Math.max(raw, edgeInsetMinScale), edgeInsetMaxScale);
  }

  protected applyEdgeTransform(clusterSamples: DataPoint[]): Transform {
    const scale = this.computeEdgeScaleFactor(clusterSamples);
    this.setTransform({ x: 0, y: 0, scale });
    return { x: 0, y: 0, scale };
  }

  protected applyTransform(clusterSamples: DataPoint[]): Transform {
    const scale = this.computeScaleFactor(clusterSamples);
    this.setTransform({ x: 0, y: 0, scale });
    return { x: 0, y: 0, scale };
  }

  setTransform(transform: Transform): void {
    this.currentTransform = transform;
  }

  getTransform(): Transform {
    return this.currentTransform;
  }

  setBoundingBox(bbox: BoundingBox): void {
    this.boundingBoxCallCount++;
    this.currentBoundingBox = bbox;
    // Any fresh bbox invalidates a previous visual override (composeInsetWithOverlay
    // re-establishes it after extending the layout bbox with the label region).
    this.visualBoundingBox = undefined;
  }

  getBoundingBox(): BoundingBox {
    return this.currentBoundingBox;
  }

  /**
   * The bounding box of the visually rendered inset body (e.g. the chess board),
   * excluding the overlay-label region that `composeInsetWithOverlay` unions into
   * the layout bbox for the annealer. Leader-line clipping must use this box so
   * arrow tips land exactly on the rendered border. Falls back to the layout bbox
   * when no overlay label extended it.
   */
  protected visualBoundingBox?: BoundingBox;

  getVisualBoundingBox(): BoundingBox {
    return this.visualBoundingBox ?? this.currentBoundingBox;
  }

  hasIntrinsicBoundingBox(): boolean {
    return this.currentBoundingBox.width > 0 && this.currentBoundingBox.height > 0;
  }

  updateBoundingBoxForPositionChange(): void {
    this.setBoundingBox(this.currentBoundingBox);
  }

  protected computeTextBoundingBox(text: string, fontSize: number): BoundingBox {
    const horizontalMultiplier = 0.5;
    const verticalMultiplier = 1.1;
    const approxWidth = text.length * fontSize * horizontalMultiplier;
    const approxHeight = fontSize * verticalMultiplier;
    const x = -approxWidth / 2;
    const y = -approxHeight * 0.8;
    return {
      x,
      y,
      width: approxWidth,
      height: approxHeight,
      minX: x,
      minY: y,
      maxX: x + approxWidth,
      maxY: y + approxHeight,
    };
  }

  protected scaleAnnotationFont(basePx: number): number {
    const scale = (store.getState() as RootState).visualizationSettings.annotationLabelScale ?? 1;
    return basePx * scale;
  }

  /**
   * Single point of truth for renderer-emitted SVG label blocks.
   * Preview relies on: --annotation-label-scale-preview-mult on an ancestor.
   */
  protected renderTextLabelSvg(label: string, count: number, fontSizePx: number, opts: RenderTextLabelOptions = {}): JSX.Element {
    const setBBox = opts.setBBox ?? true;
    const style = opts.style ?? {};

    const bbox = this.computeInsetBoundingBox({
      mode: "text",
      annotationText: label,
      fontSize: fontSizePx,
    });

    if (setBBox) this.setBoundingBox(bbox);

    const shadowColor = "rgba(0,0,0,0.5)";
    const blur = Math.min(10, Math.sqrt(Math.max(count, 1)) * 2);
    const offsetY = blur / 2;

    return (
      <svg
        width={bbox.width}
        height={bbox.height}
        viewBox={`${bbox.minX} ${bbox.minY} ${bbox.width} ${bbox.height}`}
        style={{
          overflow: "visible",
          pointerEvents: "none",
          filter: `drop-shadow(0px ${offsetY}px ${blur}px ${shadowColor})`,
        }}
      >
        <PreviewableSvgText
          label={label}
          x={0}
          y={0}
          dy={style.dy ?? ".3em"}
          dominantBaseline={style.dominantBaseline}
          textAnchor="middle"
          fontFamily={style.fontFamily ?? "sans-serif"}
          fontSizePx={fontSizePx}
          fill={style.fill ?? "black"}
          stroke={style.stroke ?? "white"}
          strokeWidth={style.strokeWidth ?? 4}
          paintOrder={style.paintOrder ?? "stroke fill markers"}
        />
      </svg>
    );
  }

  protected renderEdgeActionAnnotationText(samples: DataPoint[], opts?: { forceLabel?: string; fontPx?: number }): JSX.Element {
    const count = samples.length;
    const base = opts?.fontPx ?? 24;
    const fontSize = this.scaleAnnotationFont(base);

    let label: string;
    if (opts?.forceLabel) {
      label = opts.forceLabel;
    } else if (count === 1) {
      label = String(samples[0].action ?? "");
    } else {
      const { label: maj, multiple } = majorityVoteBy(samples, actionLabelOf);
      label = multiple ? `${maj} +` : maj;
    }

    return this.renderTextLabelSvg(label, count, fontSize, { setBBox: true });
  }

  protected resolveGroupNodeLabel(
    samples: DataPoint[],
    column: string,
    placeholder: string,
    layer: "annotation" | "inset" = "annotation",
  ): string {
    if (!samples.length) return placeholder;
    const inlineDraft = this.resolveInlineDraft(samples, placeholder, layer);
    if (inlineDraft !== null) return inlineDraft;
    const strategy = (store.getState() as RootState).visualizationSettings.clusterLabelStrategy;
    if (strategy === "tfidf") {
      return this.resolveViaTfIdf(samples, placeholder, layer);
    }
    // Majority vote is O(members) with a per-point accessor call and runs per
    // RENDER per inset — measured ~9% of the budget-slider burst at 1M
    // (issue #315). Features are immutable and reconcile keeps sample-array
    // instances stable, so the result caches by array identity + column.
    let perColumn = groupLabelCache.get(samples);
    if (!perColumn) {
      perColumn = new Map();
      groupLabelCache.set(samples, perColumn);
    }
    const cacheKey = `${column}|${placeholder}`;
    let resolved = perColumn.get(cacheKey);
    if (resolved === undefined) {
      // Deferred column not yet fetched (issue #315 R3c, §8.8c): trigger the
      // one-time on-demand fetch — the SAME mechanism as every other column
      // consumer, no core-residency exception. The interim majority below
      // votes all-placeholder; it is NOT cached, so the render after the
      // attach (deferredColumnsRevision bump) resolves the real label.
      const specNodes = groupMembersOf(samples)?.nodes;
      const pending =
        specNodes !== undefined && pendingDeferredColumns(specNodes, [column]).length > 0;
      if (pending) void ensureResidentColumns(specNodes!, [column]).catch(() => undefined);
      // Index-backed groups (issue #315 R1c) hold no rows — the majority
      // resolves from the sidecar column when one serves; otherwise vote
      // over the member rows the spec resolves (strided while rows are not
      // resident — display-only). Plain arrays keep the exact member walk.
      const columnar = columnMajorityColumnarOf(samples, column, placeholder);
      if (columnar) {
        resolved = columnar.multiple ? `${columnar.label} +` : columnar.label;
      } else {
        const voteRows = groupVoteRows(samples, 4096);
        const { label, multiple } = majorityVoteBy(voteRows ?? samples, (s) =>
          getAnnotationValueOrPlaceholder(s, column, placeholder)
        );
        resolved = multiple ? `${label} +` : label;
      }
      if (!pending) perColumn.set(cacheKey, resolved);
    }
    return resolved;
  }

  protected resolveSingleNodeLabel(
    samples: DataPoint[],
    column: string,
    placeholder: string,
    layer: "annotation" | "inset" = "annotation",
  ): string {
    if (!samples.length) return placeholder;
    const inlineDraft = this.resolveInlineDraft(samples, placeholder, layer);
    if (inlineDraft !== null) return inlineDraft;
    const strategy = (store.getState() as RootState).visualizationSettings.clusterLabelStrategy;
    if (strategy === "tfidf") {
      return this.resolveViaTfIdf(samples, placeholder, layer);
    }
    // groupFirstRow: index-backed groups (issue #315 R1c) resolve member 0
    // through the spec — the slot itself is a hole.
    const first = groupFirstRow(samples);
    return first ? getAnnotationValueOrPlaceholder(first, column, placeholder) : placeholder;
  }

  // Returns the live draft string if this cluster is being inline-edited, or null
  // if this cluster is not the active one. Null means "fall through to normal logic".
  private resolveInlineDraft(
    samples: DataPoint[],
    placeholder: string,
    layer: "annotation" | "inset",
  ): string | null {
    const labelingState = (store.getState() as RootState).labeling;
    if (!labelingState.activeInlineClusterUid) return null;
    const uid = this.clusterUidOf(samples, layer);
    if (uid === null) return null;
    if (uid !== labelingState.activeInlineClusterUid) return null;
    return labelingState.activeInlineDraft || placeholder;
  }

  /**
   * The uid of the cluster these samples belong to (issue #315 R1a step 5):
   * from the group registry on the cut-driven lane — where no cluster id is
   * stamped onto points any more — and from the sample's own cluster-id field
   * on the legacy groupBy lane. Null when neither knows.
   */
  private clusterUidOf(samples: DataPoint[], layer: "annotation" | "inset"): string | null {
    const registered = groupClusterUidOf(samples);
    if (registered !== undefined) return registered;
    const field = layer === "inset" ? "insetClusterId" : "annotationClusterId";
    const raw = samples[0]?.[field];
    return raw === undefined || raw === null ? null : String(raw);
  }

  // Inset clusters are grouped by `insetClusterId` (see useCreateInsetClusterElements),
  // so the corpus key for inset items is the inset cluster's UID, not the annotation
  // cluster's. Pick the matching field per layer; otherwise inset overlays look up
  // a key that was never put into the TF-IDF map and always fall back to placeholder.
  private resolveViaTfIdf(
    samples: DataPoint[],
    placeholder: string,
    layer: "annotation" | "inset",
  ): string {
    // User-assigned label always takes priority over TF-IDF computation.
    // groupFirstRow: spec-resolved on index-backed groups (issue #315 R1c).
    const override = groupFirstRow(samples)?.features?.[ASSIGNED_LABEL_OVERRIDE_FEATURE];
    if (override !== undefined && override !== null && String(override).trim().length > 0) {
      return String(override);
    }
    const clusterId = this.clusterUidOf(samples, layer);
    if (clusterId === null) return placeholder;
    const label = (store.getState() as RootState).visualizationSettings.tfidfLabels[clusterId];
    return label !== undefined && label.length > 0 ? label : placeholder;
  }

  /**
   * Returns the user-selected annotation feature column, falling back to the
   * dataset-specific default when no override is set.
   */
  protected resolveAnnotationColumn(datasetDefault: string): string {
    const override = (store.getState() as RootState).visualizationSettings.annotationLabelFeature;
    return override ?? datasetDefault;
  }

  protected renderOverlayAnnotationText(label: string, count: number, basePx: number = 24): JSX.Element {
    const fontSize = this.scaleAnnotationFont(basePx);
    // IMPORTANT: do not overwrite inset bbox
    return this.renderTextLabelSvg(label, count, fontSize, { setBBox: false });
  }

  /**
   * Returns a bounding box that is the union of `insetBbox` and a label box
   * sitting `effectiveGapPx` above the inset's top edge, centered horizontally.
   * Used by `composeInsetWithOverlay` so the layout engine reserves space for
   * the overlay label and avoids overlapping adjacent insets with it.
   */
  protected unionInsetLabelBBox(
    insetBbox: BoundingBox,
    labelBbox: BoundingBox,
    effectiveGapPx: number
  ): BoundingBox {
    const totalWidth = Math.max(insetBbox.width, labelBbox.width);
    const totalHeight = insetBbox.height + effectiveGapPx + labelBbox.height;
    return {
      x: 0, y: 0,
      width: totalWidth, height: totalHeight,
      minX: 0, minY: 0, maxX: totalWidth, maxY: totalHeight,
    };
  }

  protected composeInsetWithOverlay(
    inset: JSX.Element,
    bbox: BoundingBox,
    overlay: JSX.Element,
    opts?: { position?: "top-center"; gapPx?: number; labelBbox?: BoundingBox }
  ): JSX.Element {
    const position = opts?.position ?? "top-center";
    const baseGap = opts?.gapPx ?? 6;

    const committedScale = (store.getState() as RootState).visualizationSettings.annotationLabelScale ?? 1;
    const gapExpr = `${baseGap}px * ${committedScale} * var(${ANNOTATION_LABEL_SCALE_PREVIEW_MULT_VAR}, 1)`;

    // Extend the stored bbox to include the overlay label region so the annealer
    // accounts for label height when computing inset overlaps. The inset-only bbox
    // is kept as the visual bbox for leader-line clipping (the rendered div below
    // is inset-sized and centered; the label overlays outside it).
    if (opts?.labelBbox) {
      const effectiveGap = baseGap * committedScale;
      this.setBoundingBox(this.unionInsetLabelBBox(bbox, opts.labelBbox, effectiveGap));
      this.visualBoundingBox = bbox;
    }

    return (
      <div
        style={{
          width: bbox.width,
          height: bbox.height,
          overflow: "visible",
          pointerEvents: "none",
          position: "relative",
        }}
      >
        {/* Overlay label BEFORE the inset in paint order: its downward
            drop-shadow (renderTextLabelSvg) spills past the gap onto the
            card's top edge, and a shadow must never wash out inset content —
            the card paints over it instead. */}
        {position === "top-center" && (
          <div
            style={{
              position: "absolute",
              left: bbox.width / 2,
              top: -bbox.minY,
              transform: `translate(-50%, calc(-100% - (${gapExpr})))`,
              pointerEvents: "none",
            }}
          >
            {overlay}
          </div>
        )}

        <div style={{ position: "absolute", left: -bbox.minX, top: -bbox.minY }}>{inset}</div>
      </div>
    );
  }

  protected wrapSvgWithBoundingBox(element: JSX.Element, bbox: BoundingBox): JSX.Element {
    return (
      <svg
        width={bbox.width}
        height={bbox.height}
        viewBox={`${bbox.minX} ${bbox.minY} ${bbox.width} ${bbox.height}`}
        style={{ overflow: "visible", pointerEvents: "none" }}
      >
        <g>{element}</g>
      </svg>
    );
  }

  protected wrapHtmlWithBoundingBox(element: JSX.Element, bbox: BoundingBox): JSX.Element {
    return (
      <div
        style={{
          position: "relative",
          width: bbox.width,
          height: bbox.height,
          border: "1px solid black",
        }}
      >
        {element}
      </div>
    );
  }
}
