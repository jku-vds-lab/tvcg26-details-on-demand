import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

/** [episode line, step-within-episode] reference sent to the render service. */
export type RenderPointRef = [number, number];

function readStep(sample: DataPoint): number | undefined {
  // Gym CSVs carry a "step" column; multipart records inline it on the point,
  // simple-format loads may put it in the features bag.
  const record = sample as unknown as Record<string, unknown>;
  const raw = record["step"] ?? sample.features?.["step"];
  const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(num) ? num : undefined;
}

/** Extract the (line, step) references the Python render service can restore.
 * Samples without a resolvable step are skipped. */
export function extractRenderPoints(samples: DataPoint[]): RenderPointRef[] {
  const points: RenderPointRef[] = [];
  for (const sample of samples) {
    const step = readStep(sample);
    if (step === undefined || !Number.isFinite(sample.line)) continue;
    points.push([sample.line, step]);
  }
  return points;
}
