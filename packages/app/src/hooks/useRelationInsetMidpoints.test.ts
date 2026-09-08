import { describe, expect, it } from "@jest/globals";
import { computeMidpointPatch, type MidpointRelation } from "./useRelationInsetMidpoints";
import type { Pos } from "src/layout/layoutStore";

function makePositions(entries: [string, Pos][]): Map<string, Pos> {
  return new Map(entries);
}

describe("computeMidpointPatch", () => {
  it("returns the midpoint of two node positions", () => {
    const relations: MidpointRelation[] = [
      { insetId: "inset-x", nodeIdA: "node-a", nodeIdB: "node-b" },
    ];
    const positions = makePositions([
      ["node-a", { x: 0, y: 0 }],
      ["node-b", { x: 10, y: 20 }],
    ]);
    const patch = computeMidpointPatch(relations, positions);
    expect(patch.get("inset-x")).toEqual({ x: 5, y: 10 });
  });

  it("skips a relation when node A is missing", () => {
    const relations: MidpointRelation[] = [
      { insetId: "inset-x", nodeIdA: "node-a", nodeIdB: "node-b" },
    ];
    const positions = makePositions([
      // node-a absent
      ["node-b", { x: 10, y: 20 }],
    ]);
    const patch = computeMidpointPatch(relations, positions);
    expect(patch.size).toBe(0);
  });

  it("skips a relation when node B is missing", () => {
    const relations: MidpointRelation[] = [
      { insetId: "inset-x", nodeIdA: "node-a", nodeIdB: "node-b" },
    ];
    const positions = makePositions([
      ["node-a", { x: 0, y: 0 }],
      // node-b absent
    ]);
    const patch = computeMidpointPatch(relations, positions);
    expect(patch.size).toBe(0);
  });

  it("omits the inset entry when already exactly at the midpoint (idempotent)", () => {
    const relations: MidpointRelation[] = [
      { insetId: "inset-x", nodeIdA: "node-a", nodeIdB: "node-b" },
    ];
    const positions = makePositions([
      ["node-a", { x: 0, y: 0 }],
      ["node-b", { x: 10, y: 20 }],
      ["inset-x", { x: 5, y: 10 }], // already at midpoint
    ]);
    const patch = computeMidpointPatch(relations, positions);
    expect(patch.size).toBe(0);
  });

  it("includes the entry when inset is close but not exactly at the midpoint", () => {
    const relations: MidpointRelation[] = [
      { insetId: "inset-x", nodeIdA: "node-a", nodeIdB: "node-b" },
    ];
    const positions = makePositions([
      ["node-a", { x: 0, y: 0 }],
      ["node-b", { x: 10, y: 20 }],
      ["inset-x", { x: 5.001, y: 10 }], // off by epsilon → must update
    ]);
    const patch = computeMidpointPatch(relations, positions);
    expect(patch.get("inset-x")).toEqual({ x: 5, y: 10 });
  });

  it("handles multiple relations independently", () => {
    const relations: MidpointRelation[] = [
      { insetId: "inset-1", nodeIdA: "a1", nodeIdB: "b1" },
      { insetId: "inset-2", nodeIdA: "a2", nodeIdB: "b2" },
    ];
    const positions = makePositions([
      ["a1", { x: 0, y: 0 }],
      ["b1", { x: 4, y: 8 }],
      ["a2", { x: 10, y: 10 }],
      ["b2", { x: 20, y: 30 }],
    ]);
    const patch = computeMidpointPatch(relations, positions);
    expect(patch.get("inset-1")).toEqual({ x: 2, y: 4 });
    expect(patch.get("inset-2")).toEqual({ x: 15, y: 20 });
  });

  it("returns empty map when the relations array is empty", () => {
    const patch = computeMidpointPatch([], new Map());
    expect(patch.size).toBe(0);
  });
});
