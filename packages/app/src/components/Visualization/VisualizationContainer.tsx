import * as d3 from "d3";
import React from "react";
import { useRTreeReady } from "src/contexts/RTreeContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import ClusterVisualizations from "../ClusterVisualizations";
import CanvasContainer from "./CanvasContainer";

interface VisualizationContainerProps {
  canvasContainerRef: React.RefObject<HTMLDivElement>;
  scales: { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> } | null;
  zoomTransform: d3.ZoomTransform;
  data: DataPoint[];
  handleLassoComplete: (selectedIds: number[], ctrlKey: boolean, altKey?: boolean) => void;
  annotationLayerRef: React.Ref<HTMLDivElement>;
  isZoomingRef: React.MutableRefObject<boolean>;
  /** True while a pure-pan gesture is in flight (issue #322): ClusterVisualizations freezes its spatial queries. */
  panGestureRef?: React.MutableRefObject<boolean>;
  reheatRef: React.MutableRefObject<() => void>;
}

const VisualizationContainer: React.FC<VisualizationContainerProps> = ({
  canvasContainerRef,
  scales,
  zoomTransform,
  annotationLayerRef,
  isZoomingRef,
  panGestureRef,
  reheatRef,
}) => {
  const { ready: rTreeReady } = useRTreeReady();
  return (
    <>
      <CanvasContainer ref={canvasContainerRef} />
      {scales && rTreeReady && canvasContainerRef.current && (
          <ClusterVisualizations
            scales={scales}
            zoomTransform={zoomTransform}
            canvasContainer={canvasContainerRef.current}
            annotationLayerRef={annotationLayerRef}
            isZoomingRef={isZoomingRef}
            panGestureRef={panGestureRef}
            reheatRef={reheatRef}
          />
      )}
    </>
  );
};

export default VisualizationContainer;
