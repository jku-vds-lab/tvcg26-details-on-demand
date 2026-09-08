// Runs inside a Web Worker.
// Receives a raw (possibly gzipped) data chunk, decompresses it, parses the
// JSON, injects user labels, re-serializes, re-gzips, and returns the result.
/// <reference lib="webworker" />

import { gzip } from "fflate";
import { ungzip } from "pako";
import { patchDataPoints } from "../dataPreprocessing/labeledDatasetExport";

type MsgIn = {
  kind: "patchChunk";
  /** Raw bytes of the chunk file (transferred — zero-copy). */
  bytes: ArrayBuffer;
  /** True when the file is .json.gz and must be decompressed first. */
  needsGzip: boolean;
  /**
   * Label assignments serialized as an array of [id, label] pairs so they
   * can be structured-cloned efficiently.  Converted to Map<number,string>
   * inside the worker.
   */
  labelEntries: [number, string][];
  /** The feature/column name to inject (e.g. "label" or "semantic_label"). */
  labelField: string;
};

/** Prefer native DecompressionStream; fall back to pako. */
async function gunzipToText(buf: ArrayBuffer): Promise<string> {
  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const stream = new Blob([buf]).stream().pipeThrough(ds);
    return await new Response(stream).text();
  }
  const out = ungzip(new Uint8Array(buf));
  return new TextDecoder().decode(out);
}

/** Compress text to gzip bytes using fflate (async, non-blocking). */
function gzipText(text: string): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const encoded = new TextEncoder().encode(text);
    gzip(encoded, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

self.onmessage = async (ev: MessageEvent<MsgIn>) => {
  try {
    const { bytes, needsGzip, labelEntries, labelField } = ev.data;

    // 1. Decompress if needed
    let text: string;
    if (needsGzip) {
      try {
        text = await gunzipToText(bytes);
      } catch {
        text = new TextDecoder().decode(bytes);
      }
    } else {
      text = new TextDecoder().decode(bytes);
    }

    // 2. Parse — two supported formats:
    //    a) Bare array:  [{id:0,...}, {id:1,...}, ...]          (manifest chunk files)
    //    b) Wrapped obj: {data:[...], knnGraph:..., ...}        (single-file .json.gz)
    const parsed: unknown = JSON.parse(text);

    let rows: Array<Record<string, unknown>>;
    let isWrapped = false;
    let wrapper: Record<string, unknown> | null = null;

    if (Array.isArray(parsed)) {
      rows = parsed as Array<Record<string, unknown>>;
    } else if (parsed !== null && typeof parsed === "object") {
      isWrapped = true;
      wrapper = parsed as Record<string, unknown>;
      const dataField = wrapper.data;
      if (!Array.isArray(dataField)) {
        throw new Error(
          `Expected parsed.data to be an array, got ${dataField === null ? "null" : typeof dataField}`
        );
      }
      rows = dataField as Array<Record<string, unknown>>;
    } else {
      throw new Error(`Unexpected parsed value: ${typeof parsed}`);
    }

    // 3. Build lookup and inject labels
    const lookup = new Map<number, string>(labelEntries);
    const patched = patchDataPoints(rows, lookup, labelField);

    // 4. Re-serialize + re-gzip
    // For wrapped format, preserve all top-level fields (knnGraph, hdbscan, etc.)
    const output = isWrapped ? { ...wrapper, data: patched } : patched;
    const patched_text = JSON.stringify(output);
    const gzipped = await gzipText(patched_text);

    // Transfer the buffer back — zero-copy
    self.postMessage({ ok: true, bytes: gzipped.buffer }, [gzipped.buffer]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    self.postMessage({ ok: false, error: message });
  }
};

export {};
