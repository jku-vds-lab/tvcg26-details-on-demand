/**
 * Binary column sidecar decoder (issue #315 phase E-a): decode typed
 * columns, exact fixed-decimal round-trip, alignment guard, and row
 * materialization equal to what the JSON path would have parsed.
 */

import { describe, expect, it } from "@jest/globals";
import { decodeColumns, materializeRecords, type DataColumnsSection } from "./columnSidecar";

/** Build a fixture buffer matching the v1 layout: u8 col, pad, i32+scale
 * col, u32 col, pad, f64 col — offsets aligned to each dtype's size. */
function fixture(): { buffer: ArrayBuffer; section: DataColumnsSection } {
  const count = 3;
  const action = [8, 3, 0];
  const xScaled = [548080, -1250, 990422]; // 54.808, -0.125, 99.0422 at scale 1e4
  const line = [0, 1, 4294967295];
  const reward = [0.014, -3.5, 1e-7];

  const offAction = 0; // u8, 3 bytes → next free 3
  const offX = 4; // i32 aligned
  const offLine = offX + 4 * count; // 16, u32 aligned
  const offReward = Math.ceil((offLine + 4 * count) / 8) * 8; // 32, f64 aligned
  const buffer = new ArrayBuffer(offReward + 8 * count);
  new Uint8Array(buffer, offAction, count).set(action);
  new Int32Array(buffer, offX, count).set(xScaled);
  new Uint32Array(buffer, offLine, count).set(line);
  new Float64Array(buffer, offReward, count).set(reward);
  return {
    buffer,
    section: {
      file: "columns.bin",
      count,
      columns: [
        { name: "action", dtype: "u8", byteOffset: offAction },
        { name: "x", dtype: "i32", byteOffset: offX, scale: 10000 },
        { name: "line", dtype: "u32", byteOffset: offLine },
        { name: "reward", dtype: "f64", byteOffset: offReward },
      ],
    },
  };
}

describe("columnSidecar", () => {
  it("decodes typed columns with exact fixed-decimal round-trip", () => {
    const { buffer, section } = fixture();
    const cols = decodeColumns(buffer, section);
    expect(cols.count).toBe(3);
    // Scaled i32 division must reproduce the float64 the JSON parser would
    // produce for the same decimal literal — bit-equal, not approximate.
    expect(Array.from(cols.byName.x)).toEqual([54.808, -0.125, 99.0422]);
    expect(Array.from(cols.byName.action)).toEqual([8, 3, 0]);
    expect(Array.from(cols.byName.line)).toEqual([0, 1, 4294967295]);
    expect(Array.from(cols.byName.reward)).toEqual([0.014, -3.5, 1e-7]);
    // Unscaled columns are zero-copy views over the sidecar buffer.
    expect((cols.byName.reward as Float64Array).buffer).toBe(buffer);
    expect((cols.byName.x as Float64Array).buffer).not.toBe(buffer); // scaled → own array
  });

  it("rejects a misaligned column offset", () => {
    const { buffer, section } = fixture();
    section.columns[1] = { ...section.columns[1], byteOffset: 6 }; // i32 at 6
    expect(() => decodeColumns(buffer, section)).toThrow(/Misaligned/);
  });

  it("materializes rows equal to the JSON-path objects", async () => {
    const { buffer, section } = fixture();
    const cols = decodeColumns(buffer, section);
    const rows = await materializeRecords(cols, { sliceSize: 2 });
    expect(rows).toEqual([
      { action: 8, x: 54.808, line: 0, reward: 0.014 },
      { action: 3, x: -0.125, line: 1, reward: -3.5 },
      { action: 0, x: 99.0422, line: 4294967295, reward: 1e-7 },
    ]);
  });

  it("aborts materialization via signal", async () => {
    const { buffer, section } = fixture();
    const cols = decodeColumns(buffer, section);
    const controller = new AbortController();
    controller.abort();
    await expect(materializeRecords(cols, { signal: controller.signal })).rejects.toThrow();
  });
});
