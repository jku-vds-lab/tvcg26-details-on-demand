import { groupMemberRefs } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { majorityVote } from "src/utils/majorityVote";
import { BaseInsetRenderer } from "../BaseInsetRenderer";
import { edgeSidesOf } from "../edgeSides";
import RubiksCubeInset from "./RubiksCubeInset";
import RubiksEdgeDiffInset from "./RubiksEdgeDiffInset";
import RubiksEdgeSingleInset from "./RubiksEdgeSingleInset";

// Exported for the holey-group regression test (issue #315 R1c): on an
// index-backed group array a direct slot map yields a hole-degenerate
// signature ("||…") that collides in the aggregation caches keyed by it —
// the member refs read the id column without building rows.
export function signatureForSamples(samples: DataPoint[]): string {
  const refs = groupMemberRefs(samples);
  const ids = refs
    ? refs.map((r) => String(r.id))
    : samples.map((s) => s.id ?? `${s.x},${s.y}`);
  ids.sort();
  return ids.join("|");
}

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

function signatureForPoints(points: DataPoint[]): string {
  return signatureForSamples(points);
}

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

type InsetBoundingBoxOptions =
  | { mode: "text"; annotationText: string; fontSize: number }
  | { mode: "rubiks"; scaleFactor: number; fineTuningScale?: number; baseSize?: number; baseDistance?: number };

export class RubiksDatasetRenderer extends BaseInsetRenderer {
  static readonly defaultScaleBounds = { insetMinScale: 1, insetMaxScale: 2 };
  private static readonly NODE_LABEL_FEATURE = "phase";
  private static readonly NODE_LABEL_PLACEHOLDER = "label";

  computeInsetBoundingBox(options: InsetBoundingBoxOptions): BoundingBox {
    if (options.mode === "text") {
      const { annotationText, fontSize } = options;
      return this.computeTextBoundingBox(annotationText, fontSize);
    }
    if (options.mode === "rubiks") {
      const { scaleFactor, fineTuningScale = 0.3, baseSize = 20, baseDistance = 1 } = options;
      const effectiveSize = baseSize * fineTuningScale;
      const effectiveDistance = baseDistance * fineTuningScale;
      const minX = 0;
      const maxX = 6 * (effectiveSize + effectiveDistance) + 2 * (effectiveSize + effectiveDistance) + effectiveSize;
      const minY = 0;
      const maxY = 9 * (effectiveSize + effectiveDistance) + 2 * (effectiveSize + effectiveDistance) + effectiveSize;
      const overallWidth = maxX - minX;
      const overallHeight = maxY - minY;
      return {
        x: minX,
        y: minY,
        width: overallWidth * scaleFactor,
        height: overallHeight * scaleFactor,
        minX: minX * scaleFactor,
        minY: minY * scaleFactor,
        maxX: minX * scaleFactor + overallWidth * scaleFactor,
        maxY: minY * scaleFactor + overallHeight * scaleFactor,
      };
    }
    throw new Error("Invalid options provided to computeInsetBoundingBox");
  }

  renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveSingleNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(RubiksDatasetRenderer.NODE_LABEL_FEATURE),
      RubiksDatasetRenderer.NODE_LABEL_PLACEHOLDER
    );
    const fontSize = this.scaleAnnotationFont(18);
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, { setBBox: true });
  }

  renderGroupNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveGroupNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(RubiksDatasetRenderer.NODE_LABEL_FEATURE),
      RubiksDatasetRenderer.NODE_LABEL_PLACEHOLDER
    );
    const fontSize = this.scaleAnnotationFont(18);
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, { setBBox: true });
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
    const samplesSig = signatureForSamples(clusterSamples);

    const insetSvg = <RubiksCubeInset clusterSamples={clusterSamples} scaleFactor={scale} samplesSig={samplesSig} />;

    const bbox = this.computeInsetBoundingBox({ mode: "rubiks", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

    const insetElement = <div style={{ filter: `drop-shadow(0px ${offsetY}px ${blur}px ${color})` }}>{insetSvg}</div>;

    const overlayLabel = this.resolveGroupNodeLabel(
      clusterSamples,
      this.resolveAnnotationColumn(RubiksDatasetRenderer.NODE_LABEL_FEATURE),
      RubiksDatasetRenderer.NODE_LABEL_PLACEHOLDER,
      "inset"
    );

    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 18);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(18));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }

  renderGroupNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleNodeInset(clusterSamples);
  }

  // Single transition: gray touch-mask showing which stickers the move touches.
  renderSingleEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyEdgeTransform(clusterSamples);
    const samplesSig = signatureForSamples(clusterSamples);

    const bbox = this.computeInsetBoundingBox({ mode: "rubiks", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const inset = (
      <RubiksEdgeSingleInset
        clusterSamples={clusterSamples}
        scaleFactor={scale}
        samplesSig={samplesSig}
      />
    );

    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

    const insetElement = <div style={{ filter: `drop-shadow(0px ${offsetY}px ${blur}px ${color})` }}>{inset}</div>;

    const actions = clusterSamples.map((s) => String(s.action ?? ""));
    const { label, multiple } = majorityVote(actions);
    const overlayLabel = multiple ? `${label} +` : label;

    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 24);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(24));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }

  // Set of transitions: sticker diff showing which stickers changed color and how confidently.
  renderGroupEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyEdgeTransform(clusterSamples);
    const { starts, ends } = edgeSplit(clusterSamples);

    const startSig = signatureForPoints(starts);
    const endSig   = signatureForPoints(ends);

    const bbox = this.computeInsetBoundingBox({ mode: "rubiks", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const inset = (
      <RubiksEdgeDiffInset
        startSamples={starts}
        endSamples={ends}
        scaleFactor={scale}
        samplesSig={`${startSig}::${endSig}`}
      />
    );

    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

    const insetElement = <div style={{ filter: `drop-shadow(0px ${offsetY}px ${blur}px ${color})` }}>{inset}</div>;

    const actions = clusterSamples.map((s) => String(s.action ?? ""));
    const { label, multiple } = majorityVote(actions);
    const overlayLabel = multiple ? `${label} +` : label;

    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 24);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(24));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }
}
