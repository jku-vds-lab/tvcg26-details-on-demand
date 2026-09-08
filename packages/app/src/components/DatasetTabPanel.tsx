// packages/app/src/components/DatasetTabPanel.tsx
import { Alert, Box, Button, Typography } from "@mui/material";
import Papa from "papaparse";
import React, { useEffect, useRef, useState } from "react";
import { useDispatch } from "react-redux";
import { getDatasetVisualPreset } from "../config/datasetVisualPresets";
import { loadDatasetAuto } from "../dataPreprocessing/DatasetLoader";
import { DownloadJob } from "../dataPreprocessing/DownloadJob";
import { JSONLoader } from "../dataPreprocessing/JSONLoader";
import { DatasetTooLargeError, loadSimpleDataset } from "../dataPreprocessing/loadSimpleDataset";
import {
    inferSimpleColumnMapping,
    type SimpleColumnMapping,
} from "../dataPreprocessing/simpleDataset";
import {
    progressComplete,
    progressFail,
    progressStart,
    progressUpdate,
} from "../slices/progressSlice";
import { setDatasetMetadata, updateSettings } from "../store";
import { Dataset } from "../types/datasetTypes";
import { applyRendererDefaults } from "../utils/clusterDataUtils";
import { DatasetLoadMonitorHandle, startDatasetLoadMonitor } from "../utils/datasetLoadInstrumentation";
import { getPredictedDurations, getWeights, updateWeights } from "../utils/phaseEstimator";
import { clearTaskTree, setActiveDatasetLoadTask } from "../utils/progressApi";
import { makeJsonWorker } from "../workers/makeJsonWorker";
import { DatasetEntry, resolveDatasetFetchPath } from "../datasets/catalog";
import DragAndDrop from "./DragAndDrop";
import PredefinedDatasets from "./PredefinedDatasets";
import UploadWizardDialog, { UploadWizardSubmit } from "./upload/UploadWizardDialog";
import { classifyDroppedFile } from "./upload/uploadFileRouting";

export interface DatasetTabPanelProps {
  onDataSelected: (dataset: Dataset) => void;
  /** Issue #315 G4 slice 2: fired synchronously when a predefined internal
   * dataset is picked, BEFORE its download starts, so the aggregate-first base
   * layer can boot from the new dataset's manifest ~1 s after the click
   * instead of after the full ingest. Optional (absent in embedded/widget
   * mode); a no-op for serverless datasets (their manifest has no backend). */
  onPredefinedPickStart?: (entry: DatasetEntry) => void;
}

interface PendingUpload {
  fileName: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

const DatasetTabPanel: React.FC<DatasetTabPanelProps> = ({ onDataSelected, onPredefinedPickStart }) => {
  const [_job, setJob] = useState<DownloadJob | null>(null);
  const [pendingUpload, setPendingUpload] = useState<PendingUpload | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const dispatch = useDispatch();

  const rafId = useRef<number | null>(null);
  const completeTimeoutRef = useRef<number | null>(null);
  const requestSeqRef = useRef(0);
  const activeTaskIdRef = useRef<string | null>(null);
  const activeAbortRef = useRef<AbortController | null>(null);
  const activeJobRef = useRef<DownloadJob | null>(null);
  const activeLoadMonitorRef = useRef<DatasetLoadMonitorHandle | null>(null);

  const stopAnim = () => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
    rafId.current = null;
  };

  const clearCompletionTimeout = () => {
    if (completeTimeoutRef.current != null) {
      window.clearTimeout(completeTimeoutRef.current);
      completeTimeoutRef.current = null;
    }
  };

  const waitForViewerPaint = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

  const isAbortError = (err: unknown): boolean =>
    err instanceof DOMException && err.name === "AbortError";

  const cancelActiveLoad = () => {
    clearCompletionTimeout();
    stopAnim();
    activeLoadMonitorRef.current?.setPhase("cancelled");
    activeLoadMonitorRef.current?.stop("cancelled");
    activeLoadMonitorRef.current = null;
    activeAbortRef.current?.abort();
    activeJobRef.current?.terminate();
    if (activeTaskIdRef.current) clearTaskTree(activeTaskIdRef.current);
    activeAbortRef.current = null;
    activeJobRef.current = null;
    activeTaskIdRef.current = null;
    setJob(null);
  };

  useEffect(() => {
    return () => cancelActiveLoad();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup; cancelActiveLoad reads only stable refs, so the first-render closure is always current
  }, []);

  // ── Custom uploads (drag-and-drop / file picker, issue #217) ──────────────

  const parseBytesInWorker = (bytes: Uint8Array, needsGzip: boolean): Promise<string> =>
    new Promise((resolve, reject) => {
      const w = makeJsonWorker();
      w.onmessage = (e: MessageEvent<{ ok?: boolean; text?: string; error?: string }>) => {
        const { ok, text, error } = e.data || {};
        w.terminate();
        if (ok && typeof text === "string") resolve(text);
        else reject(new Error(error || "Worker parse failed"));
      };
      w.onerror = (err) => {
        w.terminate();
        reject(err);
      };
      w.postMessage(
        { kind: "parseBytes", bytes: bytes.buffer, needsGzip, returnText: true },
        [bytes.buffer]
      );
    });

  const parseCsvForWizard = (file: File) => {
    const taskId = `dataset:upload:parse:${Date.now()}`;
    dispatch(
      progressStart({
        id: taskId,
        label: "Parsing CSV",
        value: null,
        phase: file.name,
        kind: "compute",
        progressMode: "indeterminate",
      })
    );
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: true,
      worker: true,
      complete(results) {
        dispatch(progressComplete({ id: taskId }));
        const headers = results.meta.fields ?? [];
        if (headers.length === 0 || results.data.length === 0) {
          setUploadError(`${file.name} has no parsable rows`);
          return;
        }
        setPendingUpload({ fileName: file.name, headers, rows: results.data });
      },
      error(err) {
        dispatch(progressFail({ id: taskId, label: "Failed to parse CSV" }));
        setUploadError(`Failed to parse ${file.name}: ${err.message}`);
      },
    });
  };

  const loadDroppedJson = async (file: File, needsGzip: boolean) => {
    cancelActiveLoad();
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const taskId = `dataset:upload:${file.name}#${requestSeq}`;
    activeTaskIdRef.current = taskId;
    const isCurrent = () =>
      requestSeqRef.current === requestSeq && activeTaskIdRef.current === taskId;

    dispatch(
      progressStart({
        id: taskId,
        label: "Loading dataset",
        value: null,
        phase: "Parsing…",
        kind: "compute",
        progressMode: "indeterminate",
      })
    );
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = await parseBytesInWorker(bytes, needsGzip);
      if (!isCurrent()) return;
      const parsed = JSON.parse(text);
      if (parsed && parsed.format === "multipart-dataset-v1") {
        throw new Error(
          "Multipart manifest datasets cannot be dropped as a single file"
        );
      }
      await new JSONLoader().resolveParsed(parsed, (dataset) => {
        if (!isCurrent()) return;
        const datasetType = (dataset.datasetType ?? "default").toLowerCase();
        onDataSelected({ ...dataset, datasetType, sourcePath: `upload:${file.name}` });
      });
      if (!isCurrent()) return;
      dispatch(progressComplete({ id: taskId }));
      activeTaskIdRef.current = null;
    } catch (err) {
      if (!isCurrent() || isAbortError(err)) return;
      console.error("Failed to load dropped JSON:", file.name, err);
      dispatch(progressFail({ id: taskId, label: "Failed to load dataset" }));
      setUploadError(
        `Failed to load ${file.name}: ${err instanceof Error ? err.message : String(err)}`
      );
      activeTaskIdRef.current = null;
    }
  };

  const handleDroppedFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    setUploadError(null);
    switch (classifyDroppedFile(file.name)) {
      case "csv":
        parseCsvForWizard(file);
        break;
      case "json":
        void loadDroppedJson(file, false);
        break;
      case "json-gz":
        void loadDroppedJson(file, true);
        break;
      default:
        setUploadError(`Unsupported file type: ${file.name} (use .csv, .json, or .json.gz)`);
    }
  };

  const handleWizardSubmit = ({ mapping, datasetType }: UploadWizardSubmit) => {
    const upload = pendingUpload;
    setPendingUpload(null);
    if (!upload) return;
    cancelActiveLoad();

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const taskId = `dataset:upload:${upload.fileName}#${requestSeq}`;
    const abortController = new AbortController();
    activeTaskIdRef.current = taskId;
    activeAbortRef.current = abortController;
    const isCurrent = () =>
      requestSeqRef.current === requestSeq && activeTaskIdRef.current === taskId;

    dispatch(
      progressStart({
        id: taskId,
        label: "Loading dataset",
        value: null,
        phase: "Preparing dataset…",
        kind: "compute",
        progressMode: "indeterminate",
      })
    );

    void loadSimpleDataset(upload.rows, mapping, {
      datasetType,
      parentTaskId: taskId,
      signal: abortController.signal,
    })
      .then((dataset) => {
        if (!isCurrent()) return;
        onDataSelected({ ...dataset, datasetType, sourcePath: `upload:${upload.fileName}` });
        dispatch(
          progressUpdate({ id: taskId, label: "Loading dataset", phase: "Done", value: 100 })
        );
        dispatch(progressComplete({ id: taskId }));
        activeTaskIdRef.current = null;
        activeAbortRef.current = null;
      })
      .catch((err) => {
        if (!isCurrent() || isAbortError(err)) return;
        console.error("Failed to prepare uploaded CSV:", upload.fileName, err);
        dispatch(progressFail({ id: taskId, label: "Failed to prepare dataset" }));
        setUploadError(
          err instanceof DatasetTooLargeError
            ? err.message
            : `Failed to prepare ${upload.fileName}`
        );
        activeTaskIdRef.current = null;
        activeAbortRef.current = null;
      });
  };

  const handlePredefinedChange = (entry: DatasetEntry) => {
    cancelActiveLoad();

    // Issue #315 G4 slice 2 — kick the aggregate-first base for the new
    // dataset at click time (before the download below), so its base appears
    // as soon as the small aggregate fetch lands instead of after full ingest.
    onPredefinedPickStart?.(entry);

    // Apply the target dataset visual preset immediately so color/style switches
    // are visible while data is still loading.
    dispatch(updateSettings(getDatasetVisualPreset({ datasetType: entry.datasetType, datasetPath: entry.path })));

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;

    const taskId = `dataset:${entry.path}#${requestSeq}`;
    const abortController = new AbortController();
    activeTaskIdRef.current = taskId;
    // ONE loading line (issue #315 Task 3b): boot compute tasks adopt this
    // load task as their progress parent, folding into a single dock card.
    setActiveDatasetLoadTask(taskId);
    activeAbortRef.current = abortController;
    activeLoadMonitorRef.current = startDatasetLoadMonitor(taskId, entry.path);
    activeLoadMonitorRef.current.setPhase("start");

    const isCurrent = () =>
      requestSeqRef.current === requestSeq && activeTaskIdRef.current === taskId;

    const finishCurrent = () => {
      if (!isCurrent()) return;
      activeLoadMonitorRef.current?.setPhase("viewer:activate");
      dispatch(
        progressUpdate({
          id: taskId,
          label: "Loading dataset",
          phase: "Activating in viewer…",
          value: 99,
        })
      );
      void waitForViewerPaint().then(() => {
        if (!isCurrent()) return;
        activeLoadMonitorRef.current?.setPhase("viewer:painted");
        dispatch(
          progressUpdate({ id: taskId, label: "Loading dataset", phase: "Done", value: 100 })
        );
        clearCompletionTimeout();
        completeTimeoutRef.current = window.setTimeout(() => {
          if (!isCurrent()) return;
          dispatch(progressComplete({ id: taskId }));
          activeLoadMonitorRef.current?.setPhase("done");
          activeLoadMonitorRef.current?.stop("completed");
          activeLoadMonitorRef.current = null;
          activeAbortRef.current = null;
          activeJobRef.current = null;
          activeTaskIdRef.current = null;
          setActiveDatasetLoadTask(null);
          setJob(null);
        }, 300);
      });
    };

    const failCurrent = (label: string) => {
      if (!isCurrent()) return;
      activeLoadMonitorRef.current?.setPhase("failed");
      activeLoadMonitorRef.current?.stop("failed");
      activeLoadMonitorRef.current = null;
      dispatch(progressFail({ id: taskId, label }));
      activeAbortRef.current = null;
      activeJobRef.current = null;
      activeTaskIdRef.current = null;
      setActiveDatasetLoadTask(null);
      setJob(null);
    };

    // If this is a multipart manifest, handle with the new loader (and show indeterminate progress)
    if (entry.path.endsWith("/manifest.json") || entry.path.endsWith("manifest.json")) {
      activeLoadMonitorRef.current?.setPhase("manifest:fetch");
      dispatch(
        progressStart({
          id: taskId,
          label: "Loading dataset",
          value: null, // indeterminate
          phase: "Fetching manifest…",
          kind: "io",
          progressMode: "predictive",
        })
      );

      void loadDatasetAuto(resolveDatasetFetchPath(entry.path), {
        signal: abortController.signal,
        parentTaskId: taskId,
      })
        .then((dataset) => {
          if (!isCurrent()) return;
          // Optional: brief "Preparing…" phase for consistency
          activeLoadMonitorRef.current?.setPhase("manifest:prepare-selected");
          dispatch(setDatasetMetadata({ datasetType: entry.datasetType, datasetPath: entry.path }));
          applyRendererDefaults(entry.datasetType);
          dispatch(
            progressUpdate({
              id: taskId,
              label: "Loading dataset",
              phase: "Preparing…",
              value: null,
            })
          );
          activeLoadMonitorRef.current?.setPhase("onDataSelected");
          onDataSelected({ ...dataset, datasetType: entry.datasetType, sourcePath: entry.path });
          finishCurrent();
        })
        .catch((err) => {
          if (!isCurrent() || isAbortError(err)) return;
          console.error("Failed to load manifest dataset:", entry.path, err);
          failCurrent("Failed to load dataset");
        });

      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Legacy single-file path (JSON/JSON.GZ/CSV) with predictive progress
    // ─────────────────────────────────────────────────────────────────────────
    // Defer metadata+renderer switch until data is ready (avoid race where
    // the new renderer runs against still-loaded old data).
    let metadataApplied = false;
    const applyMetadataOnce = () => {
      if (metadataApplied || !isCurrent()) return;
      metadataApplied = true;
      dispatch(setDatasetMetadata({ datasetType: entry.datasetType, datasetPath: entry.path }));
      applyRendererDefaults(entry.datasetType);
    };

    const weights = getWeights(entry.path);
    const predict = getPredictedDurations(entry.path);

    const t0 = performance.now();
    let tNet = 0,
      tParse = 0,
      tPrepare = 0;
    let parseStart: number | null = null,
      parseEnd: number | null = null;
    let prepStart: number | null = null,
      prepEnd: number | null = null;

    let qParse = 0,
      qPrep = 0;
    const overall = () =>
      100 * (weights.net * (tNet > 0 ? 1 : 0) + weights.parse * qParse + weights.prepare * qPrep);

    const animatePhase = (
      start: number,
      durationMs: number,
      setQ: (q: number) => void,
      label: string,
      parkAt = 0.98
    ) => {
      const span = Math.max(200, durationMs);
      const tick = () => {
        if (!isCurrent()) return;
        const q = Math.min((performance.now() - start) / span, parkAt);
        setQ(q);
        dispatch(
          progressUpdate({
            id: taskId,
            label: "Loading dataset",
            phase: label,
            value: Math.min(99, overall()),
          })
        );
        rafId.current = requestAnimationFrame(tick);
      };
      rafId.current = requestAnimationFrame(tick);
    };

    dispatch(
      progressStart({
        id: taskId,
        label: "Loading dataset",
        value: 0,
        phase: "Downloading…",
        kind: "io",
        progressMode: "predictive",
      })
    );
    activeLoadMonitorRef.current?.setPhase("download");

    const newJob = new DownloadJob(entry, abortController.signal);
    activeJobRef.current = newJob;
    setJob(newJob);

    let downloadIndeterminateShown = false;

    void newJob.start(
      // onFinishText (CSV or legacy JSON path)
      async (result: string) => {
        if (!isCurrent()) return;
        tNet = performance.now() - t0;

        const isJson =
          entry.path.endsWith(".json") || entry.path.endsWith(".json.gz");
        if (isJson) {
          // If this JSON is actually a manifest, route to the manifest loader
          try {
            const maybe = JSON.parse(result);
            if (maybe && maybe.format === "multipart-dataset-v1") {
              // Switch to indeterminate manifest path for the remainder
              activeLoadMonitorRef.current?.setPhase("manifest:fetch");
              dispatch(
                progressUpdate({
                  id: taskId,
                  label: "Loading dataset",
                  phase: "Fetching manifest…",
                  value: null,
                })
              );
              const dataset = await loadDatasetAuto(entry.path, {
                signal: abortController.signal,
                parentTaskId: taskId,
              });
              if (!isCurrent()) return;
              activeLoadMonitorRef.current?.setPhase("onDataSelected");
              applyMetadataOnce();
              onDataSelected({ ...dataset, datasetType: entry.datasetType, sourcePath: entry.path });
              finishCurrent();
              setJob(null);
              return;
            }
          } catch {
            // not a manifest, fall through to legacy JSON loader
          }

          // Small JSON fallback: predictive parse on main thread (rare)
          activeLoadMonitorRef.current?.setPhase("parse:legacy-json");
          const parseAnimStart = performance.now();
          animatePhase(
            parseAnimStart,
            predict.parseMs,
            (q) => (qParse = Math.max(qParse, q)),
            "Parsing…",
            0.98
          );
          try {
            await new JSONLoader().resolveContent(
              result,
              (dataset) => {
                applyMetadataOnce();
                onDataSelected({
                  ...dataset,
                  datasetType: entry.datasetType,
                  sourcePath: entry.path,
                });
              },
              (phase) => {
                if (phase.phase === "parse") {
                  if (parseStart === null) parseStart = performance.now();
                  if (phase.q === 1) {
                    if (!isCurrent()) return;
                    parseEnd = performance.now();
                    qParse = 1;
                    stopAnim();
                    dispatch(
                      progressUpdate({
                        id: taskId,
                        label: "Loading dataset",
                        phase: "Preparing…",
                        value: Math.min(99, overall()),
                      })
                    );
                  }
                } else {
                  activeLoadMonitorRef.current?.setPhase("prepare:legacy-json");
                  if (prepStart === null) prepStart = performance.now();
                  if (phase.q === 1) {
                    if (!isCurrent()) return;
                    prepEnd = performance.now();
                    qPrep = 1;
                    stopAnim();
                    finishCurrent();
                  } else {
                    if (!isCurrent()) return;
                    dispatch(
                      progressUpdate({
                        id: taskId,
                        label: "Loading dataset",
                        phase: "Preparing…",
                        value: Math.min(99, overall()),
                      })
                    );
                  }
                }
              }
            );
          } catch (err) {
            if (!isCurrent() || isAbortError(err)) return;
            stopAnim();
            failCurrent("Failed to parse dataset");
            setJob(null);
            return;
          }

          if (!isCurrent()) return;
          if (parseStart && parseEnd) tParse = parseEnd - parseStart;
          if (prepStart && prepEnd) tPrepare = prepEnd - prepStart;
          updateWeights(entry.path, { net: tNet, parse: tParse, prepare: tPrepare });
          setJob(null);
          return;
        }

        // CSV → simple-format pipeline (kNN, splines, and clustering are
        // computed in a worker; see dataPreprocessing/simpleDataset.ts).
        if (!isCurrent()) return;
        dispatch(
          progressUpdate({
            id: taskId,
            label: "Loading dataset",
            phase: "Parsing CSV…",
            value: null,
          })
        );
        activeLoadMonitorRef.current?.setPhase("parse:csv");
        const pStart = performance.now();
        const parsed = Papa.parse<Record<string, string>>(result, {
          header: true,
          skipEmptyLines: true,
        });
        const inferred = inferSimpleColumnMapping(parsed.meta.fields ?? []);
        if (!inferred.x || !inferred.y) {
          console.error("CSV dataset is missing x/y columns:", entry.path);
          failCurrent("CSV is missing x/y columns");
          setJob(null);
          return;
        }
        try {
          const dataset = await loadSimpleDataset(
            parsed.data,
            inferred as SimpleColumnMapping,
            {
              datasetType: entry.datasetType,
              parentTaskId: taskId,
              signal: abortController.signal,
            }
          );
          if (!isCurrent()) return;
          applyMetadataOnce();
          activeLoadMonitorRef.current?.setPhase("onDataSelected");
          onDataSelected({ ...dataset, datasetType: entry.datasetType, sourcePath: entry.path });
        } catch (err) {
          if (!isCurrent() || isAbortError(err)) return;
          console.error("Failed to preprocess CSV dataset:", entry.path, err);
          failCurrent("Failed to prepare dataset");
          setJob(null);
          return;
        }
        const pEnd = performance.now();
        updateWeights(entry.path, { net: tNet, parse: pEnd - pStart, prepare: 0 });
        finishCurrent();
        setJob(null);
      },
      // onProgress
      (pct: number | null) => {
        if (!isCurrent()) return;
        if (pct === null) {
          if (!downloadIndeterminateShown) {
            downloadIndeterminateShown = true;
            dispatch(
              progressUpdate({
                id: taskId,
                value: null,
                label: "Loading dataset",
                phase: "Downloading…",
              })
            );
          }
          return;
        }
        const w = getWeights(entry.path).net;
        dispatch(
          progressUpdate({
            id: taskId,
            value: Math.min(99, (pct / 100) * (w * 100)),
            label: "Loading dataset",
            phase: "Downloading…",
          })
        );
      },
      // onFinishBytes (JSON preferred path)
      async ({ bytes, needsClientGzip }) => {
        if (!isCurrent()) return;
        tNet = performance.now() - t0;

        // Predictive determinate parse while the worker runs
        activeLoadMonitorRef.current?.setPhase("parse:worker-json");
        const parseAnimStart = performance.now();
        animatePhase(
          parseAnimStart,
          predict.parseMs,
          (q) => (qParse = Math.max(qParse, q)),
          "Parsing…",
          0.98
        );

        try {
          const w = makeJsonWorker();
          const parsed: unknown = await new Promise((resolve, reject) => {
            w.onmessage = (e: MessageEvent<{ ok?: boolean; parsed?: unknown; error?: string }>) => {
              if (!isCurrent()) {
                w.terminate();
                reject(new DOMException("Dataset load aborted", "AbortError"));
                return;
              }
              const { ok, parsed, error } = e.data || {};
              w.terminate();
              if (ok) resolve(parsed);
              else reject(new Error(error || "Worker parse failed"));
            };
            w.onerror = (err) => {
              w.terminate();
              reject(err);
            };
            // Transfer the ArrayBuffer for zero-copy
            w.postMessage(
              { kind: "parseBytes", bytes: bytes.buffer, needsGzip: needsClientGzip },
              [bytes.buffer]
            );
          });

          if (!isCurrent()) return;
          parseEnd = performance.now();
          qParse = 1;
          stopAnim();
          dispatch(
            progressUpdate({
              id: taskId,
              label: "Loading dataset",
              phase: "Preparing…",
              value: Math.min(99, overall()),
            })
          );

          await new JSONLoader().resolveParsed(
            parsed,
            (dataset) => {
              activeLoadMonitorRef.current?.setPhase("onDataSelected");
              applyMetadataOnce();
              onDataSelected({
                ...dataset,
                datasetType: entry.datasetType,
                sourcePath: entry.path,
              });
            },
            (phase) => {
              if (phase.phase === "prepare") {
                activeLoadMonitorRef.current?.setPhase("prepare:worker-json");
                if (prepStart === null) prepStart = performance.now();
                if (phase.q === 1) {
                  if (!isCurrent()) return;
                  prepEnd = performance.now();
                  qPrep = 1;
                  stopAnim();
                  finishCurrent();
                } else {
                  if (!isCurrent()) return;
                  qPrep = Math.max(qPrep, Math.min(0.95, phase.q));
                  dispatch(
                    progressUpdate({
                      id: taskId,
                      label: "Loading dataset",
                      phase: "Preparing…",
                      value: Math.min(99, overall()),
                    })
                  );
                }
              }
            }
          );
        } catch (e) {
          if (!isCurrent() || isAbortError(e)) return;
          stopAnim();
          failCurrent("Failed to parse dataset");
          setJob(null);
          return;
        }

        if (!isCurrent()) return;
        if (parseStart && parseEnd) tParse = parseEnd - parseStart;
        if (prepStart && prepEnd) tPrepare = prepEnd - prepStart;
        updateWeights(entry.path, { net: tNet, parse: tParse, prepare: tPrepare });
        setJob(null);
      }
    ).catch((err) => {
      if (!isCurrent() || isAbortError(err)) return;
      console.error("Failed to download dataset:", entry.path, err);
      failCurrent("Failed to load dataset");
    });
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Box sx={{ pl: 2, pt: 2, pr: 2 }}>
        <Typography variant="subtitle2" gutterBottom>
          Custom datasets
        </Typography>
        <DragAndDrop accept=".csv,.json,.json.gz" handleDrop={handleDroppedFiles}>
          <Box
            sx={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1,
              py: 2,
            }}
          >
            <Typography variant="body2" color="text.secondary" align="center">
              Drop a CSV (projected x/y + features) or a preprocessed JSON here
            </Typography>
            <Button size="small" variant="outlined" component="label">
              Browse…
              <input
                type="file"
                hidden
                accept=".csv,.json,.gz"
                onChange={(e) => {
                  handleDroppedFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </Button>
          </Box>
        </DragAndDrop>
        {uploadError && (
          <Alert severity="error" variant="outlined" sx={{ mt: 1 }}>
            {uploadError}
          </Alert>
        )}
      </Box>

      <UploadWizardDialog
        open={pendingUpload !== null}
        fileName={pendingUpload?.fileName ?? ""}
        headers={pendingUpload?.headers ?? []}
        rowCount={pendingUpload?.rows.length ?? 0}
        onCancel={() => setPendingUpload(null)}
        onSubmit={handleWizardSubmit}
      />

      <Box sx={{ pl: 2, pt: 3 }}>
        <Typography variant="subtitle2" gutterBottom>
          Predefined datasets
        </Typography>
      </Box>

      <PredefinedDatasets onChange={handlePredefinedChange} />
    </Box>
  );
};

export default DatasetTabPanel;
