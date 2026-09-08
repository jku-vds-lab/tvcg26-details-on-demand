// Golden-parity contract for the client feature scan (issue #315 slim datasets).
//
// This test runs the REAL extracted sync scan (shouldScanBags + accumulatePoint
// + buildResultsFromAccumulators, UNCAPPED over every fixture row, confidence
// "high") over a deterministic fixture and compares BOTH the input rows and the
// expected {availableKeys, statsByKey} output against
// tests/fixtures/feature_stats_golden.json at the repo root. The Python twin
// (the stats server's pytest) replays the SAME rows through its scan and asserts
// the same output — if either side drifts, one of the two suites goes red.
//
// If the fixture file does not exist yet (or REGENERATE_GOLDEN is set) this test
// WRITES it and passes; commit the generated file. Mirrors the regeneration
// convention of src/semanticZoom/__tests__/serverCutGolden.test.ts.

import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { DataPoint } from "./dataPreprocessing";
import {
  accumulatePoint,
  buildResultsFromAccumulators,
  shouldScanBags,
  type MutableFeatureAccumulator,
} from "./featureScan";

// Repo-root tests/fixtures — packages/ restructure moved this file one level
// deeper (packages/app/src/dataPreprocessing/).
const FIXTURE = path.resolve(__dirname, "../../../../tests/fixtures/feature_stats_golden.json");

const pad = (n: number, width: number): string => String(n).padStart(width, "0");

/**
 * A deterministic fixture exercising every scan edge case:
 * - reward:     numeric with negatives AND floats            → diverging
 * - stepCount:  integer-only, >12 uniques                    → sequential
 * - smallInt:   integer-only, ≤12 uniques                    → categorical
 * - action:     categorical strings                          → categorical
 * - flag:       boolean                                      → boolean
 * - mixed:      mixed numeric/string (<0.95 numeric)         → categorical (w/ min/max)
 * - sparseKey:  present only in the first 10 rows            → totalCount < row count
 * - DoI:        continuous 0..1                              → special-cased "sequential"
 * - emptyStr:   includes empty-string values                 → counted, categorical
 * - manyCat:    60 distinct categories (> the 50 category cap) → categories sliced to 50
 * - hugeUnique: 1001 distinct values (> the 1000 unique cap)   → unique-count overflow
 *
 * The unique/category caps are module constants (1000 / 50) that can only be
 * exceeded with a large row block, so the hand-authored rich rows are followed
 * by a generated block. No `features` bag is included: whether the server
 * flattens nested bags is a server-side concern the golden must not impose.
 */
function buildFixtureRows(): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const HAND = 30;
  for (let i = 0; i < HAND; i++) {
    const row: Record<string, unknown> = {
      reward: (i - 15) * 0.5,
      stepCount: i,
      smallInt: i % 6,
      action: ["north", "south", "east", "west"][i % 4],
      flag: i % 2 === 0,
      mixed: i % 5 === 0 ? "n/a" : i * 1.5,
      DoI: i / (HAND - 1),
      emptyStr: i % 3 === 0 ? "" : "val" + (i % 3),
    };
    if (i < 10) row.sparseKey = i;
    rows.push(row);
  }
  // 1001 distinct hugeUnique values exceed MAX_UNIQUES_TRACKED (1000); manyCat
  // cycles 60 distinct values, exceeding MAX_CATEGORIES_TRACKED (50). Zero-
  // padded so lexicographic == numeric order (keeps the sort unambiguous for
  // the Python side, which need not replicate ICU natural collation).
  const BULK = 1001;
  for (let i = 0; i < BULK; i++) {
    rows.push({ hugeUnique: "u" + pad(i, 4), manyCat: "c" + pad(i % 60, 2) });
  }
  return rows;
}

function runScan(rows: Record<string, unknown>[]): {
  availableKeys: string[];
  statsByKey: Record<string, unknown>;
} {
  const points = rows as unknown as DataPoint[];
  const accByKey = new Map<string, MutableFeatureAccumulator>();
  const scanBags = shouldScanBags(points);
  for (const p of points) accumulatePoint(p, accByKey, scanBags);
  return buildResultsFromAccumulators(accByKey, "high");
}

describe("feature-scan golden parity (issue #315 slim datasets)", () => {
  it("scan output matches the committed golden fixture (shared with Python)", () => {
    const rows = buildFixtureRows();
    const expected = runScan(rows);
    const golden = { rows, expected };

    if (!fs.existsSync(FIXTURE) || process.env.REGENERATE_GOLDEN) {
      fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
      fs.writeFileSync(FIXTURE, JSON.stringify(golden) + "\n");
      console.warn(`featureScan.golden: wrote fixture ${FIXTURE} — commit it.`);
      return;
    }

    const committed = JSON.parse(fs.readFileSync(FIXTURE, "utf-8"));
    expect(golden.rows).toEqual(committed.rows);
    expect(golden.expected).toEqual(committed.expected);
  });
});
