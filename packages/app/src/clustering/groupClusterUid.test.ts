/**
 * Cluster identity without per-point cluster ids (issue #315 R1a step 5, CS
 * decision 2026-08-02). The server lane stops stamping
 * annotationClusterId/insetClusterId onto ~1M member points; the uid rides the
 * member group instead. Pinned here:
 *   (1) the registry: uid by member-array identity, members by uid, reset,
 *   (2) the inset label resolvers take the registered uid when the points
 *       carry no cluster id (server lane) and keep using the point field on
 *       the legacy groupBy lane,
 *   (3) clearNodeClusterIds does nothing until a pass actually stamped ids.
 */

import { jest } from "@jest/globals";

// Mock rbush (ESM) to avoid transform issues in Jest — dataPreprocessing
// imports it at module scope.
jest.mock("rbush", () => {
  type Box = { minX: number; minY: number; maxX: number; maxY: number };
  return {
    __esModule: true,
    default: class RBushMock<T extends Box> {
      private items: T[] = [];
      load(arr: T[]) { this.items.push(...arr); }
      clear() { this.items.length = 0; }
      all() { return this.items; }
      insert(item: T) { this.items.push(item); }
      search() { return this.items; }
    },
  };
});

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { createEmptyDataPoint } from "../dataPreprocessing/dataPreprocessing";
import { clearNodeClusterIds, markClusterIdsStamped } from "../dataPreprocessing/pointColumns";
import {
  groupClusterUidOf,
  groupMembersOfClusterUid,
  registerGroupClusterUid,
  resetGroupClusterUids,
} from "./groupClusterUid";
import {
  BaseInsetRenderer,
  type BoundingBox,
} from "../components/Visualization/Details/BaseInsetRenderer";
import store, { updateSettings } from "../store";

/** Minimal concrete renderer — the label resolvers are the unit under test. */
class ProbeRenderer extends BaseInsetRenderer {
  renderSingleNodeAnnotation(): JSX.Element { return null as unknown as JSX.Element; }
  renderGroupNodeAnnotation(): JSX.Element { return null as unknown as JSX.Element; }
  renderSingleEdgeAnnotation(): JSX.Element { return null as unknown as JSX.Element; }
  renderGroupEdgeAnnotation(): JSX.Element { return null as unknown as JSX.Element; }
  renderSingleNodeInset(): JSX.Element { return null as unknown as JSX.Element; }
  renderGroupNodeInset(): JSX.Element { return null as unknown as JSX.Element; }
  renderSingleEdgeInset(): JSX.Element { return null as unknown as JSX.Element; }
  renderGroupEdgeInset(): JSX.Element { return null as unknown as JSX.Element; }
  computeInsetBoundingBox(): BoundingBox {
    return { x: 0, y: 0, width: 0, height: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  label(samples: DataPoint[], layer: "annotation" | "inset"): string {
    return this.resolveGroupNodeLabel(samples, "action", "PLACEHOLDER", layer);
  }
}

function members(n: number): DataPoint[] {
  return Array.from({ length: n }, (_, i) => ({
    ...createEmptyDataPoint(),
    id: i + 1,
    action: `a${i}`,
  }));
}

beforeEach(() => {
  resetGroupClusterUids();
});

describe("group cluster-uid registry", () => {
  it("resolves the uid by member-array identity and the members by uid", () => {
    const groupA = members(3);
    const groupB = members(2);
    registerGroupClusterUid(groupA, "0xAAA");
    registerGroupClusterUid(groupB, "0xBBB");

    expect(groupClusterUidOf(groupA)).toBe("0xAAA");
    expect(groupClusterUidOf(groupB)).toBe("0xBBB");
    expect(groupMembersOfClusterUid("0xAAA")).toBe(groupA);
    expect(groupClusterUidOf(members(3))).toBeUndefined();
  });

  it("a rebuild replaces the members of a uid, and reset drops the index", () => {
    const first = members(3);
    const second = members(4);
    registerGroupClusterUid(first, "0xAAA");
    registerGroupClusterUid(second, "0xAAA");
    expect(groupMembersOfClusterUid("0xAAA")).toBe(second);
    // The identity map keeps answering for the old array — harmless, and the
    // label cache keys the same way.
    expect(groupClusterUidOf(first)).toBe("0xAAA");

    resetGroupClusterUids();
    expect(groupMembersOfClusterUid("0xAAA")).toBeUndefined();
  });
});

describe("inset label resolution without per-point cluster ids", () => {
  it("uses the registered uid for the tf-idf lookup (server lane)", () => {
    store.dispatch(updateSettings({
      clusterLabelStrategy: "tfidf",
      tfidfLabels: { "0xAAA": "opening trap" },
    }));
    const group = members(3); // no insetClusterId / annotationClusterId anywhere
    registerGroupClusterUid(group, "0xAAA");

    expect(new ProbeRenderer().label(group, "inset")).toBe("opening trap");
  });

  it("falls back to the point's cluster id when no group was registered (client lane)", () => {
    store.dispatch(updateSettings({
      clusterLabelStrategy: "tfidf",
      tfidfLabels: { "0xCCC": "castled king" },
    }));
    const group = members(3);
    group.forEach((p) => { p.insetClusterId = "0xCCC"; });

    expect(new ProbeRenderer().label(group, "inset")).toBe("castled king");
  });

  it("returns the placeholder when neither source knows the cluster", () => {
    store.dispatch(updateSettings({ clusterLabelStrategy: "tfidf", tfidfLabels: {} }));
    expect(new ProbeRenderer().label(members(2), "inset")).toBe("PLACEHOLDER");
  });
});

describe("clearNodeClusterIds stamp gate", () => {
  it("does nothing until a pass stamped ids, then clears", () => {
    const nodes = members(3);
    nodes[1].insetClusterId = "0xAAA";

    // No pass announced a stamp — the guarded walk is skipped entirely.
    clearNodeClusterIds(nodes);
    expect(nodes[1].insetClusterId).toBe("0xAAA");

    markClusterIdsStamped();
    clearNodeClusterIds(nodes);
    expect(nodes[1].insetClusterId).toBeUndefined();
  });
});
