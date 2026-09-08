/**
 * Write-guarded cluster-id reset (issue #315 B2): clearing stale
 * annotation/inset cluster ids must never CREATE the property slots on
 * nodes that never carried them — on a 1M first boot the blanket
 * `= undefined` writes cost ~0.1–0.6 s of hidden-class transitions.
 *
 * Extended by the stamp gate (issue #315 R1a, A8/A10): the guarded walk is
 * skipped WHOLESALE until a clustering pass announces that it stamped ids —
 * even the guarded reads were ~2M prototype-miss lookups per boot pass, and on
 * the server lane no pass stamps ids at all any more (R1a step 5). A caller
 * that writes ids without announcing them is therefore the one way to leave a
 * stale id behind; the two writers in hdbscanClustering both announce.
 */

import type { DataPoint } from "./dataPreprocessing";
import { clearNodeClusterIds, markClusterIdsStamped } from "./pointColumns";

const node = (): DataPoint =>
  ({ x: 0, y: 0, line: 0, id: 0, DoI: 1 } as unknown as DataPoint);

describe("clearNodeClusterIds", () => {
  it("does not create property slots on untouched nodes", () => {
    const nodes = [node(), node()];
    clearNodeClusterIds(nodes);
    for (const n of nodes) {
      expect(Object.prototype.hasOwnProperty.call(n, "annotationClusterId")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(n, "insetClusterId")).toBe(false);
    }
  });

  it("skips the walk entirely when no pass stamped ids", () => {
    const nodes = [node(), node()];
    // Ids present but never announced (the server lane never stamps at all).
    nodes[0].annotationClusterId = "a1";
    clearNodeClusterIds(nodes);
    expect(nodes[0].annotationClusterId).toBe("a1");
  });

  it("clears stamped ids", () => {
    const nodes = [node(), node(), node()];
    nodes[0].annotationClusterId = "a1";
    nodes[1].insetClusterId = "i1";
    markClusterIdsStamped(); // what the assignment passes announce
    clearNodeClusterIds(nodes);
    expect(nodes[0].annotationClusterId).toBeUndefined();
    expect(nodes[1].insetClusterId).toBeUndefined();
    expect(nodes[2].annotationClusterId).toBeUndefined();
  });
});
