import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { majorityVote } from "src/utils/majorityVote";
import { BaseInsetRenderer } from "../BaseInsetRenderer";
import { edgeSidesOf } from "../edgeSides";
import ChessBoardInset from "./ChessBoardInset";
import { EDGE_BOARD_FINE_TUNE, isMeaningfulChessLabel } from "./chessDiffEncoding";
import ChessEdgeDiffInset from "./ChessEdgeDiffInset";

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

type ChessInsetBoundingBoxOptions =
  | { mode: "text"; annotationText: string; fontSize: number }
  | { mode: "chess"; tileSize?: number; fineTuneScale?: number; scaleFactor?: number };

export class ChessDatasetRenderer extends BaseInsetRenderer {
  static readonly defaultScaleBounds = { insetMinScale: 1.0, insetMaxScale: 2.0 };

  computeInsetBoundingBox(options: ChessInsetBoundingBoxOptions): BoundingBox {
    if (options.mode === "text") {
      const { annotationText, fontSize } = options;
      return this.computeTextBoundingBox(annotationText, fontSize);
    }
    if (options.mode === "chess") {
      const tile = (options.tileSize ?? 20) * (options.fineTuneScale ?? 0.5) * (options.scaleFactor ?? 1);
      const size = 8 * tile;
      return { x: 0, y: 0, width: size, height: size, minX: 0, minY: 0, maxX: size, maxY: size };
    }
    throw new Error("Invalid options in computeInsetBoundingBox");
  }

  renderSingleNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveSingleNodeLabel(clusterSamples, this.resolveAnnotationColumn("algo"), "");
    const fontSize = this.scaleAnnotationFont(18);
    return this.renderTextLabelSvg(annotationText, clusterSamples.length, fontSize, { setBBox: true });
  }

  renderGroupNodeAnnotation(clusterSamples: DataPoint[]): JSX.Element {
    this.setTransform({ x: 0, y: 0, scale: 1 });
    const annotationText = this.resolveGroupNodeLabel(clusterSamples, this.resolveAnnotationColumn("algo"), "");
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
    const bbox = this.computeInsetBoundingBox({ mode: "chess", scaleFactor: scale });
    this.setBoundingBox(bbox);

    const inset = (
      <div style={{ filter: "drop-shadow(0px 0px 10px rgba(0,0,0,0.35))" }}>
        <ChessBoardInset clusterSamples={clusterSamples} scaleFactor={scale} />
      </div>
    );

    const overlayLabel = this.resolveGroupNodeLabel(clusterSamples, this.resolveAnnotationColumn("algo"), "", "inset");
    if (!isMeaningfulChessLabel(overlayLabel)) {
      // No usable label (e.g. chess40k's numeric algo codes): keep the board
      // bbox tight — no label region for the annealer to reserve.
      return this.composeInsetWithOverlay(inset, bbox, <></>);
    }
    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 18);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(18));
    return this.composeInsetWithOverlay(inset, bbox, overlay, { labelBbox });
  }

  renderGroupNodeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleNodeInset(clusterSamples);
  }

  renderSingleEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    const { scale } = this.applyEdgeTransform(clusterSamples);
    const { starts, ends } = edgeSplit(clusterSamples);

    const bbox = this.computeInsetBoundingBox({ mode: "chess", fineTuneScale: EDGE_BOARD_FINE_TUNE, scaleFactor: scale });
    this.setBoundingBox(bbox);

    const inset = (
      <div style={{ filter: "drop-shadow(0px 0px 10px rgba(0,0,0,0.35))" }}>
        <ChessEdgeDiffInset
          startSamples={starts}
          endSamples={ends}
          scaleFactor={scale}
          samplesSig={`${starts.length}|${ends.length}`}
        />
      </div>
    );

    const actions = clusterSamples.map((s) => String(s.action ?? ""));
    const { label, multiple } = majorityVote(actions);
    const overlayLabel = multiple ? `${label} +` : label;
    if (!isMeaningfulChessLabel(overlayLabel)) {
      return this.composeInsetWithOverlay(inset, bbox, <></>);
    }

    const overlay = this.renderOverlayAnnotationText(overlayLabel, clusterSamples.length, 24);
    const labelBbox = this.computeTextBoundingBox(overlayLabel, this.scaleAnnotationFont(24));
    return this.composeInsetWithOverlay(inset, bbox, overlay, { labelBbox });
  }

  renderGroupEdgeInset(clusterSamples: DataPoint[]): JSX.Element {
    return this.renderSingleEdgeInset(clusterSamples);
  }
}
