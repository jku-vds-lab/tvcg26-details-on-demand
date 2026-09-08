// src/renderers/TextLayerRenderer.ts
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

export class TextLayerRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(
    parent: HTMLElement,
    width: number,
    height: number,
    dpr: number = window.devicePixelRatio || 1
  ) {
    this.canvas = document.createElement("canvas");
    this.canvas.width  = width  * dpr;
    this.canvas.height = height * dpr;
    Object.assign(this.canvas.style, {
      position:      "absolute",
      top:           "0",
      left:          "0",
      width:         `${width}px`,
      height:        `${height}px`,
      pointerEvents: "none",
    });
    parent.style.position = parent.style.position || "relative";
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;
  }

  /**
   * @param nodes  all DataPoint[]
   * @param m      the 3×3 transform matrix as a flat number[]
   */
  draw(nodes: DataPoint[], m: number[]) {
    const ctx = this.ctx;
    const cw  = this.canvas.width;
    const ch  = this.canvas.height;

    ctx.clearRect(0, 0, cw, ch);

    const fontSize = 12 * (window.devicePixelRatio || 1);
    ctx.font         = `${fontSize}px sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth    = 4 * (window.devicePixelRatio || 1);
    ctx.strokeStyle  = "white";
    ctx.fillStyle    = "black";

    for (const node of nodes) {
      if (!node.action) continue;
      const c = node.nextEdgeCenter;
      if (c.x == null || c.y == null) continue;

      // data -> clip
      const tx = m[0] * c.x + m[3] * c.y + m[6];
      const ty = m[1] * c.x + m[4] * c.y + m[7];
      // clip -> screen
      const x  = (tx * 0.5 + 0.5) * cw;
      const y  = (1 - (ty * 0.5 + 0.5)) * ch;

      ctx.strokeText(node.action, x, y);
      ctx.fillText  (node.action, x, y);
    }
  }
}