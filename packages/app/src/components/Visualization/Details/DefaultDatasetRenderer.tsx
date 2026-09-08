import { groupHeadRows, groupMembersOf } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { prefersAbstractInsets } from "src/datasets/catalog";
import store from "src/store";
import {
  deferredColumnNames,
  ensureResidentColumns,
  pendingDeferredColumns,
} from "src/dataPreprocessing/lazyColumns";
import { actionMajorityColumnarOf } from "src/utils/actionMajority";
import { majorityVoteBy } from "src/utils/majorityVote";
import AbstractDetailViewInset, { ABSTRACT_INSET_BASE_WIDTH_PX, SVG_ASPECT_RATIO } from "./Abstract/AbstractDetailViewInset";
import { actionLabelOf, BaseInsetRenderer, BoundingBox, InsetBoundingBoxOptions } from "./BaseInsetRenderer";
import { edgeSidesOf } from "./edgeSides";
import { collectFeatureColumns, type FeatureColumn } from "./Tabular/featureStats";
import {
  tabularInsetBaseHeightPx,
  tabularInsetBaseWidthPx,
} from "./Tabular/tabularInsetLayout";
import {
  FeatureDiffInsetContainer,
  FeatureSummaryInsetContainer,
} from "./Tabular/TabularFeatureInsets";

// Same convention as the Chess/Rubiks/CCTV/MNIST/CartPole renderers: edge
// (diff) samples carry the two related sides as edgeStart/edgeEnd.
type EdgeCarryingSample = DataPoint & { edgeStart?: DataPoint; edgeEnd?: DataPoint };

function edgeSplit(samples: DataPoint[]) {
  const sides = edgeSidesOf(samples);
  if (sides) return sides;
  const starts: DataPoint[] = [];
  const ends: DataPoint[] = [];
  for (const s of samples as EdgeCarryingSample[]) {
    if (s.edgeStart) starts.push(s.edgeStart);
    if (s.edgeEnd) ends.push(s.edgeEnd);
  }
  return { starts, ends };
}

const maxNameLength = (columns: readonly FeatureColumn[]): number =>
  columns.reduce((m, c) => Math.max(m, c.column.length), 0);

export type DefaultInsetBoundingBoxOptions =
  | InsetBoundingBoxOptions
  | { mode: "abstract"; scaleFactor: number }
  | { mode: "tabular"; scaleFactor: number; rowCount: number; maxNameLength: number };

const DEFAULT_PLACEHOLDER_LABEL = "label";
const DEFAULT_LABEL_FEATURE = "label";

export class DefaultDatasetRenderer extends BaseInsetRenderer {
  // Uniform card size: the count-scaled growth (old max 2) made large-cluster
  // cards twice as big as needed — the card content doesn't get richer with
  // cluster size, only the stats get more support.
  static readonly defaultScaleBounds = { insetMinScale: 1, insetMaxScale: 1 };

  /**
   * Computes the bounding box for the inset.
   * Supports text mode (annotations), abstract mode (placeholder SVG detail
   * view), and tabular mode (feature summary/diff card).
   */
  computeInsetBoundingBox(options: DefaultInsetBoundingBoxOptions): BoundingBox {
    if (options.mode === "abstract") {
      const width = ABSTRACT_INSET_BASE_WIDTH_PX * options.scaleFactor;
      const height = width * SVG_ASPECT_RATIO;
      return { x: 0, y: 0, width, height, minX: 0, minY: 0, maxX: width, maxY: height };
    }
    if (options.mode === "tabular") {
      const width = tabularInsetBaseWidthPx(options.maxNameLength) * options.scaleFactor;
      const height = tabularInsetBaseHeightPx(options.rowCount) * options.scaleFactor;
      return { x: 0, y: 0, width, height, minX: 0, minY: 0, maxX: width, maxY: height };
    }
    const { annotationText, fontSize } = options;
    return this.computeTextBoundingBox(annotationText, fontSize);
  }

  renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const fontSize = this.scaleAnnotationFont(18);
    const annotationText = this.resolveSingleNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(DEFAULT_LABEL_FEATURE),
      DEFAULT_PLACEHOLDER_LABEL
    );
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, { setBBox: true });
  }

  renderGroupNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const fontSize = this.scaleAnnotationFont(18);
    const annotationText = this.resolveGroupNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(DEFAULT_LABEL_FEATURE),
      DEFAULT_PLACEHOLDER_LABEL
    );
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, { setBBox: true });
  }

  renderSingleEdgeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    return this.renderEdgeActionAnnotationText(clusterSamples, { fontPx: 24, forceLabel: "label" });
  }

  renderGroupEdgeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    return this.renderEdgeActionAnnotationText(clusterSamples, { fontPx: 24, forceLabel: "label" });
  }

  /**
   * The card content renders at base size (fixed row/font px, so internal
   * scrolling has stable hit targets) and the whole card is scaled to the
   * inset's bbox with a CSS transform.
   */
  private wrapScaledCard(content: JSX.Element, bbox: BoundingBox, scale: number): JSX.Element {
    return (
      <div style={{ width: bbox.width, height: bbox.height, overflow: "visible" }}>
        <div
          style={{
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            width: bbox.width / scale,
            height: bbox.height / scale,
          }}
        >
          {content}
        </div>
      </div>
    );
  }

  /** Paper-figure parity (2026-08-05): the guiding/combination catalog
   * entries pin the pre-tabular abstract placeholder so the paper's figure
   * deep links reproduce the printed look — their rows DO carry feature
   * columns, which would otherwise select the (newer) tabular card. */
  private abstractPinned(): boolean {
    return prefersAbstractInsets(store.getState().dataset.datasetPath);
  }

  /** Deferred feature columns (issue #315 R3c, same mechanism as the
   * `action` overlay above): when the probe finds nothing because the
   * dataset's feature columns are still server-resident, trigger the ONE
   * on-demand fetch — this frame renders the abstract placeholder, and the
   * attach-driven re-render (deferredColumnsRevision bump) swaps in the
   * tabular card. Idempotent; shared in-flight fetches. */
  private ensureDeferredFeatureColumns(clusterSamples: readonly DataPoint[]): void {
    const canonical = groupMembersOf(clusterSamples)?.nodes ?? clusterSamples;
    const pending = pendingDeferredColumns(canonical, deferredColumnNames(canonical));
    if (pending.length > 0) {
      void ensureResidentColumns(canonical, pending).catch(() => undefined);
    }
  }

  renderSingleNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    if (this.abstractPinned()) return this.renderAbstractNodeInset(clusterSamples);
    const columns = collectFeatureColumns(clusterSamples);
    if (columns.length === 0) {
      this.ensureDeferredFeatureColumns(clusterSamples);
      return this.renderAbstractNodeInset(clusterSamples);
    }

    const { scale } = this.applyTransform(clusterSamples);
    const bbox = this.computeInsetBoundingBox({
      mode: "tabular",
      scaleFactor: scale,
      rowCount: columns.length,
      maxNameLength: maxNameLength(columns),
    });
    this.setBoundingBox(bbox);
    const inset = this.wrapScaledCard(
      <FeatureSummaryInsetContainer
        samples={clusterSamples}
        columns={columns}
        widthPx={bbox.width / scale}
      />,
      bbox,
      scale
    );

    const overlayLabel = this.resolveTabularNodeLabel(clusterSamples);
    if (overlayLabel === null) {
      // Nothing meaningful to show — the card header already summarizes.
      return this.composeInsetWithOverlay(inset, bbox, <></>);
    }
    // Same overlay-label treatment as the Rubik's insets: standard downward
    // drop shadow, honoring the annotation-label-scale setting (#305).
    const labelFontPx = this.scaleAnnotationFont(18 * scale);
    const overlay = this.renderTextLabelSvg(overlayLabel, clusterSamples.length, labelFontPx, { setBBox: false });
    const labelBbox = this.computeTextBoundingBox(overlayLabel, labelFontPx);
    return this.composeInsetWithOverlay(inset, bbox, overlay, { gapPx: 2, labelBbox });
  }

  renderGroupNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleNodeInset(clusterSamples);
  }

  /**
   * Node-inset overlay label: the standard resolution (assigned labels,
   * inline drafts, TF-IDF, the annotationLabelFeature column) when it yields
   * something real, otherwise the majority of the mapped action column —
   * the closest thing user tabular datasets have to a class label. Null ⇒
   * render no overlay (never the literal "label" placeholder).
   */
  private resolveTabularNodeLabel(clusterSamples: DataPoint[]): string | null {
    const resolved = this.resolveGroupNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(DEFAULT_LABEL_FEATURE),
      DEFAULT_PLACEHOLDER_LABEL,
      "inset"
    );
    if (resolved !== DEFAULT_PLACEHOLDER_LABEL && resolved.trim() !== "") return resolved;
    // Deferred `action` column (issue #315 R3c, §8.8c — the one hardcoded
    // overlay name has NO core-residency exception): trigger the on-demand
    // fetch; the label renders blank for this frame and fills on the
    // attach-driven re-render (deferredColumnsRevision bump).
    const specNodes = groupMembersOf(clusterSamples)?.nodes;
    if (specNodes !== undefined && pendingDeferredColumns(specNodes, ["action"]).length > 0) {
      void ensureResidentColumns(specNodes, ["action"]).catch(() => undefined);
    }
    const { label, multiple } =
      actionMajorityColumnarOf(clusterSamples) ??
      majorityVoteBy(clusterSamples, actionLabelOf);
    if (label.trim() === "") return null;
    return multiple ? `${label} +` : label;
  }

  /** Pre-tabular placeholder inset, kept for datasets without feature columns. */
  private renderAbstractNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyTransform(clusterSamples);
    const bbox = this.computeInsetBoundingBox({ mode: "abstract", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const insetElement = (
      <AbstractDetailViewInset scaleFactor={scale} count={clusterSamples.length} />
    );

    const overlayLabel = this.resolveGroupNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(DEFAULT_LABEL_FEATURE),
      DEFAULT_PLACEHOLDER_LABEL,
      "inset"
    );
    const labelFontPx = this.scaleAnnotationFont(18 * scale);
    const overlay = this.renderTextLabelSvg(overlayLabel, clusterSamples.length, labelFontPx, { setBBox: false });
    const labelBbox = this.computeTextBoundingBox(overlayLabel, labelFontPx);
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { gapPx: 2, labelBbox });
  }

  renderSingleEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    if (this.abstractPinned()) return this.renderAbstractEdgeInset(clusterSamples);
    const { starts, ends } = edgeSplit(clusterSamples);
    if (starts.length > 0 && ends.length > 0) {
      // Column DETECTION probes values, it doesn't aggregate — a bounded
      // head of each side finds the same columns without materializing a
      // combined array of both full memberships (2×840k at 1M hover diffs).
      // The sides are the ORIGINAL group arrays, so on index-backed groups
      // (issue #315 R1c) the rows must resolve through the member spec — a
      // direct slice spreads their holes as `undefined`.
      const canonical =
        groupMembersOf(starts)?.nodes ?? groupMembersOf(ends)?.nodes;
      const columns = collectFeatureColumns(
        [...groupHeadRows(starts, 64), ...groupHeadRows(ends, 64)],
        canonical ? { canonical } : undefined
      );
      if (columns.length === 0) {
        this.ensureDeferredFeatureColumns(starts);
        this.ensureDeferredFeatureColumns(ends);
      }
      if (columns.length > 0) {
        const { scale } = this.applyEdgeTransform(clusterSamples);
        const bbox = this.computeInsetBoundingBox({
          mode: "tabular",
          scaleFactor: scale,
          rowCount: columns.length,
          maxNameLength: maxNameLength(columns),
        });
        this.setBoundingBox(bbox);
        const inset = this.wrapScaledCard(
          <FeatureDiffInsetContainer
            aSamples={starts}
            bSamples={ends}
            columns={columns}
            widthPx={bbox.width / scale}
          />,
          bbox,
          scale
        );

        // Diff insets keep the action-majority overlay (the action role is
        // user-selected in the upload wizard, so it is meaningful by choice).
        const { label, multiple } = majorityVoteBy(clusterSamples, actionLabelOf);
        const overlayLabel = multiple ? `${label} +` : label;
        if (overlayLabel.trim() === "") return this.composeInsetWithOverlay(inset, bbox, <></>);
        const edgeLabelFontPx = this.scaleAnnotationFont(24 * scale);
        const overlay = this.renderTextLabelSvg(overlayLabel, clusterSamples.length, edgeLabelFontPx, { setBBox: false });
        const labelBbox = this.computeTextBoundingBox(overlayLabel, edgeLabelFontPx);
        return this.composeInsetWithOverlay(inset, bbox, overlay, { gapPx: 2, labelBbox });
      }
    }
    return this.renderAbstractEdgeInset(clusterSamples);
  }

  renderGroupEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleEdgeInset(clusterSamples);
  }

  /** Pre-tabular placeholder edge inset (no usable edgeStart/edgeEnd sides). */
  private renderAbstractEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyEdgeTransform(clusterSamples);
    const bbox = this.computeInsetBoundingBox({ mode: "abstract", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const insetElement = (
      <AbstractDetailViewInset scaleFactor={scale} count={clusterSamples.length} />
    );

    const edgeLabelFontPx = this.scaleAnnotationFont(24 * scale);
    const overlay = this.renderTextLabelSvg(DEFAULT_PLACEHOLDER_LABEL, clusterSamples.length, edgeLabelFontPx, { setBBox: false });
    const labelBbox = this.computeTextBoundingBox(DEFAULT_PLACEHOLDER_LABEL, edgeLabelFontPx);
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { gapPx: 2, labelBbox });
  }
}
