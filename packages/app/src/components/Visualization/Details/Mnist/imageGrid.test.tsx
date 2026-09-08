/**
 * Generic image insets (widget `image_shape`): the grid is read row-major
 * from `"{row}x{col}"` keys for any rows × cols, `"mnist"` stays the 28×28
 * preset, and the shape reaches the renderer through the dataset metadata.
 */

import { afterEach, describe, expect, it } from "@jest/globals";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { attachPixelViews, extractPixelGrid } from "src/dataPreprocessing/pixelGrid";
import store, { setDatasetMetadata } from "src/store";
import {
  getSamplePixels,
  imagePixelUnit,
  parseImageShape,
  pixelKeysFor,
  resolveImageShape,
} from "./imageGrid";
import { MnistDatasetRenderer } from "./MnistDatasetRenderer";

/** A record with one `"{r}x{c}"` key per cell, valued by `valueAt(r, c)` (1-based). */
function gridRecord(
  rows: number,
  cols: number,
  valueAt: (r: number, c: number) => number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const rec: Record<string, unknown> = { id: 1, x: 0, y: 0, ...extra };
  for (let r = 1; r <= rows; r++) {
    for (let c = 1; c <= cols; c++) rec[`${r}x${c}`] = valueAt(r, c);
  }
  return rec;
}

const asPoint = (rec: Record<string, unknown>) => rec as unknown as DataPoint;

afterEach(() => {
  store.dispatch(setDatasetMetadata({ datasetType: "default", datasetPath: "", imageShape: null }));
});

describe("getSamplePixels", () => {
  it("reads an 8×8 grid row-major from the point's keys", () => {
    const px = getSamplePixels(asPoint(gridRecord(8, 8, (r, c) => r * 10 + c)), { rows: 8, cols: 8 });
    expect(px.length).toBe(64);
    expect(px[0]).toBe(11); // "1x1"
    expect(px[7]).toBe(18); // "1x8"
    expect(px[8]).toBe(21); // "2x1"
    expect(px[63]).toBe(88); // "8x8"
  });

  it("reads a 16×12 grid row-major (index = (row-1)*cols + (col-1))", () => {
    const px = getSamplePixels(
      asPoint(gridRecord(16, 12, (r, c) => (r - 1) * 12 + (c - 1))),
      { rows: 16, cols: 12 },
    );
    expect(px.length).toBe(192);
    for (let i = 0; i < 192; i++) expect(px[i]).toBe(i);
    expect(pixelKeysFor({ rows: 16, cols: 12 })[12]).toBe("2x1");
    expect(pixelKeysFor({ rows: 16, cols: 12 })[191]).toBe("16x12");
  });

  it("reads the same order from the worker-extracted typed pixels (upload lane)", () => {
    const rec = gridRecord(16, 12, (r, c) => (r - 1) * 12 + (c - 1));
    const extracted = extractPixelGrid([rec]);
    expect(extracted).not.toBeNull();
    attachPixelViews(extracted!.points, extracted!);
    const px = getSamplePixels(asPoint(extracted!.points[0]), { rows: 16, cols: 12 });
    for (let i = 0; i < 192; i++) expect(px[i]).toBe(i);
  });

  it("falls back to the features bag", () => {
    const features = gridRecord(8, 8, (r, c) => (r === 3 && c === 5 ? 200 : 0));
    const px = getSamplePixels(asPoint({ id: 2, x: 0, y: 0, features }), { rows: 8, cols: 8 });
    expect(px[2 * 8 + 4]).toBe(200);
  });
});

describe("image shape resolution", () => {
  it("maps the mnist preset to 28×28 and falls back to it", () => {
    store.dispatch(setDatasetMetadata({ datasetType: "mnist", imageShape: null }));
    expect(resolveImageShape(store.getState())).toEqual({ rows: 28, cols: 28 });
    store.dispatch(setDatasetMetadata({ datasetType: "image", imageShape: null }));
    expect(resolveImageShape(store.getState())).toEqual({ rows: 28, cols: 28 });
  });

  it("takes the image type's grid from the dataset metadata", () => {
    store.dispatch(setDatasetMetadata({ datasetType: "image", imageShape: [8, 8] }));
    expect(resolveImageShape(store.getState())).toEqual({ rows: 8, cols: 8 });
    store.dispatch(setDatasetMetadata({ datasetType: "image", imageShape: [16, 12] }));
    expect(resolveImageShape(store.getState())).toEqual({ rows: 16, cols: 12 });
  });

  it("upscales small grids by whole pixels to the 28 px inset", () => {
    expect(imagePixelUnit({ rows: 28, cols: 28 })).toBe(1);
    expect(imagePixelUnit({ rows: 8, cols: 8 })).toBe(4);
    expect(imagePixelUnit({ rows: 16, cols: 12 })).toBe(2);
    expect(imagePixelUnit({ rows: 64, cols: 64 })).toBe(1);
  });

  it("parses the widget trait and rejects anything but two positive ints", () => {
    expect(parseImageShape([8, 8])).toEqual([8, 8]);
    expect(parseImageShape([16, 12])).toEqual([16, 12]);
    expect(parseImageShape([])).toBeUndefined();
    expect(parseImageShape([0, 8])).toBeUndefined();
    expect(parseImageShape([8.5, 8])).toBeUndefined();
    expect(parseImageShape("8x8")).toBeUndefined();
    expect(parseImageShape(undefined)).toBeUndefined();
  });
});

describe("MnistDatasetRenderer inset size", () => {
  it("is 28×28 per scale unit for the mnist preset and the grid's upscaled size for image", () => {
    const renderer = new MnistDatasetRenderer();
    store.dispatch(setDatasetMetadata({ datasetType: "mnist", imageShape: null }));
    expect(renderer.computeInsetBoundingBox({ mode: "mnist", scaleFactor: 2 })).toMatchObject({ width: 56, height: 56 });

    store.dispatch(setDatasetMetadata({ datasetType: "image", imageShape: [8, 8] }));
    expect(renderer.computeInsetBoundingBox({ mode: "mnist", scaleFactor: 1 })).toMatchObject({ width: 32, height: 32 });

    store.dispatch(setDatasetMetadata({ datasetType: "image", imageShape: [16, 12] }));
    expect(renderer.computeInsetBoundingBox({ mode: "mnist", scaleFactor: 2 })).toMatchObject({ width: 48, height: 64 });
  });
});
