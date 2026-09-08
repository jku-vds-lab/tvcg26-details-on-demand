import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { BaseInsetRenderer, BoundingBox, InsetBoundingBoxOptions } from "../BaseInsetRenderer";
import { edgeSidesOf } from "../edgeSides";
import { majorityVote } from "src/utils/majorityVote";
import store, { type RootState } from "src/store";
import MnistImageInset from "./MnistImageInset";
import MnistEdgeDiffInset from "./MnistEdgeDiffInset";
import { imagePixelUnit, resolveImageShape, type ImageShape } from "./imageGrid";

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

export type MnistInsetBoundingBoxOptions =
  | { mode: "text"; annotationText: string; fontSize: number }
  | { mode: "mnist"; scaleFactor: number };

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

/**
 * Image insets over an inlined pixel grid. The MNIST preset reads 28×28 and
 * labels by "digit"; the generic `"image"` dataset type reuses it with the
 * grid from the dataset metadata (the widget's `image_shape`) and the
 * standard `label` column.
 */
export class MnistDatasetRenderer extends BaseInsetRenderer {
  static readonly defaultScaleBounds = { insetMinScale: 1, insetMaxScale: 2 };

  constructor(private readonly labelColumn: string = "digit") {
    super();
  }

  /** Read per render, like the annotation column: the metadata can change with the dataset. */
  private imageShape(): ImageShape {
    return resolveImageShape(store.getState() as RootState);
  }

  computeInsetBoundingBox(
    options: InsetBoundingBoxOptions | MnistInsetBoundingBoxOptions
  ): BoundingBox {
    if (options.mode === "text") {
      const { annotationText, fontSize } = options;
      return this.computeTextBoundingBox(annotationText, fontSize);
    } else if (options.mode === "mnist") {
      const shape = this.imageShape();
      const unit = imagePixelUnit(shape) * options.scaleFactor;
      const width = shape.cols * unit;
      const height = shape.rows * unit;
      const x = 0;
      const y = 0;
      return { x, y, width, height, minX: x, minY: y, maxX: x + width, maxY: y + height };
    }
    throw new Error("Invalid options provided to computeInsetBoundingBox");
  }

  renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveSingleNodeLabel(clusterSamples, this.resolveAnnotationColumn(this.labelColumn), "");
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
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveGroupNodeLabel(clusterSamples, this.resolveAnnotationColumn(this.labelColumn), "");
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
    const bbox = this.computeInsetBoundingBox({ mode: "mnist", scaleFactor: scale });
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
        <MnistImageInset
          clusterSamples={clusterSamples}
          scaleFactor={scale}
          samplesSig={samplesSig}
          shape={this.imageShape()}
        />
      </div>
    );

    const overlayLabel = this.resolveGroupNodeLabel(clusterSamples, this.resolveAnnotationColumn(this.labelColumn), "", "inset");
    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 18);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(18));
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
    const bbox = this.computeInsetBoundingBox({ mode: "mnist", scaleFactor: scale });
    this.setBoundingBox(bbox);
    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";
    const inset = (
      <MnistEdgeDiffInset
        startSamples={starts}
        endSamples={ends}
        scaleFactor={scale}
        samplesSig={`${startSig}::${endSig}`}
        shape={this.imageShape()}
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
