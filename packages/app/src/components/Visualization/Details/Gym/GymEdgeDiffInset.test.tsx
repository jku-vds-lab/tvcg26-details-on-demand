import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { ClusterSummary } from "./renderServiceClient";

const mockGetCached = jest.fn<(key: string) => ClusterSummary | undefined>();
const mockRequest = jest.fn();
const mockDecode = jest.fn<(url: string, size: number) => Promise<Uint8ClampedArray>>();

jest.mock("./renderServiceClient", () => ({
  getCachedClusterSummary: (key: string) => mockGetCached(key),
  requestClusterSummary: (key: string, request: unknown) => mockRequest(key, request),
}));

jest.mock("./gymDiff", () => {
  const actual = jest.requireActual<typeof import("./gymDiff")>("./gymDiff");
  return { ...actual, decodeUrlToRgba: (url: string, size: number) => mockDecode(url, size) };
});

import { GYM_INSET_SIZE } from "./GymRenderInset";
import GymEdgeDiffInset from "./GymEdgeDiffInset";

function point(line: number, step: number): DataPoint {
  return { x: 0, y: 0, line, step, id: line * 1000 + step } as unknown as DataPoint;
}

function flatRgba(value: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(GYM_INSET_SIZE * GYM_INSET_SIZE * 4);
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = rgba[i + 1] = rgba[i + 2] = value;
    rgba[i + 3] = 255;
  }
  return rgba;
}

describe("GymEdgeDiffInset", () => {
  beforeEach(() => {
    mockGetCached.mockReset().mockReturnValue(undefined);
    mockRequest.mockReset();
    mockDecode.mockReset();
  });

  it("requests presence maps for both sides, then renders the diff canvas", async () => {
    mockRequest.mockImplementation((key: unknown) => ({
      promise: Promise.resolve({ url: `blob:${String(key)}`, nRendered: 1, nTotal: 1 }),
      cancel: jest.fn(),
    }));
    mockDecode.mockImplementation((url) =>
      Promise.resolve(flatRgba(url.includes("end") ? 255 : 0))
    );

    render(
      <GymEdgeDiffInset
        startSamples={[point(0, 1)]}
        endSamples={[point(0, 9)]}
        scaleFactor={1}
        startSig="start"
        endSig="end"
      />
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledWith(
      `gym:start|presence|${GYM_INSET_SIZE}`,
      expect.objectContaining({ points: [[0, 1]], agg: "presence" })
    );
    expect(mockRequest).toHaveBeenCalledWith(
      `gym:end|presence|${GYM_INSET_SIZE}`,
      expect.objectContaining({ points: [[0, 9]], agg: "presence" })
    );

    await waitFor(() => {
      expect(document.querySelector("canvas")).toBeTruthy();
    });
  });

  it("falls back to mean-image diffing when the server rejects the presence agg", async () => {
    mockRequest.mockImplementation((key: unknown) => {
      const k = String(key);
      return {
        promise: k.includes("|presence|")
          ? Promise.reject(new Error("Unsupported aggregation 'presence'"))
          : Promise.resolve({ url: `blob:${k}`, nRendered: 1, nTotal: 1 }),
        cancel: jest.fn(),
      };
    });
    mockDecode.mockResolvedValue(flatRgba(128));

    render(
      <GymEdgeDiffInset
        startSamples={[point(0, 1)]}
        endSamples={[point(0, 9)]}
        scaleFactor={1}
        startSig="fbA"
        endSig="fbB"
      />
    );
    await waitFor(() => {
      expect(document.querySelector("canvas")).toBeTruthy();
    });
    expect(mockRequest).toHaveBeenCalledWith(
      `gym:fbA|mean|${GYM_INSET_SIZE}`,
      expect.objectContaining({ agg: "mean" })
    );
  });

  it("reuses cached node-inset summaries instead of re-requesting", async () => {
    mockGetCached.mockImplementation((key) => ({
      url: `blob:${key}`,
      nRendered: 1,
      nTotal: 1,
    }));
    mockDecode.mockResolvedValue(flatRgba(128));

    render(
      <GymEdgeDiffInset
        startSamples={[point(0, 1)]}
        endSamples={[point(0, 9)]}
        scaleFactor={1}
        startSig="cachedA"
        endSig="cachedB"
      />
    );
    await waitFor(() => {
      expect(document.querySelector("canvas")).toBeTruthy();
    });
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("falls back to the offline placeholder when a request fails", async () => {
    mockRequest.mockImplementation(() => ({
      promise: Promise.reject(new TypeError("Failed to fetch")),
      cancel: jest.fn(),
    }));

    render(
      <GymEdgeDiffInset
        startSamples={[point(0, 1)]}
        endSamples={[point(0, 9)]}
        scaleFactor={1}
        startSig="offlineA"
        endSig="offlineB"
      />
    );
    await waitFor(() => {
      expect(screen.getByText("render service offline")).toBeTruthy();
    });
  });
});
