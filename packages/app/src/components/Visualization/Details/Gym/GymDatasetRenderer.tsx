import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { majorityVote } from "src/utils/majorityVote";
import {
    BaseInsetRenderer,
    BoundingBox,
    InsetBoundingBoxOptions,
} from "../BaseInsetRenderer";
import { edgeSidesOf } from "../edgeSides";
import GymEdgeDiffInset from "./GymEdgeDiffInset";
import GymRenderInset, { GYM_INSET_SIZE } from "./GymRenderInset";

export type GymInsetBoundingBoxOptions =
  | { mode: "text"; annotationText: string; fontSize: number }
  | { mode: "gym"; scaleFactor: number; size?: number };

// Split edge samples into their start and end states
function edgeSplit(samples: DataPoint[]) {
  const sides = edgeSidesOf(samples);
  if (sides) return sides;
  const starts: DataPoint[] = [];
  const ends: DataPoint[] = [];
  for (const s of samples) {
    const a = (s as DataPoint & { edgeStart?: DataPoint }).edgeStart;
    const b = (s as DataPoint & { edgeEnd?: DataPoint }).edgeEnd;
    if (a) starts.push(a);
    if (b) ends.push(b);
  }
  return { starts, ends };
}

/** Diff sides for the gym edge inset (exported for tests): prefer the two
 * clusters' FULL memberships (attached by useCreateRelationInsetElements)
 * over the transition endpoint pairs. The endpoint pairs are one physics
 * step apart, and one step barely changes a render — mean(starts) vs
 * mean(ends) washes out to a no-difference image for smooth envs. Comparing
 * the clusters matches the hover diff's semantics (HoverDiffGlyphs pairs
 * full memberships). */
export function pickGymDiffSides(samples: DataPoint[]): {
  starts: DataPoint[];
  ends: DataPoint[];
} {
  const first = samples[0] as
    | (DataPoint & { edgeClusterStart?: DataPoint[]; edgeClusterEnd?: DataPoint[] })
    | undefined;
  if (first?.edgeClusterStart?.length && first?.edgeClusterEnd?.length) {
    return { starts: first.edgeClusterStart, ends: first.edgeClusterEnd };
  }
  return edgeSplit(samples);
}

// Order-independent signature for sets of points
const pointIdCache = new WeakMap<DataPoint, string>();

function getPointId(point: DataPoint): string {
  const cached = pointIdCache.get(point);
  if (cached) return cached;
  const id =
    point.id !== undefined && point.id !== null
      ? String(point.id)
      : `${point.x},${point.y}`;
  pointIdCache.set(point, id);
  return id;
}

function signatureForPoints(points: DataPoint[]): string {
  const ids = new Array<string>(points.length);
  for (let i = 0; i < points.length; i++) {
    ids[i] = getPointId(points[i]);
  }
  ids.sort();
  return ids.join("|");
}

const LABEL_PLACEHOLDER = "label";

/** Renderer for datasetType "gymnasium": inset images come from the local
 * Python render service (on-demand env.render() of recorded states) instead
 * of a hand-coded per-env reimplementation. See plan-gym-render-insets.md. */
export class GymDatasetRenderer extends BaseInsetRenderer {
  static readonly defaultScaleBounds = { insetMinScale: 0.8, insetMaxScale: 1.2 };

  computeInsetBoundingBox(
    options: InsetBoundingBoxOptions | GymInsetBoundingBoxOptions
  ): BoundingBox {
    if (options.mode === "text") {
      const { annotationText, fontSize } = options;
      return this.computeTextBoundingBox(annotationText, fontSize);
    } else if (options.mode === "gym") {
      const { scaleFactor, size = GYM_INSET_SIZE } = options;
      const side = size * scaleFactor;
      return {
        x: 0,
        y: 0,
        width: side,
        height: side,
        minX: 0,
        minY: 0,
        maxX: side,
        maxY: side,
      };
    }
    throw new Error("Invalid options provided to computeInsetBoundingBox");
  }

  renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveSingleNodeLabel(clusterSamples, this.resolveAnnotationColumn("label"), LABEL_PLACEHOLDER);
    const fontSize = this.scaleAnnotationFont(18);
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, {
      setBBox: true,
    });
  }

  renderGroupNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveGroupNodeLabel(clusterSamples, this.resolveAnnotationColumn("label"), LABEL_PLACEHOLDER);
    const fontSize = this.scaleAnnotationFont(18);
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, {
      setBBox: true,
    });
  }

  renderSingleEdgeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    return this.renderEdgeActionAnnotationText(clusterSamples, { fontPx: 24 });
  }

  renderGroupEdgeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    return this.renderEdgeActionAnnotationText(clusterSamples, { fontPx: 24 });
  }

  renderSingleNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyTransform(clusterSamples);
    const bbox = this.computeInsetBoundingBox({ mode: "gym", scaleFactor: scale });
    this.setBoundingBox(bbox);
    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

    const samplesSig = signatureForPoints(clusterSamples);
    const insetElement = (
      <div
        style={{
          width: bbox.width,
          height: bbox.height,
          overflow: "visible",
          pointerEvents: "none",
          filter: `drop-shadow(0px ${offsetY}px ${blur}px ${color})`,
        }}
      >
        <GymRenderInset
          clusterSamples={clusterSamples}
          scaleFactor={scale}
          samplesSig={samplesSig}
        />
      </div>
    );

    const overlayLabel = this.resolveGroupNodeLabel(clusterSamples, this.resolveAnnotationColumn("label"), LABEL_PLACEHOLDER, "inset");
    const overlay = this.renderOverlayAnnotationText(
      overlayLabel,
      clusterSamples.length,
      18
    );
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(18));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }

  renderGroupNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleNodeInset(clusterSamples);
  }

  renderSingleEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyEdgeTransform(clusterSamples);
    const { starts, ends } = pickGymDiffSides(clusterSamples);

    const bbox = this.computeInsetBoundingBox({ mode: "gym", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

    // Per-pixel diverging diff (end − start luminance of the two rendered
    // mean images, CCTV palette). When one side is missing, fall back to the
    // Phase-1 transition mean (ghosting between the poses).
    const inner =
      starts.length > 0 && ends.length > 0 ? (
        <GymEdgeDiffInset
          startSamples={starts}
          endSamples={ends}
          scaleFactor={scale}
          startSig={signatureForPoints(starts)}
          endSig={signatureForPoints(ends)}
        />
      ) : (
        <GymRenderInset
          clusterSamples={[...starts, ...ends]}
          scaleFactor={scale}
          samplesSig={signatureForPoints([...starts, ...ends])}
        />
      );

    const insetElement = (
      <div
        style={{
          width: bbox.width,
          height: bbox.height,
          overflow: "visible",
          pointerEvents: "none",
          filter: `drop-shadow(0px ${offsetY}px ${blur}px ${color})`,
        }}
      >
        {inner}
      </div>
    );

    const actions = clusterSamples.map((s) => String(s.action ?? ""));
    const { label, multiple } = majorityVote(actions);
    const overlayLabel = multiple ? `${label} +` : label;
    const overlay = this.renderOverlayAnnotationText(
      overlayLabel,
      clusterSamples.length,
      24
    );
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(24));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }

  renderGroupEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleEdgeInset(clusterSamples);
  }
}
