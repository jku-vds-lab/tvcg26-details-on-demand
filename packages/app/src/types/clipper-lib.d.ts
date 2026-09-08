// src/types/clipper-lib.d.ts
declare module 'clipper-lib' {
  export interface IntPoint { X: number; Y: number }
  export enum JoinType { jtSquare = 0, jtRound = 1, jtMiter = 2 }
  export enum EndType { etClosedPolygon = 0, etOpenSquare = 1, etOpenRound = 2 }

  export class ClipperOffset {
    constructor(miterLimit?: number, roundPrecision?: number);
    AddPath(path: IntPoint[], joinType: JoinType, endType: EndType): void;
    Execute(solution: IntPoint[][], delta: number): void;
  }
}
