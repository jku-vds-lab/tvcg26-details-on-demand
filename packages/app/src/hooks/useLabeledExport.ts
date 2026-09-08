/**
 * Streaming labeled-dataset export.
 *
 * For multipart (manifest) datasets every data chunk is routed through
 * a Web Worker that decompresses, injects user labels, re-serializes,
 * and re-gzips the chunk.  Non-data files (knn, segments, hdbscan, midpoints)
 * are buffered, magic-byte-checked, and re-gzipped if the browser decoded
 * their Content-Encoding: gzip before we could capture the raw bytes.
 *
 * Memory model:  at most one uncompressed chunk lives in RAM at a time
 * (inside the worker, as a transferable ArrayBuffer).  The zip output is
 * flushed to the FileSystemWritableFileStream continuously, so the full
 * archive never accumulates in memory regardless of dataset size.
 *
 * For single-file .json.gz datasets the same worker pipeline is used but
 * the result is written as a single file (no zip wrapper).
 */

import { fileSave } from "browser-fs-access";
import { gzip, Zip, ZipDeflate, ZipPassThrough } from "fflate";
import { useCallback, useState } from "react";
import { createLabelLookup } from "../dataPreprocessing/labeledDatasetExport";
import { selectLabelFeatureName } from "../slices/labelingSelectors";
import store, { type RootState } from "../store";
import { makeLabeledExportWorker } from "../workers/makeLabeledExportWorker";

// ---------------------------------------------------------------------------
// Gzip helpers
// ---------------------------------------------------------------------------

/** True when the bytes start with the gzip magic number (1f 8b). */
function isGzipBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * Re-compress bytes with gzip (level 1, fast).
 *
 * Needed because browsers transparently decode Content-Encoding: gzip when
 * reading response.body, so fetched .json.gz bytes arrive as plain JSON.
 * Storing plain JSON in a file named .json.gz would make the dev server
 * serve it with Content-Encoding: gzip again, causing ERR_CONTENT_DECODING_FAILED.
 */
function regzip(input: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    gzip(input, { level: 1 }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

/**
 * Ensure passthrough .gz bytes are actually gzip on disk.
 * If the browser decoded them (Content-Encoding: gzip), re-compress.
 */
async function ensureGzip(bytes: Uint8Array, rel: string): Promise<Uint8Array> {
  if (rel.endsWith(".gz") && !isGzipBytes(bytes)) {
    return regzip(bytes);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<{
    createWritable: () => Promise<WritableStream>;
  }>;
}

interface WritableStream {
  write: (data: BufferSource) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
}

export type LabeledExportState = {
  isExporting: boolean;
  progress: number;   // 0–100
  error: string | null;
};

export type UseLabeledExportResult = LabeledExportState & {
  startLabeledExport: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

interface ChunkMeta { path: string; count?: number }
interface ManifestV1 {
  format?: string;
  data?: { chunks?: ChunkMeta[] };
  [key: string]: unknown;
}

/** Collect all relative paths from a manifest (same logic as useStreamingDownload). */
function extractManifestPaths(manifest: ManifestV1): string[] {
  const paths: string[] = [];
  for (const value of Object.values(manifest)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.path === "string") paths.push(v.path);
    if (Array.isArray(v.chunks)) {
      for (const chunk of v.chunks) {
        if (typeof chunk === "object" && chunk !== null) {
          const c = chunk as Record<string, unknown>;
          if (typeof c.path === "string") paths.push(c.path);
        }
      }
    }
  }
  return paths;
}

/** Build a Set of data-chunk relative paths from the manifest's data section. */
function buildDataChunkPaths(manifest: ManifestV1): Set<string> {
  const set = new Set<string>();
  for (const chunk of manifest.data?.chunks ?? []) {
    if (chunk.path) set.add(chunk.path);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Worker helpers
// ---------------------------------------------------------------------------

type WorkerResult = { ok: true; bytes: ArrayBuffer } | { ok: false; error: string };

/** Send one chunk to a worker and await the patched+gzipped result. */
function patchChunkInWorker(
  worker: Worker,
  bytes: ArrayBuffer,
  needsGzip: boolean,
  labelEntries: [number, string][],
  labelField: string,
): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<WorkerResult>) => {
      if (ev.data.ok) resolve(ev.data.bytes);
      else reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => reject(new Error(ev.message));
    // Transfer bytes into the worker (zero-copy)
    worker.postMessage({ kind: "patchChunk", bytes, needsGzip, labelEntries, labelField }, [bytes]);
  });
}

// ---------------------------------------------------------------------------
// Streaming zip export (manifest dataset)
// ---------------------------------------------------------------------------

async function exportManifestWithLabels(
  manifestUrl: string,
  zipName: string,
  folderName: string,
  labelEntries: [number, string][],
  labelField: string,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);

  // Fetch manifest (small — fine to buffer)
  const manifestRes = await fetch(manifestUrl, { signal });
  if (!manifestRes.ok) throw new Error(`HTTP ${manifestRes.status} fetching manifest`);
  const manifest: ManifestV1 = await manifestRes.json();

  // manifest.json is written from the already-parsed object (not re-fetched) so
  // the on-disk bytes are always clean UTF-8 JSON regardless of how the origin
  // server encoded the original (e.g. gzip transport encoding or binary-on-disk).
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

  const relativePaths = extractManifestPaths(manifest);   // chunk/knn/hdbscan paths only
  const dataChunkPaths = buildDataChunkPaths(manifest);

  const pickerWindow = window as SaveFilePickerWindow;
  const canUsePicker = window.isSecureContext && !!pickerWindow.showSaveFilePicker;

  // Fallback path — buffer everything (no streaming write; used when File System
  // Access API is unavailable, e.g., in plain HTTP contexts)
  if (!canUsePicker) {
    const worker = makeLabeledExportWorker();
    try {
      const fileEntries: Array<{ path: string; data: Uint8Array }> = [];

      // Write manifest.json from the in-memory object (always plain UTF-8 JSON)
      fileEntries.push({ path: `${folderName}/manifest.json`, data: manifestBytes });

      for (let i = 0; i < relativePaths.length; i++) {
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        const rel = relativePaths[i];
        const res = await fetch(baseUrl + rel, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rel}`);
        const raw = new Uint8Array(await res.arrayBuffer());

        let data: Uint8Array;
        if (dataChunkPaths.has(rel)) {
          const patched = await patchChunkInWorker(
            worker, raw.buffer.slice(0), rel.endsWith(".gz"), labelEntries, labelField,
          );
          data = new Uint8Array(patched);
        } else {
          // Non-data passthrough: browser may have decoded Content-Encoding: gzip.
          // Re-gzip if the bytes are not already gzip so the file on disk is valid .gz.
          data = await ensureGzip(raw, rel);
        }

        fileEntries.push({ path: `${folderName}/${rel}`, data });
        onProgress(((i + 1) / relativePaths.length) * 90);
      }

      const { zipSync } = await import("fflate");
      const zipInput: Parameters<typeof zipSync>[0] = {};
      for (const { path, data } of fileEntries) {
        zipInput[path] = [data, { level: 0 }];
      }
      const blob = new Blob([zipSync(zipInput)], { type: "application/zip" });
      await fileSave(blob, { fileName: zipName });
      onProgress(100);
    } finally {
      worker.terminate();
    }
    return;
  }

  // Primary streaming path — opens save picker first, then streams
  const fileHandle = await pickerWindow.showSaveFilePicker!({
    suggestedName: zipName,
    types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
  });
  const writable = await fileHandle.createWritable();

  const worker = makeLabeledExportWorker();
  let zipError: unknown = null;

  // Write-queue: fflate's Zip callback fires synchronously; we serialise the
  // async writable.write() calls so they never overlap.
  const writeQueue: Promise<void>[] = [];
  const zip = new Zip((err, chunk, final) => {
    if (err) { zipError = err; return; }
    const copy = chunk.slice();
    const prev = writeQueue[writeQueue.length - 1] ?? Promise.resolve();
    const next = prev.then(() => writable.write(copy));
    writeQueue.push(next);
    if (final) writeQueue.push(next.then(() => writable.close()));
  });

  try {
    // Write manifest.json first from the in-memory object (always plain UTF-8 JSON)
    {
      const entry = new ZipDeflate(`${folderName}/manifest.json`, { level: 1 });
      zip.add(entry);
      entry.push(manifestBytes, true);
    }

    for (let i = 0; i < relativePaths.length; i++) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (zipError) throw zipError;

      const rel = relativePaths[i];
      const isDataChunk = dataChunkPaths.has(rel);

      const res = await fetch(baseUrl + rel, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rel}`);

      if (isDataChunk) {
        // Buffer the (compressed) chunk, patch in worker, write result via
        // ZipPassThrough (we pre-gzip, so ZIP STORE keeps bytes compact).
        if (!res.body) throw new Error(`No response body for ${rel}`);
        const rawChunks: Uint8Array[] = [];
        const reader = res.body.getReader();
        while (true) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const { done, value } = await reader.read();
          if (done) break;
          if (value) rawChunks.push(value);
        }
        // Concatenate into a single ArrayBuffer for the worker
        const totalLen = rawChunks.reduce((s, c) => s + c.length, 0);
        const rawBuf = new Uint8Array(totalLen);
        let offset = 0;
        for (const c of rawChunks) { rawBuf.set(c, offset); offset += c.length; }

        const patchedBuf = await patchChunkInWorker(
          worker, rawBuf.buffer, rel.endsWith(".gz"), labelEntries, labelField,
        );
        if (zipError) throw zipError;

        // Write the pre-gzipped result as a stored (passthrough) entry
        const entry = new ZipPassThrough(`${folderName}/${rel}`);
        zip.add(entry);
        entry.push(new Uint8Array(patchedBuf), true);

      } else {
        // Non-data passthrough file — buffer first so we can detect whether the
        // browser decoded Content-Encoding: gzip (which would leave plain JSON
        // bytes in a .json.gz file, causing ERR_CONTENT_DECODING_FAILED when the
        // extracted file is served again).  Re-gzip if needed before storing.
        if (!res.body) throw new Error(`No response body for ${rel}`);
        const rawChunks: Uint8Array[] = [];
        const rdr = res.body.getReader();
        while (true) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const { done, value } = await rdr.read();
          if (zipError) throw zipError;
          if (done) break;
          if (value) rawChunks.push(value);
        }
        const totalLen = rawChunks.reduce((s, c) => s + c.length, 0);
        const rawBytes = new Uint8Array(totalLen);
        let off = 0;
        for (const c of rawChunks) { rawBytes.set(c, off); off += c.length; }

        const bytesToStore = await ensureGzip(rawBytes, rel);

        const entry = rel.endsWith(".gz")
          ? new ZipPassThrough(`${folderName}/${rel}`)
          : new ZipDeflate(`${folderName}/${rel}`, { level: 1 });
        zip.add(entry);
        entry.push(bytesToStore, true);
      }

      onProgress(((i + 1) / relativePaths.length) * 100);
    }

    zip.end();
    await Promise.all(writeQueue);
  } catch (err) {
    await Promise.allSettled(writeQueue);
    try { await writable.abort(); } catch { /* ignore */ }
    throw err;
  } finally {
    worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Single-file export (.json.gz — no zip wrapper)
// ---------------------------------------------------------------------------

async function exportSingleFileWithLabels(
  url: string,
  fileName: string,
  labelEntries: [number, string][],
  labelField: string,
  onProgress: (p: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const rawChunks: Uint8Array[] = [];
  const total = Number(res.headers.get("Content-Length")) || 0;
  const reader = res.body!.getReader();
  let received = 0;

  while (true) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      rawChunks.push(value);
      received += value.length;
      if (total > 0) onProgress((received / total) * 50); // first 50% = download
    }
  }

  const totalLen = rawChunks.reduce((s, c) => s + c.length, 0);
  const rawBuf = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of rawChunks) { rawBuf.set(c, offset); offset += c.length; }

  const worker = makeLabeledExportWorker();
  try {
    const patchedBuf = await patchChunkInWorker(
      worker, rawBuf.buffer, url.endsWith(".gz"), labelEntries, labelField,
    );
    onProgress(90);

    const blob = new Blob([patchedBuf], { type: "application/gzip" });
    await fileSave(blob, { fileName });
    onProgress(100);
  } finally {
    worker.terminate();
  }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useLabeledExport(): UseLabeledExportResult {
  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const startLabeledExport = useCallback(async () => {
    // --- Snapshot label state synchronously before any await ---
    const state: RootState = store.getState();
    const assignments = Object.fromEntries(state.labeling.assignments);
    const labelField = selectLabelFeatureName(state);
    const datasetPath = state.dataset.datasetPath;

    console.log("[useLabeledExport] startLabeledExport called", {
      datasetPath,
      labelField,
      assignmentCount: Object.keys(assignments).length,
      isSecureContext: window.isSecureContext,
      hasFilePicker: !!(window as SaveFilePickerWindow).showSaveFilePicker,
    });

    if (!datasetPath) return;

    // Convert to array-of-entries for structured-clone transfer to worker
    const lookup = createLabelLookup(assignments);
    const labelEntries: [number, string][] = Array.from(lookup.entries());

    setIsExporting(true);
    setError(null);
    setProgress(0);

    const abortController = new AbortController();

    try {
      if (datasetPath.endsWith("/manifest.json")) {
        const baseFolderName =
          datasetPath.replace(/\/manifest\.json$/, "").split("/").filter(Boolean).pop() ?? "dataset";
        const labeledFolderName = `${baseFolderName}_labeled`;
        await exportManifestWithLabels(
          datasetPath,
          `${labeledFolderName}.zip`,
          labeledFolderName,
          labelEntries,
          labelField,
          setProgress,
          abortController.signal,
        );
      } else {
        const baseName = datasetPath.split("/").pop()?.replace(/\.json\.gz$/, "") ?? "dataset";
        await exportSingleFileWithLabels(
          datasetPath,
          `${baseName}_labeled.json.gz`,
          labelEntries,
          labelField,
          setProgress,
          abortController.signal,
        );
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      const msg = caught instanceof Error ? caught.message : String(caught);
      console.error("[useLabeledExport] export failed:", caught);
      setError(msg);
    } finally {
      setIsExporting(false);
    }
  }, []);

  return { isExporting, progress, error, startLabeledExport };
}
