import { describe, expect, it, jest } from "@jest/globals";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { ClusterSummary } from "./renderServiceClient";

const mockGetCached = jest.fn<(key: string) => ClusterSummary | undefined>();
const mockRequest = jest.fn();

jest.mock("./renderServiceClient", () => ({
  getCachedClusterSummary: (key: string) => mockGetCached(key),
  requestClusterSummary: (key: string, request: unknown) => mockRequest(key, request),
}));

import GymRenderInset from "./GymRenderInset";

function point(line: number, step: number): DataPoint {
  return { x: 0, y: 0, line, step, id: line * 1000 + step } as unknown as DataPoint;
}

describe("GymRenderInset", () => {
  beforeEach(() => {
    mockGetCached.mockReset().mockReturnValue(undefined);
    mockRequest.mockReset();
  });

  it("shows a spinner, then the fetched summary image", async () => {
    let resolve!: (s: ClusterSummary) => void;
    mockRequest.mockReturnValue({
      promise: new Promise<ClusterSummary>((res) => (resolve = res)),
      cancel: jest.fn(),
    });

    render(
      <GymRenderInset
        clusterSamples={[point(0, 1), point(0, 2)]}
        scaleFactor={1}
        samplesSig="a|b"
      />
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(mockRequest).toHaveBeenCalledWith(
      "gym:a|b|mean|96",
      expect.objectContaining({ points: [[0, 1], [0, 2]] })
    );

    resolve({ url: "blob:test-1", nRendered: 2, nTotal: 2 });
    await waitFor(() => {
      const img = document.querySelector("img");
      expect(img?.getAttribute("src")).toBe("blob:test-1");
    });
  });

  it("resolves synchronously from the cache without a request", () => {
    mockGetCached.mockReturnValue({ url: "blob:cached", nRendered: 1, nTotal: 1 });
    render(
      <GymRenderInset clusterSamples={[point(0, 1)]} scaleFactor={1} samplesSig="a" />
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:cached");
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it("falls back gracefully when the service is unreachable", async () => {
    mockRequest.mockReturnValue({
      promise: Promise.reject(new TypeError("Failed to fetch")),
      cancel: jest.fn(),
    });
    render(
      <GymRenderInset clusterSamples={[point(0, 1)]} scaleFactor={1} samplesSig="a" />
    );
    await waitFor(() => {
      expect(screen.getByText(/render service offline/i)).toBeTruthy();
    });
  });

  it("cancels the in-flight request on unmount", () => {
    const cancel = jest.fn();
    mockRequest.mockReturnValue({ promise: new Promise(() => undefined), cancel });
    const { unmount } = render(
      <GymRenderInset clusterSamples={[point(0, 1)]} scaleFactor={1} samplesSig="a" />
    );
    unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("shows the fallback when no sample has a resolvable step", () => {
    const noStep = { x: 0, y: 0, line: 0, id: 1 } as unknown as DataPoint;
    render(<GymRenderInset clusterSamples={[noStep]} scaleFactor={1} samplesSig="a" />);
    expect(screen.getByText(/render service offline/i)).toBeTruthy();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
