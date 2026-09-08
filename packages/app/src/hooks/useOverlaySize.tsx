import React, { useEffect } from "react";

export function useOverlaySize(
  containerRef: React.RefObject<HTMLElement>,
  overlayRef: React.RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const container = containerRef.current;
    const overlay = overlayRef.current;
    if (!container || !overlay) return;

    const ctx = overlay.getContext("2d");
    if (!ctx) return;

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;

      // Set backing store dimensions
      overlay.width = Math.floor(width * dpr);
      overlay.height = Math.floor(height * dpr);

      // Keep CSS size at logical pixels
      overlay.style.width = `${Math.floor(width)}px`;
      overlay.style.height = `${Math.floor(height)}px`;

      // Reset any existing transform, then scale so 1 unit = 1 CSS px
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, width, height);
    };

    // Observe container size changes
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // Initial sizing
    resize();

    return () => {
      ro.disconnect();
    };
  }, [containerRef, overlayRef]);
}
