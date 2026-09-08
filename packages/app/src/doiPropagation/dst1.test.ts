/**
 * DST1 decoder (issue #315 field-first v2): layout roundtrip against a
 * buffer packed to the plan §8-addendum spec, magic/truncation guards,
 * and the +inf unreachable sentinel.
 */

import { describe, expect, it } from "@jest/globals";
import { unpackDst1 } from "./dst1";

export function buildDst1Buffer(
  revision: number,
  focusActive: boolean,
  dGeo: number[],
  visibleRanges: Array<[number, number]>
): ArrayBuffer {
  const nLeaves = dGeo.length;
  const buffer = new ArrayBuffer(20 + 4 * nLeaves + 8 * visibleRanges.length);
  const view = new DataView(buffer);
  view.setUint8(0, "D".charCodeAt(0));
  view.setUint8(1, "S".charCodeAt(0));
  view.setUint8(2, "T".charCodeAt(0));
  view.setUint8(3, "1".charCodeAt(0));
  view.setUint32(4, revision, true);
  view.setUint8(8, focusActive ? 1 : 0);
  view.setUint32(12, nLeaves, true);
  view.setUint32(16, visibleRanges.length, true);
  new Float32Array(buffer, 20, nLeaves).set(dGeo);
  const vis = new Uint32Array(buffer, 20 + 4 * nLeaves, visibleRanges.length * 2);
  visibleRanges.forEach(([start, end], i) => {
    vis[2 * i] = start;
    vis[2 * i + 1] = end;
  });
  return buffer;
}

describe("unpackDst1", () => {
  it("decodes header, distances, and visible ranges", () => {
    const out = unpackDst1(buildDst1Buffer(7, true, [0, 1.5, Infinity, 3], [[0, 2], [3, 4]]));
    expect(out.revision).toBe(7);
    expect(out.focusActive).toBe(true);
    expect(out.nLeaves).toBe(4);
    expect(Array.from(out.dGeo)).toEqual([0, 1.5, Infinity, 3]);
    expect(out.visibleRanges).toEqual([[0, 2], [3, 4]]);
  });

  it("rejects a bad magic and a truncated payload", () => {
    const buffer = buildDst1Buffer(1, false, [0], []);
    new DataView(buffer).setUint8(0, "X".charCodeAt(0));
    expect(() => unpackDst1(buffer)).toThrow(/magic/);
    expect(() => unpackDst1(buildDst1Buffer(1, false, [0, 1], []).slice(0, 21))).toThrow(/truncated/);
    expect(() => unpackDst1(new ArrayBuffer(4))).toThrow(/short/);
  });
});
