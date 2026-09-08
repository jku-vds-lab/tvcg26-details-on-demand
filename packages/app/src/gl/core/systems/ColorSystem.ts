import type { DataPoint } from "../../../dataPreprocessing/dataPreprocessing";
import type { SegmentColumns } from "../../../dataPreprocessing/splineColumns";
import type { DoiThresholds } from "../../../utils/doiColorScale";
import { sampleDoiColorAt } from "../../../utils/doiColorScale";
import type { ColorEncoding } from "../../api/types";
import { encodeColorToVec3, getColorEncodingKey } from "../../utils/colors";
import { ARROW_FLOATS_PER_VERT, EDGE_FLOATS_PER_VERT, segmentCountOf } from "./GeometrySystem";

export type ColorScaleFn = (key: string | number) => string;

/** Allocation-free numeric sampler for the current encoding, or null when it
 * has no numeric domain — see utils/colorScale.resolveNumericColorRamp. */
export type NumericRampFn = (encoding: string) => {
  writeRgb01(key: number, out: Float32Array, base: number): void;
} | null;

function palettesEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ColorSystem {
  private palette: string[];
  private doiThresholds: DoiThresholds;
  private readonly colorScaleFn: ColorScaleFn;
  private readonly numericRampFn: NumericRampFn | null;
  private doiColorLut: Float32Array;
  private static readonly DOI_LUT_SIZE = 256;

  constructor(
    initialPalette: string[],
    doiThresholds: DoiThresholds,
    colorScaleFn: ColorScaleFn,
    numericRampFn: NumericRampFn | null = null
  ) {
    this.palette = [...initialPalette];
    this.doiThresholds = { ...doiThresholds };
    this.colorScaleFn = colorScaleFn;
    this.numericRampFn = numericRampFn;
    this.doiColorLut = this.buildDoiColorLut();
  }

  updatePalette(nextPalette: string[]): boolean {
    if (palettesEqual(this.palette, nextPalette)) return false;
    this.palette = [...nextPalette];
    this.doiColorLut = this.buildDoiColorLut();
    return true;
  }

  updateDoiThresholds(next: DoiThresholds): boolean {
    const unchanged =
      this.doiThresholds.hidden === next.hidden &&
      this.doiThresholds.labeled === next.labeled &&
      this.doiThresholds.inset === next.inset;
    if (unchanged) return false;

    this.doiThresholds = { ...next };
    this.doiColorLut = this.buildDoiColorLut();
    return true;
  }

  private buildDoiColorLut(): Float32Array {
    const size = ColorSystem.DOI_LUT_SIZE;
    const out = new Float32Array(size * 3);
    for (let i = 0; i < size; i++) {
      const t = i / (size - 1);
      const rgb = encodeColorToVec3(sampleDoiColorAt(t, this.doiThresholds, this.palette), {
        r: 0,
        g: 0,
        b: 0,
      });
      const base = i * 3;
      out[base + 0] = rgb[0];
      out[base + 1] = rgb[1];
      out[base + 2] = rgb[2];
    }
    return out;
  }

  private writeDoiColor(out: Float32Array, outBase: number, doiRaw: number): void {
    const t = Math.min(1, Math.max(0, doiRaw));
    const idx = Math.round(t * (ColorSystem.DOI_LUT_SIZE - 1)) * 3;
    out[outBase + 0] = this.doiColorLut[idx + 0];
    out[outBase + 1] = this.doiColorLut[idx + 1];
    out[outBase + 2] = this.doiColorLut[idx + 2];
  }

  private resolveDoiValue(point: DataPoint, doiValues?: Float32Array, indexById?: Map<number, number>): number | null {
    if (!doiValues || !indexById) return null;
    const nodeIndex = indexById.get(point.id);
    if (nodeIndex === undefined || nodeIndex < 0 || nodeIndex >= doiValues.length) return null;
    return doiValues[nodeIndex];
  }

  buildNodeColors(nodes: DataPoint[], encoding: ColorEncoding, doiValues?: Float32Array, maxNodes = nodes.length): Float32Array {
    const count = Math.max(0, Math.min(maxNodes, nodes.length));
    const out = new Float32Array(count * 3);

    if (encoding === "DoI" && doiValues) {
      const n = Math.min(count, doiValues.length);
      for (let i = 0; i < n; i++) {
        this.writeDoiColor(out, i * 3, doiValues[i]);
      }
      for (let i = n; i < count; i++) {
        this.writeDoiColor(out, i * 3, 0);
      }
      return out;
    }

    // Rebuild fast paths (issue #315 color-by freeze — an encoding change at
    // 1M froze the tab for seconds): numeric-domain keys write through the
    // allocation-free ramp (no per-point hex build + regex parse), everything
    // else memoizes the scale per DISTINCT key. Both are value-identical to
    // the plain per-point scale calls: the ramp is quantization-exact by
    // contract, and the scale is deterministic per key within one rebuild
    // (discovery still sees each distinct key exactly once).
    const ramp = encoding ? this.numericRampFn?.(encoding) ?? null : null;
    const memo = new Map<string | number, [number, number, number]>();
    const fallback: [number, number, number] = encodeColorToVec3("#1b9e77", { r: 0, g: 0, b: 0 });

    for (let i = 0; i < count; i++) {
      const n = nodes[i];
      const colorKey =
        encoding === "DoI" && doiValues && i < doiValues.length
          ? doiValues[i]
          : getColorEncodingKey(n, encoding);

      const base = i * 3;
      if (colorKey === null) {
        out[base + 0] = fallback[0];
        out[base + 1] = fallback[1];
        out[base + 2] = fallback[2];
        continue;
      }
      if (ramp && typeof colorKey === "number" && Number.isFinite(colorKey)) {
        ramp.writeRgb01(colorKey, out, base);
        continue;
      }
      let rgb = memo.get(colorKey);
      if (!rgb) {
        const enc = encodeColorToVec3(this.colorScaleFn(colorKey), { r: 0, g: 0, b: 0 });
        rgb = [enc[0], enc[1], enc[2]];
        memo.set(colorKey, rgb);
      }
      out[base + 0] = rgb[0];
      out[base + 1] = rgb[1];
      out[base + 2] = rgb[2];
    }

    return out;
  }

  /**
   * Columns-direct node colors (issue #315 B1 boot paint): same output as
   * buildNodeColors over materialized rows, but fed by one sidecar column —
   * numeric OR dictionary (issue #315 R1a step 7: categorical encodings used
   * to fall back to the flat default here and only colored once the rows path
   * took over, which stops being an option when rows are lazy). `col` is the
   * encoding's column (null when the dataset has no such column — every node
   * then gets the same default color the rows path produces for a null key).
   * `doiValues` covers the DoI encoding, matching the rows path's LUT branch.
   * Per-value memoization: the scale function runs once per distinct value,
   * so a dictionary column costs one scale call per CATEGORY.
   */
  buildNodeColorsFromColumn(
    col: ArrayLike<number> | ArrayLike<string | number | boolean | null> | null,
    count: number,
    doiValues?: Float32Array,
    /** The encoding the column belongs to (issue #315 R1b): resolves the same
     * numeric ramp the rows path uses. Without it a continuous column would
     * memoize one entry per DISTINCT VALUE — a 1M-entry Map at synth1m — where
     * the rows path writes through the allocation-free ramp. Optional so the
     * boot-paint call sites stay unchanged. */
    encoding?: ColorEncoding
  ): Float32Array {
    const out = new Float32Array(count * 3);

    if (doiValues) {
      const n = Math.min(count, doiValues.length);
      for (let i = 0; i < n; i++) this.writeDoiColor(out, i * 3, doiValues[i]);
      for (let i = n; i < count; i++) this.writeDoiColor(out, i * 3, 0);
      return out;
    }

    if (!col) {
      const rgb = encodeColorToVec3("#1b9e77", { r: 0, g: 0, b: 0 });
      for (let i = 0; i < count; i++) {
        const base = i * 3;
        out[base + 0] = rgb[0];
        out[base + 1] = rgb[1];
        out[base + 2] = rgb[2];
      }
      return out;
    }

    // Per-DISTINCT-VALUE memo — the categories → RGB lookup table (issue #315
    // R1a step 7). Dictionary columns (sidecar FORMAT v2) decode to arrays of
    // their category VALUES, which are exactly the keys the rows path feeds
    // the scale, so a categorical encoding colors byte-identically here
    // without materializing a single row.
    const memo = new Map<string | number | boolean, [number, number, number]>();
    const nullRgb = encodeColorToVec3("#1b9e77", { r: 0, g: 0, b: 0 });
    const ramp = encoding ? this.numericRampFn?.(encoding) ?? null : null;
    for (let i = 0; i < count; i++) {
      const v = col[i];
      const base0 = i * 3;
      if (ramp && typeof v === "number" && Number.isFinite(v)) {
        ramp.writeRgb01(v, out, base0);
        continue;
      }
      // A missing cell colors like a null key on the rows path.
      let rgb = v === null || v === undefined
        ? ([nullRgb[0], nullRgb[1], nullRgb[2]] as [number, number, number])
        : memo.get(v);
      if (!rgb) {
        const encoded = encodeColorToVec3(this.colorScaleFn(v as string | number), { r: 0, g: 0, b: 0 });
        rgb = [encoded[0], encoded[1], encoded[2]];
        memo.set(v as string | number | boolean, rgb);
      }
      const base = i * 3;
      out[base + 0] = rgb[0];
      out[base + 1] = rgb[1];
      out[base + 2] = rgb[2];
    }
    return out;
  }

  /** Endpoint DataPoint via the renderer's id index (columns carry ids only;
   * during load streaming an endpoint may not be visible yet — callers fall
   * back to the default color until the final canonical upload). */
  private resolveNode(id: number, nodes: DataPoint[], indexById?: Map<number, number>): DataPoint | null {
    if (!indexById) return null;
    const idx = indexById.get(id);
    if (idx === undefined || idx < 0 || idx >= nodes.length) return null;
    return nodes[idx];
  }

  fillEdgeColors(
    edgeVerts: Float32Array,
    edges: SegmentColumns | null,
    nodes: DataPoint[],
    encoding: ColorEncoding,
    doiValues?: Float32Array,
    indexById?: Map<number, number>,
    maxSegments = segmentCountOf(edges)
  ): void {
    // Colors live at offsets:
    // cs: base + 6..8, ce: base + 9..11
    const total = segmentCountOf(edges);
    const segCount = Math.max(0, Math.min(maxSegments, total));
    if (segCount === 0) return;
    const cols = edges!;

    // Per-EDGE resolution: segments of an edge are contiguous, so endpoint
    // lookups/colors are computed once per edge (~20 segments) — this fill is
    // on the DoI-preview drag path, where per-segment map lookups cost real
    // frame time at 775k segments.
    if (encoding === "DoI" && doiValues && indexById) {
      for (let e = 0; e < cols.edgeCount && cols.edgeSegOffset[e] < segCount; e++) {
        const from = cols.edgeSegOffset[e];
        const to = Math.min(cols.edgeSegOffset[e + 1], segCount);
        const csIdx = indexById.get(cols.edgeStartId[e]);
        const ceIdx = indexById.get(cols.edgeEndId[e]);
        const csDoi = csIdx !== undefined && csIdx >= 0 && csIdx < doiValues.length ? doiValues[csIdx] : 0;
        const ceDoi = ceIdx !== undefined && ceIdx >= 0 && ceIdx < doiValues.length ? doiValues[ceIdx] : 0;

        for (let i = from; i < to; i++) {
          const baseVertex = i * 4;
          for (let v = 0; v < 4; v++) {
            const base = (baseVertex + v) * EDGE_FLOATS_PER_VERT;
            this.writeDoiColor(edgeVerts, base + 6, csDoi);
            this.writeDoiColor(edgeVerts, base + 9, ceDoi);
          }
        }
      }
      return;
    }

    const resolveDoiKey = (point: DataPoint | null): number | string | null => {
      if (!point) return null;
      if (encoding !== "DoI") return getColorEncodingKey(point, encoding);
      if (!doiValues || !indexById) return getColorEncodingKey(point, encoding);
      const nodeIndex = indexById.get(point.id);
      if (nodeIndex === undefined || nodeIndex < 0 || nodeIndex >= doiValues.length) {
        return getColorEncodingKey(point, encoding);
      }
      return doiValues[nodeIndex];
    };

    for (let e = 0; e < cols.edgeCount && cols.edgeSegOffset[e] < segCount; e++) {
      const from = cols.edgeSegOffset[e];
      const to = Math.min(cols.edgeSegOffset[e + 1], segCount);

      const csKey = resolveDoiKey(this.resolveNode(cols.edgeStartId[e], nodes, indexById));
      const ceKey = resolveDoiKey(this.resolveNode(cols.edgeEndId[e], nodes, indexById));

      const cs = encodeColorToVec3(
        csKey !== null ? this.colorScaleFn(csKey) : "#1b9e77",
        { r: 128, g: 128, b: 128 }
      );
      const ce = encodeColorToVec3(
        ceKey !== null ? this.colorScaleFn(ceKey) : "#1b9e77",
        { r: 128, g: 128, b: 128 }
      );

      for (let i = from; i < to; i++) {
        const baseVertex = i * 4;

        for (let v = 0; v < 4; v++) {
          const base = (baseVertex + v) * EDGE_FLOATS_PER_VERT;

          edgeVerts[base + 6] = cs[0];
          edgeVerts[base + 7] = cs[1];
          edgeVerts[base + 8] = cs[2];

          edgeVerts[base + 9] = ce[0];
          edgeVerts[base + 10] = ce[1];
          edgeVerts[base + 11] = ce[2];
        }
      }
    }
  }

  fillArrowColors(
    arrowVerts: Float32Array,
    edges: SegmentColumns | null,
    nodes: DataPoint[],
    encoding: ColorEncoding,
    doiValues?: Float32Array,
    indexById?: Map<number, number>,
    maxSegments = segmentCountOf(edges)
  ): void {
    // Colors live at offsets base + 5..7
    const total = segmentCountOf(edges);
    const segCount = Math.max(0, Math.min(maxSegments, total));
    if (segCount === 0) return;
    const cols = edges!;
    let writeVertex = 0;

    if (encoding === "DoI" && doiValues && indexById) {
      for (let i = 0; i < segCount; i++) {
        if (cols.segArrow[i] !== 1) continue;

        const dx = cols.segX1[i] - cols.segX0[i];
        const dy = cols.segY1[i] - cols.segY0[i];
        const len = Math.hypot(dx, dy);
        if (len === 0) continue;

        const nextNode = this.resolveNode(cols.edgeEndId[cols.segEdge[i]], nodes, indexById);
        const doi = nextNode ? (this.resolveDoiValue(nextNode, doiValues, indexById) ?? 0) : 0;
        for (let v = 0; v < 3; v++) {
          const base = writeVertex * ARROW_FLOATS_PER_VERT;
          this.writeDoiColor(arrowVerts, base + 5, doi);
          writeVertex++;
        }
      }
      return;
    }

    for (let i = 0; i < segCount; i++) {
      if (cols.segArrow[i] !== 1) continue;

      const dx = cols.segX1[i] - cols.segX0[i];
      const dy = cols.segY1[i] - cols.segY0[i];
      const len = Math.hypot(dx, dy);
      if (len === 0) continue;

      const nextNode = this.resolveNode(cols.edgeEndId[cols.segEdge[i]], nodes, indexById);
      let key: string | number | null = nextNode ? getColorEncodingKey(nextNode, encoding) : null;
      if (encoding === "DoI" && doiValues && indexById && nextNode) {
        const nodeIndex = indexById.get(nextNode.id);
        if (nodeIndex !== undefined && nodeIndex >= 0 && nodeIndex < doiValues.length) {
          key = doiValues[nodeIndex];
        }
      }
      const color = encodeColorToVec3(
        key !== null ? this.colorScaleFn(key) : "#1b9e77",
        { r: 128, g: 128, b: 128 }
      );

      for (let v = 0; v < 3; v++) {
        const base = writeVertex * ARROW_FLOATS_PER_VERT;

        arrowVerts[base + 5] = color[0];
        arrowVerts[base + 6] = color[1];
        arrowVerts[base + 7] = color[2];

        writeVertex++;
      }
    }
  }
}
