// src/doiPropagation/dst1.ts
//
// DST1 decoder (issue #315 A3 field-first v2): the binary distance-field
// response of `/v1/select` propagate on the field path. Layout
// (plan-315-a3-server-doi.md §8 addendum, little-endian, packer
// doi_propagate.pack_dst1):
//
//   offset  type              field
//   0       char[4]           magic = "DST1"
//   4       uint32            revision
//   8       uint8             focusActive (0/1)
//   9       uint8[3]          reserved
//   12      uint32            nLeaves
//   16      uint32            visibleCount M
//   20      float32[nLeaves]  D_geo, LEAF order (+inf = unreachable)
//   20+4L   uint32[2M]        visibleRanges: M x (start, end) half-open

export interface Dst1Payload {
  revision: number;
  focusActive: boolean;
  nLeaves: number;
  /** Geodesic distance per leaf position; +Infinity = unreachable. */
  dGeo: Float32Array;
  /** Half-open [start, end) leaf ranges with DoI ≥ annotation threshold
   * under the falloff the server applied at commit. */
  visibleRanges: Array<[number, number]>;
}

const HEADER_BYTES = 20;

export function unpackDst1(buffer: ArrayBuffer): Dst1Payload {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error(`DST1 payload too short (${buffer.byteLength} bytes)`);
  }
  const view = new DataView(buffer);
  const magic = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
  );
  if (magic !== "DST1") throw new Error(`bad DST1 magic ${JSON.stringify(magic)}`);
  const revision = view.getUint32(4, true);
  const focusActive = view.getUint8(8) !== 0;
  const nLeaves = view.getUint32(12, true);
  const visibleCount = view.getUint32(16, true);
  const expected = HEADER_BYTES + 4 * nLeaves + 8 * visibleCount;
  if (buffer.byteLength < expected) {
    throw new Error(`DST1 truncated: ${buffer.byteLength} < ${expected} bytes`);
  }
  // Offsets 20 and 20+4L are 4-byte aligned, so typed views work directly.
  const dGeo = new Float32Array(buffer, HEADER_BYTES, nLeaves);
  const vis = new Uint32Array(buffer, HEADER_BYTES + 4 * nLeaves, visibleCount * 2);
  const visibleRanges: Array<[number, number]> = [];
  for (let i = 0; i < visibleCount; i++) {
    visibleRanges.push([vis[2 * i], vis[2 * i + 1]]);
  }
  return { revision, focusActive, nLeaves, dGeo, visibleRanges };
}
