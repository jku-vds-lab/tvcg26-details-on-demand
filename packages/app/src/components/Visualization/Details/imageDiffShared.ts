/**
 * Shared diverging-colormap palette, diff renderer, and idle-sliced async diff
 * for image-based edge insets (CCTV 128×72, MNIST 28×28).
 *
 * Palette: −1 → #67a9cf (blue), 0 → #f7f7f7 (near-white), +1 → #ef8a62 (orange)
 */

const DIFF_STEPS = 512;

export const DIFF_PALETTE: Uint8ClampedArray = (() => {
  const arr = new Uint8ClampedArray(DIFF_STEPS * 4);
  const neg = { r: 0x67, g: 0xa9, b: 0xcf }; // -1
  const mid = { r: 0xf7, g: 0xf7, b: 0xf7 }; //  0
  const pos = { r: 0xef, g: 0x8a, b: 0x62 }; // +1

  for (let i = 0; i < DIFF_STEPS; i++) {
    const t = i / (DIFF_STEPS - 1); // [0, 1] → [-1, 1]
    const v = t * 2 - 1;
    let r: number, g: number, b: number;

    if (v >= 0) {
      const u = v;
      r = mid.r + u * (pos.r - mid.r);
      g = mid.g + u * (pos.g - mid.g);
      b = mid.b + u * (pos.b - mid.b);
    } else {
      const u = -v;
      r = mid.r + u * (neg.r - mid.r);
      g = mid.g + u * (neg.g - mid.g);
      b = mid.b + u * (neg.b - mid.b);
    }

    const idx = i * 4;
    arr[idx]     = Math.round(r);
    arr[idx + 1] = Math.round(g);
    arr[idx + 2] = Math.round(b);
    arr[idx + 3] = 255;
  }
  return arr;
})();

/**
 * Render the difference (endAvg − startAvg) into an RGBA buffer using the diverging palette.
 * Input values are assumed to be in roughly [0, 1]; differences beyond ±1 are clamped.
 *
 * @param startAvg Per-pixel averages for the start cluster (Float32Array, length = numPixels).
 * @param endAvg   Per-pixel averages for the end cluster (same length).
 * @returns        Uint8ClampedArray of length numPixels × 4 (RGBA, A=255 everywhere).
 */
export function renderImageDiffToRgba(
  startAvg: Float32Array,
  endAvg: Float32Array
): Uint8ClampedArray {
  const numPixels = startAvg.length;
  const rgba = new Uint8ClampedArray(numPixels * 4);

  for (let i = 0; i < numPixels; i++) {
    let diff = endAvg[i] - startAvg[i];
    if (diff > 1) diff = 1;
    else if (diff < -1) diff = -1;

    const t = (diff + 1) * 0.5; // [-1, 1] → [0, 1]
    let idx = (t * (DIFF_STEPS - 1) + 0.5) | 0; // round
    if (idx < 0) idx = 0;
    else if (idx >= DIFF_STEPS) idx = DIFF_STEPS - 1;

    const po   = idx << 2;
    const doff = i   << 2;
    rgba[doff]     = DIFF_PALETTE[po];
    rgba[doff + 1] = DIFF_PALETTE[po + 1];
    rgba[doff + 2] = DIFF_PALETTE[po + 2];
    rgba[doff + 3] = 255;
  }

  return rgba;
}

// Always use setTimeout(0) instead of requestIdleCallback: rIC only fires in the idle
// gap within a frame, which is near-zero while the annealing RAF loop runs continuously.
const scheduleIdle: (cb: IdleRequestCallback) => number =
  (cb) =>
    setTimeout(
      () => cb({ timeRemaining: () => 8, didTimeout: false } as IdleDeadline),
      0
    ) as unknown as number;

/**
 * Compute a per-pixel average+diff off the main thread using requestIdleCallback
 * time-slicing so frames are never blocked.
 *
 * Processes `chunkSize` samples per idle-time iteration, checking
 * `deadline.timeRemaining() > 4ms` before each chunk. When both clusters are
 * fully accumulated the promise resolves with `renderImageDiffToRgba(startAvg, endAvg)`.
 *
 * Resolves immediately with an empty buffer if `isCancelled()` returns true or
 * both sample arrays are empty.
 *
 * @param startSamples  Start-cluster sample objects.
 * @param endSamples    End-cluster sample objects.
 * @param numPixels     Number of pixels per sample (e.g. 128×72 = 9216 for CCTV).
 * @param getPixels     Extract a Float32Array[numPixels] from one sample (WeakMap-cached by callers).
 * @param isCancelled   Polled each chunk; resolves with empty buffer when true.
 * @param chunkSize     Samples processed per idle sub-iteration (default 32).
 */
/**
 * Accumulate a per-pixel cluster average with the same idle time-slicing as
 * `computeImageDiffIdle`, so large-cluster node insets (CCTV: samples × 9,216
 * pixels) never run synchronously inside a React commit during zoom pop-in.
 *
 * Resolves `null` when cancelled or `samples` is empty. `maxAvg` mirrors the
 * synchronous averaging in the image insets (used to pick the 0-1 vs 0-255
 * grayscale scale).
 */
export function computeClusterAverageIdle<T>(
  samples: T[],
  numPixels: number,
  getPixels: (s: T) => Float32Array,
  isCancelled: () => boolean,
  chunkSize = 32,
): Promise<{ avg: Float32Array; maxAvg: number } | null> {
  return new Promise((resolve) => {
    if (isCancelled() || samples.length === 0) {
      resolve(null);
      return;
    }

    const n = samples.length;
    const acc = new Float32Array(numPixels);
    let cursor = 0;

    function processChunk(deadline: IdleDeadline): void {
      if (isCancelled()) { resolve(null); return; }

      while (cursor < n && (deadline.timeRemaining() > 4 || deadline.didTimeout)) {
        const chunkEnd = Math.min(cursor + chunkSize, n);
        for (let i = cursor; i < chunkEnd; i++) {
          const px = getPixels(samples[i]);
          for (let p = 0; p < numPixels; p++) acc[p] += px[p];
        }
        cursor = chunkEnd;
      }

      if (cursor < n) {
        scheduleIdle(processChunk);
        return;
      }

      let maxAvg = 0;
      for (let p = 0; p < numPixels; p++) {
        const v = acc[p] / n;
        acc[p] = v;
        if (v > maxAvg) maxAvg = v;
      }
      resolve({ avg: acc, maxAvg });
    }

    scheduleIdle(processChunk);
  });
}

export function computeImageDiffIdle<T>(
  startSamples: T[],
  endSamples: T[],
  numPixels: number,
  getPixels: (s: T) => Float32Array,
  isCancelled: () => boolean,
  chunkSize = 32,
): Promise<Uint8ClampedArray> {
  return new Promise<Uint8ClampedArray>((resolve) => {
    if (isCancelled() || (startSamples.length === 0 && endSamples.length === 0)) {
      resolve(new Uint8ClampedArray(0));
      return;
    }

    const startAcc = new Float32Array(numPixels);
    const endAcc   = new Float32Array(numPixels);
    const sN    = startSamples.length;
    const eN    = endSamples.length;
    const total = sN + eN;
    let cursor  = 0;

    function processChunk(deadline: IdleDeadline): void {
      if (isCancelled()) { resolve(new Uint8ClampedArray(0)); return; }

      while (cursor < total && (deadline.timeRemaining() > 4 || deadline.didTimeout)) {
        const chunkEnd = Math.min(cursor + chunkSize, total);
        for (let i = cursor; i < chunkEnd; i++) {
          if (i < sN) {
            const px = getPixels(startSamples[i]);
            for (let p = 0; p < numPixels; p++) startAcc[p] += px[p];
          } else {
            const px = getPixels(endSamples[i - sN]);
            for (let p = 0; p < numPixels; p++) endAcc[p] += px[p];
          }
        }
        cursor = chunkEnd;
      }

      if (cursor < total) {
        scheduleIdle(processChunk);
        return;
      }

      // Both clusters fully accumulated — normalise and diff.
      if (sN > 0) for (let p = 0; p < numPixels; p++) startAcc[p] /= sN;
      if (eN > 0) for (let p = 0; p < numPixels; p++) endAcc[p] /= eN;
      resolve(renderImageDiffToRgba(startAcc, endAcc));
    }

    scheduleIdle(processChunk);
  });
}
