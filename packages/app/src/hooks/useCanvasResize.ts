import * as d3 from "d3";
import { useEffect } from "react";
import { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { RendererAPI } from "../gl/api/RendererAPI";
import { updateRendererTransform } from "../semanticZoom/semanticZoom";
import { computeScales } from "../utils/computeScales";

export interface UseCanvasResizeProps {
  canvasContainerRef: React.RefObject<HTMLDivElement>;
  data: DataPoint[];
  zoomTransformRef: React.MutableRefObject<d3.ZoomTransform>;
  setScales: React.Dispatch<
    React.SetStateAction<{
      xScale: d3.ScaleLinear<number, number>;
      yScale: d3.ScaleLinear<number, number>;
    } | null>
  >;
  currentZoomParamsRef: React.MutableRefObject<{
    width: number;
    height: number;
    xScale: d3.ScaleLinear<number, number>;
    yScale: d3.ScaleLinear<number, number>;
  } | null>;
  rendererRef: React.MutableRefObject<RendererAPI | null>;
}

const useCanvasResize = ({
  canvasContainerRef,
  data,
  zoomTransformRef,
  setScales,
  currentZoomParamsRef,
  rendererRef,
}: UseCanvasResizeProps): void => {
  useEffect(() => {
    if (!canvasContainerRef.current || data.length === 0) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const newWidth = entry.contentRect.width;
        const newHeight = entry.contentRect.height;
        const dpr = window.devicePixelRatio || 1;

        // Resize the renderer and canvas using the API.
        const renderer = rendererRef.current;
        renderer?.setSize(newWidth, newHeight, dpr);

        // Recompute scales using the helper function.
        const { xScale: newXScale, yScale: newYScale } = computeScales(newWidth, newHeight, data);
        setScales({ xScale: newXScale, yScale: newYScale });

        // Update current zoom parameters.
        currentZoomParamsRef.current = {
          width: newWidth,
          height: newHeight,
          xScale: newXScale,
          yScale: newYScale,
        };

        // Update the renderer transform and redraw the scene using the current zoom transform.
        if (renderer) {
          updateRendererTransform(
            zoomTransformRef.current,
            newWidth,
            newHeight,
            newXScale,
            newYScale,
            renderer
          );
          renderer.render();
        }
      }
    });
    resizeObserver.observe(canvasContainerRef.current);
    return () => {
      resizeObserver.disconnect();
    };
  }, [canvasContainerRef, data, setScales, currentZoomParamsRef, rendererRef, zoomTransformRef]);
};

export default useCanvasResize;
