import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { majorityVote } from "src/utils/majorityVote";
import {
    BaseInsetRenderer,
    BoundingBox,
    InsetBoundingBoxOptions,
} from "../BaseInsetRenderer";
import { edgeSidesOf } from "../edgeSides";
import CCTVImageInset, {
    CCTV_IMAGE_HEIGHT,
    CCTV_IMAGE_WIDTH,
} from "./CCTVImageInset";
import CCTVEdgeDiffInset from "./CCTVEdgeDiffInset";

export type CCTVInsetBoundingBoxOptions =
  | { mode: "text"; annotationText: string; fontSize: number }
  | {
      mode: "cctv";
      scaleFactor: number;
      width?: number;
      height?: number;
    };

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

export class CCTVDatasetRenderer extends BaseInsetRenderer {
  static readonly defaultScaleBounds = { insetMinScale: 0.8, insetMaxScale: 1.2 };

  computeInsetBoundingBox(
    options: InsetBoundingBoxOptions | CCTVInsetBoundingBoxOptions
  ): BoundingBox {
    if (options.mode === "text") {
      const { annotationText, fontSize } = options;
      return this.computeTextBoundingBox(annotationText, fontSize);
    } else if (options.mode === "cctv") {
      const { scaleFactor, width = CCTV_IMAGE_WIDTH, height = CCTV_IMAGE_HEIGHT } = options;
      const w = width * scaleFactor;
      const h = height * scaleFactor;
      const x = 0;
      const y = 0;
      return {
        x,
        y,
        width: w,
        height: h,
        minX: x,
        minY: y,
        maxX: x + w,
        maxY: y + h,
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
    const bbox = this.computeInsetBoundingBox({
      mode: "cctv",
      scaleFactor: scale,
    });
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
        <CCTVImageInset
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
    const { starts, ends } = edgeSplit(clusterSamples);
    const startSig = signatureForPoints(starts);
    const endSig = signatureForPoints(ends);

    const bbox = this.computeInsetBoundingBox({
      mode: "cctv",
      scaleFactor: scale,
    });
    this.setBoundingBox(bbox);

    const count = clusterSamples.length;
    const blur = Math.min(10, Math.sqrt(count) * 2);
    const offsetY = blur / 2;
    const color = "rgba(0,0,0,0.5)";

    const inset = (
      <CCTVEdgeDiffInset
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
