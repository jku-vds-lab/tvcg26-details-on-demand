/**
 * Rubiks local aggregation on index-backed (holey) group arrays — the
 * Finding-A bug class from the issue #315 R1c E2E, pinned for the rubiks
 * renderer (rubiks-backend-demo is lazy-lane eligible):
 *
 *   (1) colorDiff54 walks resolved vote rows instead of the raw slots (a
 *       hole crashed encodeSample54 via `'x' in undefined`),
 *   (2) useRubiksAggregation does the same for node cubes,
 *   (3) signatureForSamples reads ids through the member refs — a slot map
 *       yields a hole-degenerate "||…" signature that collides in the
 *       aggregation caches keyed by it.
 *
 * The group arrays must stay holey throughout (accessors only, forever).
 */
import { render } from "@testing-library/react";
import { useRef } from "react";
import { registerGroupMembers } from "src/clustering/groupMembers";
import type { PointColumns as SidecarPointColumns } from "src/dataPreprocessing/columnSidecar";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { createLazyRowArray } from "src/dataPreprocessing/lazyRows";
import { columnsFromSidecar } from "src/dataPreprocessing/pointColumns";
import { signatureForSamples } from "./RubiksDatasetRenderer";
import { colorDiff54, useRubiksAggregation } from "./rubiksUtils";

const N = 240; // > the 200-row eager prefix ⇒ the tail is real holes

/** Lazy canonical rows whose `up00` sticker is "O" for 210..219, "G" for 220..229. */
function lazyNodes(): DataPoint[] {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  const up00: string[] = new Array(N).fill("O");
  for (let i = 0; i < N; i++) {
    x[i] = i;
    y[i] = i;
    id[i] = 1000 + i;
    if (i >= 220 && i < 230) up00[i] = "G";
  }
  const sc: SidecarPointColumns = { count: N, byName: { x, y, line, id, up00 } };
  const cols = columnsFromSidecar(sc);
  if (!cols) throw new Error("fixture sidecar must produce columns");
  return createLazyRowArray([], sc, cols);
}

function holeyGroup(nodes: DataPoint[], first: number, count: number): DataPoint[] {
  const samples = new Array<DataPoint>(count);
  registerGroupMembers(samples, {
    kind: "list",
    nodes,
    hierarchyId: 1,
    indices: Int32Array.from({ length: count }, (_v, k) => first + k),
  });
  return samples;
}

function expectStillHoley(samples: DataPoint[]): void {
  for (let k = 0; k < samples.length; k++) expect(k in samples).toBe(false);
}

describe("rubiks holey-group local scans (issue #315 R1c)", () => {
  it("colorDiff54 resolves both sides through the member spec", () => {
    const nodes = lazyNodes();
    const starts = holeyGroup(nodes, 210, 10); // up00 = "O"
    const ends = holeyGroup(nodes, 220, 10); // up00 = "G"
    const result = colorDiff54(starts, ends);
    expect(result).toHaveLength(54);
    // Cell 0 is up00: "G" went from absent to dominant (color index 2 = G).
    expect(result[0]).toEqual({ color: 2, delta: 1 });
    // Every other sticker column is absent on both sides — no gain anywhere.
    for (let cell = 1; cell < 54; cell++) expect(result[cell].delta).toBe(0);
    expectStillHoley(starts);
    expectStillHoley(ends);
  });

  it("useRubiksAggregation resolves node samples through the member spec", () => {
    const nodes = lazyNodes();
    const samples = holeyGroup(nodes, 210, 10); // up00 = "O"
    const out: { current: { major: Uint8Array; prop: Float32Array } | null } = { current: null };
    function Probe(): null {
      const ref = useRef(out);
      ref.current.current = useRubiksAggregation("holey-agg-sig", samples);
      return null;
    }
    render(<Probe />);
    // Cell 0 (up00) is unanimously "O" (color index 0); absent cells stay 255.
    expect(out.current!.major[0]).toBe(0);
    expect(out.current!.prop[0]).toBe(1);
    expect(out.current!.major[1]).toBe(255);
    expectStillHoley(samples);
  });

  it("signatureForSamples reads ids via member refs, slot map on plain arrays", () => {
    const nodes = lazyNodes();
    const samples = holeyGroup(nodes, 210, 10);
    expect(signatureForSamples(samples)).toBe(
      Array.from({ length: 10 }, (_v, k) => String(1210 + k))
        .sort()
        .join("|")
    );
    expectStillHoley(samples);
    const plain = [{ id: 2, x: 0, y: 0 }, { id: 1, x: 0, y: 0 }] as unknown as DataPoint[];
    expect(signatureForSamples(plain)).toBe("1|2");
  });
});
