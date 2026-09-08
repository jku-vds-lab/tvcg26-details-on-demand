import { ungzip } from "pako";

export interface DatasetEntry {
  path: string;
  type: string;
  display?: string;
}

export class DownloadJob {
  entry: DatasetEntry;
  terminated: boolean;
  private abortController: AbortController | null;
  private readonly signal?: AbortSignal;

  constructor(entry: DatasetEntry, signal?: AbortSignal) {
    this.entry = entry;
    this.terminated = false;
    this.signal = signal;
    this.abortController = signal ? null : new AbortController();
  }

  private get activeSignal(): AbortSignal | undefined {
    return this.signal ?? this.abortController?.signal;
  }

  private isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }

  async start(
    onFinishText: (result: string) => void,
    // progress: 0..100, or null => indeterminate
    onProgress: (progress: number | null) => void,
    // NEW: for JSON paths, deliver raw bytes so a worker can handle gzip->decode->parse
    onFinishBytes?: (payload: { bytes: Uint8Array; needsClientGzip: boolean }) => void
  ): Promise<void> {
    try {
      const response = await fetch(this.entry.path, { signal: this.activeSignal });
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      if (this.terminated) return;

      const isJsonPath = this.entry.path.endsWith(".json") || this.entry.path.endsWith(".json.gz");

      // Try streaming to report download progress
      if (response.body) {
        const reader = response.body.getReader();
        const contentLengthHeader = response.headers.get("Content-Length");
        const total = contentLengthHeader ? Number(contentLengthHeader) : null;

        let receivedLength = 0;
        const chunks: Uint8Array[] = [];
        let toldIndeterminate = false;

        while (true) {
          const { done, value } = await reader.read();
          if (done || this.terminated) break;
          if (value) {
            chunks.push(value);
            receivedLength += value.length;

            if (total && isFinite(total) && total > 0) {
              const pct = Math.min((receivedLength / total) * 100, 99.0);
              onProgress(pct);
            } else if (!toldIndeterminate) {
              onProgress(null);
              toldIndeterminate = true;
            }
          }
        }
        if (this.terminated) return;

        // Stitch bytes
        const chunksAll = new Uint8Array(receivedLength);
        let position = 0;
        for (const chunk of chunks) {
          chunksAll.set(chunk, position);
          position += chunk.length;
        }

        const encoding = (response.headers.get("Content-Encoding") || "").toLowerCase();
        const isGzPath = this.entry.path.endsWith(".json.gz");
        const needsClientGzip = isGzPath && encoding !== "gzip";

        onProgress(100);

        // If JSON and bytes callback is provided, hand off bytes (zero-copy with transferable)
        if (isJsonPath && onFinishBytes) {
          onFinishBytes({ bytes: chunksAll, needsClientGzip });
          return;
        }

        // Fallback: decode to text on main thread (CSV, or JSON when bytes path not used)
        let text: string;
        if (needsClientGzip) {
          try {
            const decompressed = ungzip(chunksAll);
            text = new TextDecoder("utf-8").decode(decompressed);
          } catch {
            text = new TextDecoder("utf-8").decode(chunksAll);
          }
        } else {
          text = new TextDecoder("utf-8").decode(chunksAll);
        }
        onFinishText(text);
        return;
      }

      // No ReadableStream support: fallback to arrayBuffer
      const buffer = await response.arrayBuffer();
      if (this.terminated) return;

      const encoding = (response.headers.get("Content-Encoding") || "").toLowerCase();
      const isGzPath = this.entry.path.endsWith(".json.gz");
      const needsClientGzip = isGzPath && encoding !== "gzip";

      const u8 = new Uint8Array(buffer);
      onProgress(100);

      if (isJsonPath && onFinishBytes) {
        onFinishBytes({ bytes: u8, needsClientGzip });
        return;
      }

      // Fallback decode to text
      let text: string;
      if (needsClientGzip) {
        try {
          const decompressed = ungzip(u8);
          text = new TextDecoder("utf-8").decode(decompressed);
        } catch {
          text = new TextDecoder("utf-8").decode(u8);
        }
      } else {
        text = new TextDecoder("utf-8").decode(u8);
      }
      onFinishText(text);
    } catch (error) {
      if (this.terminated || this.isAbortError(error)) {
        throw new DOMException("Download aborted", "AbortError");
      }
      throw error;
    }
  }

  terminate(): void {
    this.terminated = true;
    this.abortController?.abort();
  }
}
