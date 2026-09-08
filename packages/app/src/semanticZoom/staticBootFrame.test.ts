/**
 * Static boot-frame registry semantics (issue #315 insets-at-boot I3).
 *
 * The invariants the adoption path leans on:
 *  1. keyed by rows-array identity — a dataset switch (new array) never sees
 *     the old dataset's frame;
 *  2. take is single-consume WITH a tombstone: the first take answers once,
 *     and a registration arriving AFTER it is refused — a slow artifact
 *     fetch must never resurrect the boot view mid-session;
 *  3. parse rejects anything that is not a well-formed points-tree v1
 *     artifact (corrupt file ⇒ classic boot, never a throw).
 */

import { describe, expect, it } from "@jest/globals";
import type { SelectedActive } from "../scaling.types";
import {
  parseStaticBootFrame,
  registerStaticBootFrame,
  STATIC_BOOT_FRAME_FORMAT,
  takeStaticBootFrame,
  type StaticBootFrameArtifact,
} from "./staticBootFrame";

function active(uid: string, overrides: Partial<SelectedActive> = {}): SelectedActive {
  return {
    uid,
    size: 10,
    stability: 10,
    saliency: 0.5,
    doiMass: 10,
    visibleMeanDoi: 1,
    group: 2,
    rescued: false,
    reserved: false,
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    centroid: [0.5, 0.5],
    insetPos: [0.5, 0.5],
    leafRanges: [[0, 10]],
    hull: [[0, 0], [1, 0], [1, 1]],
    ...overrides,
  };
}

function artifactOf(actives: SelectedActive[]): StaticBootFrameArtifact {
  return {
    format: STATIC_BOOT_FRAME_FORMAT,
    tree: "points",
    canvasWidth: 1216,
    canvasHeight: 1000,
    viewbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    frame: {
      actives,
      borderScore: 0.2,
      examined: 42,
      clipped: false,
      fallbackRanking: false,
      focusActive: false,
      doiRevision: null,
    },
  };
}

describe("static boot-frame registry", () => {
  it("register → take answers once, then tombstones", () => {
    const rows: object[] = [];
    const artifact = artifactOf([active("0xA")]);
    registerStaticBootFrame(rows, artifact);
    expect(takeStaticBootFrame(rows)).toBe(artifact);
    expect(takeStaticBootFrame(rows)).toBeNull();
  });

  it("a registration AFTER the first take is refused (slow fetch)", () => {
    const rows: object[] = [];
    expect(takeStaticBootFrame(rows)).toBeNull(); // boot pass raced ahead
    registerStaticBootFrame(rows, artifactOf([active("0xA")])); // fetch lands late
    expect(takeStaticBootFrame(rows)).toBeNull(); // recluster take stays empty
  });

  it("is keyed by rows identity — a dataset switch never sees the old frame", () => {
    const oldRows: object[] = [];
    const newRows: object[] = [];
    registerStaticBootFrame(oldRows, artifactOf([active("0xA")]));
    expect(takeStaticBootFrame(newRows)).toBeNull();
    expect(takeStaticBootFrame(oldRows)).not.toBeNull();
  });

  it("re-registration before the take overwrites (latest wins)", () => {
    const rows: object[] = [];
    registerStaticBootFrame(rows, artifactOf([active("0xA")]));
    const later = artifactOf([active("0xB")]);
    registerStaticBootFrame(rows, later);
    expect(takeStaticBootFrame(rows)).toBe(later);
  });

  describe("parseStaticBootFrame", () => {
    const good = artifactOf([active("0xA")]);

    it("accepts a well-formed artifact", () => {
      expect(parseStaticBootFrame(JSON.parse(JSON.stringify(good)))).not.toBeNull();
    });

    it.each([
      ["null", null],
      ["non-object", "boot"],
      ["wrong format", { ...good, format: "boot-select-frame-v0" }],
      ["wrong tree", { ...good, tree: "midpoints" }],
      ["missing frame", { ...good, frame: undefined }],
      ["actives not an array", { ...good, frame: { ...good.frame, actives: {} } }],
      [
        "active without uid",
        { ...good, frame: { ...good.frame, actives: [{ ...active("0xA"), uid: 7 }] } },
      ],
      [
        "active with bad group",
        { ...good, frame: { ...good.frame, actives: [{ ...active("0xA"), group: 3 }] } },
      ],
      [
        "active with malformed leafRanges",
        { ...good, frame: { ...good.frame, actives: [{ ...active("0xA"), leafRanges: [["a", 2]] }] } },
      ],
    ])("rejects %s", (_name, value) => {
      expect(parseStaticBootFrame(value)).toBeNull();
    });
  });
});
