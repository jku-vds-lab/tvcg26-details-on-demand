import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import RBush from "rbush";

const CHUNK_SIZE = 4000;
const MAX_BLOCKING_MS = 1000;
const MAX_BLOCKING_BUDGET_MS = 2500;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, "..");

const manifestPath = path.join(
  workspaceRoot,
  "public",
  "data",
  "trajectories_w128h72_gray_tw150000-150959_step1_pca_latent_sub_tw150000-150959_step1",
  "manifest.json"
);

function joinDatasetPath(baseFile, rel) {
  return path.resolve(path.dirname(baseFile), rel);
}

async function loadJsonGz(filePath) {
  const gz = await readFile(filePath);
  const raw = gunzipSync(gz);
  return JSON.parse(raw.toString("utf8"));
}

async function loadManifest(manifestFile) {
  return JSON.parse(await readFile(manifestFile, "utf8"));
}

function initializeSyntheticPoints(pointCount) {
  return Array.from({ length: pointCount }, (_, idx) => ({
    id: idx,
    x: idx % 1024,
    y: Math.floor(idx / 1024),
    line: Math.floor(idx / 10),
    algo: "cctv",
    action: "move",
    features: undefined,
    lastLineSegments: [],
    nextLineSegments: [],
    selected: false,
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
  }));
}

function updateMax(report, chunkMs) {
  if (chunkMs > report.maxChunkMs) report.maxChunkMs = chunkMs;
  report.blockingBudgetMs += chunkMs;
}

async function appendDataChunked(target, chunk, report) {
  for (let start = 0; start < chunk.length; start += CHUNK_SIZE) {
    const end = Math.min(chunk.length, start + CHUNK_SIZE);
    const t0 = performance.now();
    for (let i = start; i < end; i++) target.push(chunk[i]);
    const chunkMs = performance.now() - t0;
    updateMax(report, chunkMs);
    report.appendChunkCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function normalizePointsInPlace(points, report) {
  for (let start = 0; start < points.length; start += CHUNK_SIZE) {
    const end = Math.min(points.length, start + CHUNK_SIZE);
    const t0 = performance.now();
    for (let i = start; i < end; i++) {
      points[i].selected = false;
      points[i].DoI = 1;
    }
    const chunkMs = performance.now() - t0;
    updateMax(report, chunkMs);
    report.normalizeChunkCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function hydrateSegmentChunk(points, preSegments, report) {
  for (let start = 0; start < preSegments.length; start += CHUNK_SIZE) {
    const end = Math.min(preSegments.length, start + CHUNK_SIZE);
    const t0 = performance.now();
    for (let i = start; i < end; i++) {
      const s = preSegments[i];
      const a = points[s.startIndex];
      const b = points[s.endIndex];
      const seg = {
        x0: s.x0,
        y0: s.y0,
        x1: s.x1,
        y1: s.y1,
        data: {
          nextDataPoint: b,
          lastDataPoint: a,
          doi: s.doi ?? 0,
          startPercentage: s.startPercentage,
          endPercentage: s.endPercentage,
          segmentId: i,
          splineMidPoint: { x: s.splineMidPoint.x, y: s.splineMidPoint.y },
          isArrowSegment: !!s.isArrowSegment,
        },
      };
      a.nextLineSegments.push(seg);
      b.lastLineSegments.push(seg);
      if (s.startPercentage <= 0.5 && s.endPercentage >= 0.5) {
        if (!a.nextEdgeCenter || (a.nextEdgeCenter.x === 0 && a.nextEdgeCenter.y === 0)) {
          a.nextEdgeCenter = { x: s.splineMidPoint.x, y: s.splineMidPoint.y };
        }
      }
    }
    const chunkMs = performance.now() - t0;
    updateMax(report, chunkMs);
    report.hydrateChunkCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function indexHydratedSegmentsChunk(points, tree, report) {
  let inserted = 0;
  const tBatchStart = () => performance.now();
  let t0 = tBatchStart();

  for (let p = 0; p < points.length; p++) {
    const segs = points[p].nextLineSegments;
    if (!Array.isArray(segs) || segs.length === 0) continue;

    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      tree.insert({
        minX: Math.min(s.x0, s.x1),
        minY: Math.min(s.y0, s.y1),
        maxX: Math.max(s.x0, s.x1),
        maxY: Math.max(s.y0, s.y1),
        data: s,
      });

      inserted += 1;
      if (inserted % CHUNK_SIZE === 0) {
        const chunkMs = performance.now() - t0;
        updateMax(report, chunkMs);
        report.indexChunkCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 0));
        t0 = tBatchStart();
      }
    }
  }

  if (inserted % CHUNK_SIZE !== 0) {
    const chunkMs = performance.now() - t0;
    updateMax(report, chunkMs);
    report.indexChunkCount += 1;
  }
}

async function run() {
  const manifest = await loadManifest(manifestPath);
  const pointCount = (manifest?.data?.chunks ?? []).reduce((acc, c) => acc + (c.count ?? 0), 0);
  const points = initializeSyntheticPoints(pointCount);
  const tree = new RBush();

  const report = {
    dataset: "CCTV Edinburgh Office",
    pointCount,
    segmentCount: 0,
    midpointCount: 0,
    appendChunkCount: 0,
    normalizeChunkCount: 0,
    hydrateChunkCount: 0,
    indexChunkCount: 0,
    chunkSize: CHUNK_SIZE,
    maxChunkMs: 0,
    blockingBudgetMs: 0,
    elapsedMs: 0,
    thresholdMs: MAX_BLOCKING_MS,
    blockingBudgetThresholdMs: MAX_BLOCKING_BUDGET_MS,
  };

  const tStart = performance.now();

  // Emulate loader append behavior for data and knn chunks to catch blocking
  // caused by giant concat/copy operations.
  const loadedData = [];
  for (const c of manifest?.data?.chunks ?? []) {
    if (!c?.path) continue;
    const file = joinDatasetPath(manifestPath, c.path);
    const dataChunk = await loadJsonGz(file);
    if (Array.isArray(dataChunk) && dataChunk.length > 0) {
      await appendDataChunked(loadedData, dataChunk, report);
    }
  }

  const loadedKnn = [];
  for (const c of manifest?.knnGraph?.chunks ?? []) {
    if (!c?.path) continue;
    const file = joinDatasetPath(manifestPath, c.path);
    const knnChunk = await loadJsonGz(file);
    if (Array.isArray(knnChunk) && knnChunk.length > 0) {
      await appendDataChunked(loadedKnn, knnChunk, report);
    }
  }

  await normalizePointsInPlace(points, report);

  for (const c of manifest?.segments?.chunks ?? []) {
    if (!c?.path) continue;
    const file = joinDatasetPath(manifestPath, c.path);
    const segChunk = await loadJsonGz(file);
    report.segmentCount += Array.isArray(segChunk) ? segChunk.length : 0;
    if (Array.isArray(segChunk) && segChunk.length > 0) {
      await hydrateSegmentChunk(points, segChunk, report);
    }
  }

  await indexHydratedSegmentsChunk(points, tree, report);

  for (const c of manifest?.trajectoryMidpoints?.chunks ?? []) {
    if (!c?.path) continue;
    const file = joinDatasetPath(manifestPath, c.path);
    const midpointChunk = await loadJsonGz(file);
    report.midpointCount += Array.isArray(midpointChunk) ? midpointChunk.length : 0;
  }

  report.maxChunkMs = Number(report.maxChunkMs.toFixed(2));
  report.blockingBudgetMs = Number(report.blockingBudgetMs.toFixed(2));
  report.elapsedMs = Number((performance.now() - tStart).toFixed(2));

  console.log("[cctv-freeze-check]", JSON.stringify(report, null, 2));

  if (report.maxChunkMs >= MAX_BLOCKING_MS) {
    console.error(
      `[cctv-freeze-check] FAIL: max chunk blocking time ${report.maxChunkMs}ms exceeds ${MAX_BLOCKING_MS}ms`
    );
    process.exit(1);
  }

  if (report.blockingBudgetMs >= MAX_BLOCKING_BUDGET_MS) {
    console.error(
      `[cctv-freeze-check] FAIL: blocking budget ${report.blockingBudgetMs}ms exceeds ${MAX_BLOCKING_BUDGET_MS}ms`
    );
    process.exit(1);
  }

  console.log("[cctv-freeze-check] PASS");
}

run().catch((err) => {
  console.error("[cctv-freeze-check] ERROR", err);
  process.exit(1);
});
