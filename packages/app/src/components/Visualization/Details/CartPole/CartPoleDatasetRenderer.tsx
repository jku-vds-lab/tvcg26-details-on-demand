import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { BaseInsetRenderer, BoundingBox, getAnnotationValue, InsetBoundingBoxOptions } from "../BaseInsetRenderer";
import { edgeSidesOf } from "../edgeSides";
import { majorityVote } from "src/utils/majorityVote";
import CartPoleImageInset from "./CartPoleImageInset";
import CartPoleEdgeDiffInset from "./CartPoleEdgeDiffInset";

/** Synthetic edge samples carry their endpoint DataPoints (set by the edge pipeline). */
type EdgeSample = DataPoint & { edgeStart?: DataPoint; edgeEnd?: DataPoint };

function edgeSplit(samples: DataPoint[]) {
  const sides = edgeSidesOf(samples);
  if (sides) return sides;
  const starts: DataPoint[] = [];
  const ends:   DataPoint[] = [];
  for (const s of samples) {
    const a = (s as EdgeSample).edgeStart;
    const b = (s as EdgeSample).edgeEnd;
    if (a) starts.push(a);
    if (b) ends.push(b);
  }
  return { starts, ends };
}

function signatureForPoints(points: DataPoint[]): string {
  const ids = new Array<string>(points.length);
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    ids[i] = p.id !== undefined && p.id !== null ? String(p.id) : `${points[i].x},${points[i].y}`;
  }
  ids.sort();
  return ids.join("|");
}

export type CartPoleInsetBoundingBoxOptions =
  | { mode: "text"; annotationText: string; fontSize: number }
  | { mode: "cartpole"; scaleFactor: number; width?: number; height?: number };

export class CartPoleDatasetRenderer extends BaseInsetRenderer {
  static readonly defaultScaleBounds = { insetMinScale: 1, insetMaxScale: 2 };

  computeInsetBoundingBox(
    options: InsetBoundingBoxOptions | CartPoleInsetBoundingBoxOptions
  ): BoundingBox {
    if (options.mode === "text") {
      const { annotationText, fontSize } = options;
      return this.computeTextBoundingBox(annotationText, fontSize);
    } else if (options.mode === "cartpole") {
      const { scaleFactor, width = 120, height = 80 } = options;
      const w = width * scaleFactor;
      const h = height * scaleFactor;
      const x = 0;
      const y = 0;
      return { x, y, width: w, height: h, minX: x, minY: y, maxX: x + w, maxY: y + h };
    }
    throw new Error("Invalid options provided to computeInsetBoundingBox");
  }

  private averageTheta(clusterSamples: DataPoint[]): number {
    let sum = 0;
    for (const s of clusterSamples) {
      const v = Number(getAnnotationValue(s, "obs2"));
      if (Number.isFinite(v)) sum += v;
    }
    return sum / (clusterSamples.length || 1);
  }

  renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const theta = this.averageTheta(clusterSamples);
    const deg = (theta * 180) / Math.PI;
    const annotationText = `θ=${deg.toFixed(1)}°`;
    const fontSize = this.scaleAnnotationFont(18);
    const bbox = this.computeInsetBoundingBox({ mode: "text", annotationText, fontSize });
    this.setBoundingBox(bbox);
    const element = (
      <text
        paintOrder="stroke fill markers"
        textAnchor="middle"
        fontFamily="sans-serif"
        fontSize={fontSize}
        fill="black"
        stroke="white"
        strokeWidth={4}
      >
        {annotationText}
      </text>
    );
    return this.wrapSvgWithBoundingBox(element, bbox);
  }

  renderGroupNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleNodeAnnotation(clusterSamples);
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
    const bbox = this.computeInsetBoundingBox({ mode: "cartpole", scaleFactor: scale });
    this.setBoundingBox(bbox);
    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

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
        <CartPoleImageInset clusterSamples={clusterSamples} scaleFactor={scale} />
      </div>
    );

    const theta = this.averageTheta(clusterSamples);
    const label = `θ=${((theta * 180) / Math.PI).toFixed(1)}°`;
    const overlay = this.renderOverlayAnnotationText(label, clusterSamples.length, 18);
    const labelBbox = this.computeTextBoundingBox(label, this.scaleAnnotationFont(18));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }

  renderGroupNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleNodeInset(clusterSamples);
  }
  renderSingleEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyEdgeTransform(clusterSamples);
    const { starts, ends } = edgeSplit(clusterSamples);
    const startSig = signatureForPoints(starts);
    const endSig   = signatureForPoints(ends);
    const bbox = this.computeInsetBoundingBox({ mode: "cartpole", scaleFactor: scale });
    this.setBoundingBox(bbox);
    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";
    const inset = (
      <CartPoleEdgeDiffInset
        startSamples={starts}
        endSamples={ends}
        scaleFactor={scale}
        samplesSig={`${startSig}::${endSig}`}
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
        {inset}
      </div>
    );
    const actions = clusterSamples.map((s) => String(s.action ?? ""));
    const { label, multiple } = majorityVote(actions);
    const overlayLabel = multiple ? `${label} +` : label;
    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 24);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(24));
    return this.composeInsetWithOverlay(insetElement, bbox, overlay, { labelBbox });
  }
  renderGroupEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleEdgeInset(clusterSamples);
  }
}
