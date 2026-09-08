// src/types/catmull-rom-interpolator.d.ts
declare module "catmull-rom-interpolator" {
    function catmullRomInterpolator(
      points: number[][],
      alpha: number,
      resolution: number,
      isPolygon: boolean
    ): number[][];
    
    export default catmullRomInterpolator;
  }
  