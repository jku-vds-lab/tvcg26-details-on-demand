// #337 PR B: the propagateDoI spread suites retired with the heap oracle —
// the seed-exclusion / pin / full-space semantics are covered on the field
// lane (serverPropagation.localField.test.ts, doiFieldParity.test.ts).
import { describe, it, expect } from "@jest/globals";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { updateNodeGroup } from "./propagateDoi";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: number, doi: number): DataPoint {
  return { id, DoI: doi } as DataPoint;
}

const THRESHOLDS = {
  grayOutDoiThreshold: 0.05,
  annotationDoiThreshold: 0.7,
  insetDoiThreshold: 0.9,
};

// ---------------------------------------------------------------------------
// updateNodeGroup — normal behaviour (no labeledNodeIds)
// ---------------------------------------------------------------------------

describe("updateNodeGroup — normal mode", () => {
  it("assigns 'gray' when DoI is below grayOut threshold", () => {
    const node = makeNode(1, 0.02);
    updateNodeGroup(node, THRESHOLDS);
    expect(node.doiGroup).toBe("gray");
  });

  it("assigns 'transparent' when DoI is between grayOut and annotation threshold", () => {
    const node = makeNode(1, 0.3);
    updateNodeGroup(node, THRESHOLDS);
    expect(node.doiGroup).toBe("transparent");
  });

  it("assigns 'annotation' when DoI is between annotation and inset threshold", () => {
    const node = makeNode(1, 0.8);
    updateNodeGroup(node, THRESHOLDS);
    expect(node.doiGroup).toBe("annotation");
  });

  it("assigns 'inset' when DoI is at or above inset threshold", () => {
    const node = makeNode(1, 0.95);
    updateNodeGroup(node, THRESHOLDS);
    expect(node.doiGroup).toBe("inset");
  });

  it("assigns 'inset' at exactly the inset threshold", () => {
    const node = makeNode(1, 0.9);
    updateNodeGroup(node, THRESHOLDS);
    expect(node.doiGroup).toBe("inset");
  });
});

// ---------------------------------------------------------------------------
// updateNodeGroup — unlabeled-only mode (labeledNodeIds provided)
// ---------------------------------------------------------------------------

describe("updateNodeGroup — unlabeled-only mode", () => {
  it("caps a labeled node from 'inset' to 'transparent'", () => {
    const node = makeNode(7, 0.95);
    updateNodeGroup(node, THRESHOLDS, new Set(["7"]));
    expect(node.doiGroup).toBe("transparent");
  });

  it("caps a labeled node from 'annotation' to 'transparent'", () => {
    const node = makeNode(7, 0.8);
    updateNodeGroup(node, THRESHOLDS, new Set(["7"]));
    expect(node.doiGroup).toBe("transparent");
  });

  it("does not raise a labeled node already at 'gray'", () => {
    const node = makeNode(7, 0.02);
    updateNodeGroup(node, THRESHOLDS, new Set(["7"]));
    expect(node.doiGroup).toBe("gray");
  });

  it("does not raise a labeled node already at 'transparent'", () => {
    const node = makeNode(7, 0.3);
    updateNodeGroup(node, THRESHOLDS, new Set(["7"]));
    expect(node.doiGroup).toBe("transparent");
  });

  it("does not affect an unlabeled node with high DoI", () => {
    const node = makeNode(42, 0.95);
    updateNodeGroup(node, THRESHOLDS, new Set(["7"])); // node 42 is not in the set
    expect(node.doiGroup).toBe("inset");
  });

  it("does not affect any node when labeledNodeIds is an empty set", () => {
    const node = makeNode(1, 0.95);
    updateNodeGroup(node, THRESHOLDS, new Set());
    expect(node.doiGroup).toBe("inset");
  });

  it("does not affect any node when labeledNodeIds is undefined", () => {
    const node = makeNode(1, 0.95);
    updateNodeGroup(node, THRESHOLDS, undefined);
    expect(node.doiGroup).toBe("inset");
  });

  it("handles multiple labeled nodes independently", () => {
    const labeled = makeNode(3, 0.95);
    const unlabeled = makeNode(4, 0.95);
    const set = new Set(["3"]);
    updateNodeGroup(labeled, THRESHOLDS, set);
    updateNodeGroup(unlabeled, THRESHOLDS, set);
    expect(labeled.doiGroup).toBe("transparent");
    expect(unlabeled.doiGroup).toBe("inset");
  });
});
