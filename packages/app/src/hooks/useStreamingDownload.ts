import { fileSave } from "browser-fs-access";
import { Zip, ZipPassThrough } from "fflate";
import { useCallback, useState } from "react";

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: BufferSource) => Promise<void>;
      close: () => Promise<void>;
      abort: () => Promise<void>;
    }>;
  }>;
}

type DownloadState = {
  progress: number;
  isDownloading: boolean;
  error: string | null;
};

type UseStreamingDownloadResult = DownloadState & {
  start: (url: string, fileName: string) => Promise<void>;
  startFolder: (manifestUrl: string, zipName: string) => Promise<void>;
};

async function saveWithFallback(
  url: string,
  fileName: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  if (!response.body) {
    const blob = await response.blob();
    await fileSave(blob, { fileName });
    onProgress(100);
    return;
  }

  const total = Number(response.headers.get("Content-Length")) || 0;
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    chunks.push(value);
    received += value.length;

    if (total > 0) {
      onProgress((received / total) * 100);
    }
  }

  const blob = new Blob(chunks);
  await fileSave(blob, { fileName });
  onProgress(100);
}

async function streamToDisk(
  url: string,
  suggestedName: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  const pickerWindow = window as SaveFilePickerWindow;
  if (!pickerWindow.showSaveFilePicker) {
    throw new Error("File System Access API not supported in this browser");
  }

  const fileHandle = await pickerWindow.showSaveFilePicker({
    suggestedName,
    types: [
      {
        description: "Any file",
        accept: { "*/*": [] },
      },
    ],
  });

  const writable = await fileHandle.createWritable();

  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Streaming not supported by this browser response");
    }

    const total = Number(response.headers.get("Content-Length")) || 0;
    const reader = response.body.getReader();
    let written = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      await writable.write(value);
      written += value.length;

      if (total > 0) {
        onProgress((written / total) * 100);
      }
    }

    await writable.close();
    onProgress(100);
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // Ignore cleanup failures while propagating original error.
    }
    throw error;
  }
}

/** Extract all relative file paths referenced by a multipart-dataset manifest. */
function extractManifestPaths(manifest: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const value of Object.values(manifest)) {
    if (typeof value !== "object" || value === null) continue;
    const v = value as Record<string, unknown>;
    if (typeof v.path === "string") {
      paths.push(v.path);
    }
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

/**
 * True streaming multi-file zip download.
 *
 * Opens the save-file picker first, then streams each file from the network
 * directly through fflate's Zip encoder into the FileSystemWritableFileStream.
 * At most one network chunk lives in RAM at a time — no full in-memory buffer.
 *
 * Files that are already gzipped (.json.gz) are stored with ZipPassThrough
 * (ZIP STORE method) so their bytes are not decompressed or recompressed.
 *
 * Falls back to the in-memory path when showSaveFilePicker is unavailable.
 */
async function downloadFolderAsZip(
  manifestUrl: string,
  zipName: string,
  onProgress: (progress: number) => void,
): Promise<void> {
  const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf("/") + 1);
  const folderName = baseUrl.split("/").filter(Boolean).pop() ?? "dataset";

  // Fetch manifest (small JSON — fine to buffer)
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) throw new Error(`HTTP ${manifestResponse.status}`);
  const manifest: Record<string, unknown> = await manifestResponse.json();

  const relativePaths = ["manifest.json", ...extractManifestPaths(manifest)];

  const pickerWindow = window as SaveFilePickerWindow;
  if (!window.isSecureContext || !pickerWindow.showSaveFilePicker) {
    // Fallback: buffer everything and use fileSave (same as before)
    const fileEntries: Array<{ relativePath: string; data: Uint8Array }> = [];
    for (let i = 0; i < relativePaths.length; i++) {
      const response = await fetch(baseUrl + relativePaths[i]);
      if (!response.ok)
        throw new Error(`HTTP ${response.status} fetching ${relativePaths[i]}`);
      fileEntries.push({
        relativePath: relativePaths[i],
        data: new Uint8Array(await response.arrayBuffer()),
      });
      onProgress(((i + 1) / relativePaths.length) * 90);
    }
    const { zipSync } = await import("fflate");
    const zipInput: Parameters<typeof zipSync>[0] = {};
    for (const { relativePath, data } of fileEntries) {
      zipInput[`${folderName}/${relativePath}`] = [data, { level: 0 }];
    }
    const blob = new Blob([zipSync(zipInput)], { type: "application/zip" });
    await fileSave(blob, { fileName: zipName });
    onProgress(100);
    return;
  }

  // Primary path: open save picker before fetching any file data, then stream
  // each file's network chunks through fflate.Zip directly to disk.
  const fileHandle = await pickerWindow.showSaveFilePicker({
    suggestedName: zipName,
    types: [{ description: "ZIP archive", accept: { "application/zip": [".zip"] } }],
  });
  const writable = await fileHandle.createWritable();

  let zipError: unknown = null;

  // fflate.Zip calls this handler synchronously with each encoded output chunk.
  // We collect them into a microtask queue and flush sequentially so that
  // writable.write() calls never overlap (WritableStream does not allow that).
  const writeQueue: Promise<void>[] = [];
  const zip = new Zip((err, data, final) => {
    if (err) {
      zipError = err;
      return;
    }
    // Clone the chunk — fflate may reuse its internal buffer
    const chunk = data.slice();
    const prev = writeQueue[writeQueue.length - 1] ?? Promise.resolve();
    const next = prev.then(() => writable.write(chunk));
    writeQueue.push(next);
    if (final) {
      // After the last write resolves, close the file
      writeQueue.push(next.then(() => writable.close()));
    }
  });

  try {
    for (let i = 0; i < relativePaths.length; i++) {
      const relativePath = relativePaths[i];
      const response = await fetch(baseUrl + relativePath);
      if (!response.ok)
        throw new Error(`HTTP ${response.status} fetching ${relativePath}`);
      if (!response.body)
        throw new Error(`No response body for ${relativePath}`);

      // ZipPassThrough = ZIP STORE (no re-compression). Already-gzipped files
      // are kept byte-for-byte identical inside the zip container.
      const entry = new ZipPassThrough(`${folderName}/${relativePath}`);
      zip.add(entry);

      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (zipError) throw zipError;
        if (done) {
          entry.push(new Uint8Array(0), true);
          break;
        }
        entry.push(value!);
      }

      onProgress(((i + 1) / relativePaths.length) * 100);
    }

    zip.end();
    // Wait for all pending writable.write() + writable.close() calls to settle
    await Promise.all(writeQueue);
  } catch (err) {
    // Drain pending writes before aborting so the writable is not closed twice
    await Promise.allSettled(writeQueue);
    try { await writable.abort(); } catch { /* ignore cleanup errors */ }
    throw err;
  }
}

export function useStreamingDownload(): UseStreamingDownloadResult {
  const [progress, setProgress] = useState(0);
  const [isDownloading, setIsDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wrapDownload = useCallback(
    async (fn: () => Promise<void>) => {
      setIsDownloading(true);
      setError(null);
      setProgress(0);
      try {
        await fn();
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === "AbortError") {
          return;
        }
        const message = caught instanceof Error ? caught.message : "Download failed";
        setError(message);
      } finally {
        setIsDownloading(false);
      }
    },
    [],
  );

  const start = useCallback(
    (url: string, fileName: string) =>
      wrapDownload(() => {
        if (window.isSecureContext && "showSaveFilePicker" in window) {
          return streamToDisk(url, fileName, setProgress);
        }
        return saveWithFallback(url, fileName, setProgress);
      }),
    [wrapDownload],
  );

  const startFolder = useCallback(
    (manifestUrl: string, zipName: string) =>
      wrapDownload(() => downloadFolderAsZip(manifestUrl, zipName, setProgress)),
    [wrapDownload],
  );

  return {
    progress,
    isDownloading,
    error,
    start,
    startFolder,
  };
}
