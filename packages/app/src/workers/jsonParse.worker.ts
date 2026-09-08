// Runs inside a Web Worker
/// <reference lib="webworker" />
import { ungzip } from "pako";
import { extractPixelGrid } from "../dataPreprocessing/pixelGrid";

type MsgIn =
  | {
      kind: "parseBytes";
      bytes: ArrayBuffer;
      needsGzip: boolean;
      returnText?: boolean;
      /**
       * When true and the parsed payload is an array of points carrying an
       * inlined pixel grid ("1x1".."WxH" keys), strip the pixel keys in the
       * worker and post back slim points plus one transferable pixel buffer
       * (`pixels: PixelViewMeta`). Avoids main-thread parse/clone of tens of
       * millions of pixel properties (CCTV: ~93 MB JSON per chunk).
       */
      pixelExtract?: boolean;
    }
  | { kind: "parseText"; text: string };

/** Type guards */
function isArrayBuffer(buf: unknown): buf is ArrayBuffer {
  return typeof ArrayBuffer !== "undefined" && buf instanceof ArrayBuffer;
}
function isSharedArrayBuffer(buf: unknown): buf is SharedArrayBuffer {
  // Not all TS lib DOMs include SAB; guard first
   
  return typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer;
}

/** Convert input to a *real* ArrayBuffer (copy if backing store is SharedArrayBuffer). */
function toTightArrayBuffer(input: ArrayBuffer | Uint8Array | SharedArrayBuffer): ArrayBuffer {
  if (isArrayBuffer(input)) return input;
  if (isSharedArrayBuffer(input)) {
    // Copy from SAB into a fresh AB
     
    const view = new Uint8Array(input);
    const out = new Uint8Array(view.byteLength);
    out.set(view);
    return out.buffer;
  }
  // Uint8Array view: slice the underlying buffer if AB, else copy from SAB
  const { buffer, byteOffset, byteLength } = input as Uint8Array;
  if (isArrayBuffer(buffer)) {
    return buffer.slice(byteOffset, byteOffset + byteLength);
  }
  // buffer is SAB → copy
   
  const sabView = new Uint8Array(buffer, byteOffset, byteLength);
  const out = new Uint8Array(byteLength);
  out.set(sabView);
  return out.buffer;
}

/** Prefer native DecompressionStream when available; fall back to pako. */
async function gunzipToText(input: ArrayBuffer | Uint8Array | SharedArrayBuffer): Promise<string> {
  const tight = toTightArrayBuffer(input);

  if (typeof DecompressionStream !== "undefined") {
    const ds = new DecompressionStream("gzip");
    const blob = new Blob([tight]);
    const stream = blob.stream().pipeThrough(ds);
    const res = new Response(stream);
    return await res.text();
  }

  // pako fallback
  const u8 = new Uint8Array(tight);
  const out = ungzip(u8);
  return new TextDecoder().decode(out);
}

self.onmessage = async (ev: MessageEvent<MsgIn>) => {
  try {
    const msg = ev.data;

    if (msg.kind === "parseText") {
      const parsed = JSON.parse(msg.text);
      self.postMessage({ ok: true, parsed });
      return;
    }

    if (msg.kind === "parseBytes") {
      const { bytes, needsGzip, returnText, pixelExtract } = msg;

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

      if (pixelExtract) {
        // Only a successful grid extraction changes the response shape.
        // Everything else keeps the legacy text/parsed paths: posting parsed
        // objects via structured clone stack-overflows on deeply recursive
        // payloads (e.g. HDBSCAN trees, see store.ts flattenCluster note).
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          const extracted = extractPixelGrid(parsed);
          if (extracted) {
            const { points, buffer, width, height, kind } = extracted;
            (self as unknown as Worker).postMessage(
              { ok: true, parsed: points, pixels: { buffer, width, height, kind } },
              [buffer]
            );
            return;
          }
        }
        if (!returnText) {
          (self as unknown as Worker).postMessage({ ok: true, parsed });
          return;
        }
      }

      if (returnText) {
        self.postMessage({ ok: true, text });
        return;
      }

      const parsed = JSON.parse(text);
      self.postMessage({ ok: true, parsed });
      return;
    }
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

export { };

