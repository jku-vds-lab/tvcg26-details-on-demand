import { describe, it, expect } from "@jest/globals";
import { createLabelLookup, patchDataPoints } from "./labeledDatasetExport";

// ---------------------------------------------------------------------------
// createLabelLookup
// ---------------------------------------------------------------------------

describe("createLabelLookup", () => {
  it("converts string-keyed assignments to integer-keyed Map", () => {
    const lookup = createLabelLookup({ "0": "cat", "42": "dog" });
    expect(lookup.get(0)).toBe("cat");
    expect(lookup.get(42)).toBe("dog");
  });

  it("returns empty Map for empty assignments", () => {
    expect(createLabelLookup({}).size).toBe(0);
  });

  it("ignores non-numeric keys", () => {
    const lookup = createLabelLookup({ notANumber: "x", "7": "y" });
    expect(lookup.size).toBe(1);
    expect(lookup.get(7)).toBe("y");
  });
});

// ---------------------------------------------------------------------------
// patchDataPoints
// ---------------------------------------------------------------------------

describe("patchDataPoints", () => {
  const makeRows = () => [
    { id: 0, x: 1.0, label: "original" },
    { id: 1, x: 2.0 },
    { id: 2, x: 3.0 },
  ];

  it("injects labelField on rows whose id is in the lookup", () => {
    const rows = makeRows();
    const lookup = new Map([[0, "cat"], [2, "dog"]]);
    const patched = patchDataPoints(rows, lookup, "semantic_label");
    expect(patched[0].semantic_label).toBe("cat");
    expect(patched[1].semantic_label).toBeUndefined();
    expect(patched[2].semantic_label).toBe("dog");
  });

  it("does not add the field on rows absent from the lookup", () => {
    const rows = makeRows();
    const lookup = new Map([[0, "cat"]]);
    const patched = patchDataPoints(rows, lookup, "semantic_label");
    expect("semantic_label" in patched[1]).toBe(false);
    expect("semantic_label" in patched[2]).toBe(false);
  });

  it("overwrites an existing field with the same name", () => {
    const rows = makeRows();           // row[0] already has label: "original"
    const lookup = new Map([[0, "new_label"]]);
    const patched = patchDataPoints(rows, lookup, "label");
    expect(patched[0].label).toBe("new_label");
  });

  it("preserves all other fields on patched rows", () => {
    const rows = [{ id: 5, x: 9.9, extra: true }];
    const lookup = new Map([[5, "foo"]]);
    const patched = patchDataPoints(rows, lookup, "tag");
    expect(patched[0].x).toBe(9.9);
    expect(patched[0].extra).toBe(true);
    expect(patched[0].id).toBe(5);
  });

  it("does not mutate the input array or its objects", () => {
    const rows = makeRows();
    const original0 = { ...rows[0] };
    const lookup = new Map([[0, "cat"]]);
    patchDataPoints(rows, lookup, "semantic_label");
    expect(rows[0]).toEqual(original0);
    expect("semantic_label" in rows[0]).toBe(false);
  });

  it("row count is identical to input", () => {
    const rows = makeRows();
    const lookup = new Map([[0, "cat"], [1, "dog"], [2, "fish"]]);
    const patched = patchDataPoints(rows, lookup, "tag");
    expect(patched.length).toBe(rows.length);
  });

  it("id values are unchanged after patching", () => {
    const rows = makeRows();
    const lookup = new Map([[0, "cat"], [1, "dog"]]);
    const patched = patchDataPoints(rows, lookup, "tag");
    patched.forEach((r, i) => expect(r.id).toBe(rows[i].id));
  });

  it("returns input row object unchanged when id field is missing", () => {
    const row = { x: 1.0, noId: true };
    const lookup = new Map([[0, "cat"]]);
    const patched = patchDataPoints(
      [row] as Array<Record<string, unknown>>,
      lookup,
      "tag",
    );
    expect(patched[0]).toBe(row); // same reference — not copied
  });

  it("handles empty assignments lookup (all rows pass through)", () => {
    const rows = makeRows();
    const patched = patchDataPoints(rows, new Map(), "tag");
    expect(patched.length).toBe(rows.length);
    patched.forEach((r) => expect("tag" in r).toBe(false));
  });

  it("snapshot safety: mutating lookup after call does not affect result", () => {
    const rows = [{ id: 0, x: 1 }];
    const lookup = new Map([[0, "original"]]);
    const patched = patchDataPoints(rows, lookup, "tag");
    lookup.set(0, "changed");
    expect(patched[0].tag).toBe("original");
  });
});
