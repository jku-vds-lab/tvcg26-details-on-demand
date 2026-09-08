/**
 * Chess local aggregation on index-backed (holey) group arrays — the
 * Finding-A bug class from the issue #315 R1c E2E, pinned for the chess
 * renderer (chess40k-slim / chess-backend-demo are lazy-lane eligible):
 *
 *   (1) ChessEdgeDiffInset's local `distributions` walks resolved vote rows
 *       instead of the raw slots (a hole crashed the square read on
 *       `undefined`, unmounting every inset — the live E2E failure mode),
 *   (2) ChessBoardInset's local per-square top scan does the same (a hole
 *       was skipped silently, rendering an empty board).
 *
 * Both run the LOCAL lane here (no inset provider registered in jsdom, the
 * backend hooks report "local"), which is exactly the reachable fallback:
 * any backend failure reports "local" and these scans run.
 */
import { render } from "@testing-library/react";
import { registerGroupMembers } from "src/clustering/groupMembers";
import type { PointColumns as SidecarPointColumns } from "src/dataPreprocessing/columnSidecar";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { createLazyRowArray } from "src/dataPreprocessing/lazyRows";
import { columnsFromSidecar } from "src/dataPreprocessing/pointColumns";
import ChessBoardInset from "./ChessBoardInset";
import { CHESS_TILE_CHANGES } from "./chessDiffEncoding";
import ChessEdgeDiffInset from "./ChessEdgeDiffInset";

const N = 240; // > the 200-row eager prefix ⇒ the tail is real holes

/** Lazy canonical rows whose `e4` square is "P" for 210..219, "q" for 220..229. */
function lazyNodes(): DataPoint[] {
  const x = new Float64Array(N);
  const y = new Float64Array(N);
  const line = new Uint16Array(N);
  const id = new Uint32Array(N);
  const e4: string[] = new Array(N).fill("P");
  for (let i = 0; i < N; i++) {
    x[i] = i;
    y[i] = i;
    id[i] = 1000 + i;
    if (i >= 220 && i < 230) e4[i] = "q";
  }
  const sc: SidecarPointColumns = { count: N, byName: { x, y, line, id, e4 } };
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

describe("chess holey-group local scans (issue #315 R1c)", () => {
  it("ChessEdgeDiffInset diffs holey sides through the member spec", () => {
    const nodes = lazyNodes();
    const starts = holeyGroup(nodes, 210, 10); // e4 = "P"
    const ends = holeyGroup(nodes, 220, 10); // e4 = "q"
    const { container } = render(
      <ChessEdgeDiffInset
        startSamples={starts}
        endSamples={ends}
        scaleFactor={1}
        samplesSig="10|10"
      />
    );
    // Exactly one square changed (e4: p → q, total variation distance 1) —
    // one change-heat overlay rect, drawn from the RESOLVED rows.
    const heat = Array.from(container.querySelectorAll("rect")).filter(
      (r) => r.getAttribute("fill") === CHESS_TILE_CHANGES
    );
    expect(heat).toHaveLength(1);
    expectStillHoley(starts);
    expectStillHoley(ends);
  });

  it("ChessBoardInset renders a holey node group without reading its slots", () => {
    const nodes = lazyNodes();
    const samples = holeyGroup(nodes, 210, 10);
    const { container } = render(<ChessBoardInset clusterSamples={samples} scaleFactor={1} />);
    expect(container.querySelector("canvas")).not.toBeNull();
    expectStillHoley(samples);
  });
});
