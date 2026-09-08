// packages/app/src/doiPropagation/doiFieldParity.test.ts
//
// Jest half of the field-engine KERNEL parity twin (issue #315 field parity,
// P1 — closes the S4 gap: falloff.ts claimed doi_field.py parity in comments
// only). Numpy owns the semantics: tests/doifield_fixtures.py generates the
// committed pair under __fixtures__/, this suite consumes it and has NO regen
// flag (the reversed-twin precedent of p7SelectGolden.test.ts).
//
//   falloff lane  falloffValue vs doi_field._make_falloff over
//                 shapes x proximity grid x distances — rel 1e-12 gate
//                 (absolute at expected 0), achieved deviation printed.
//   chain lane    chainScanTrajectoryCore vs a python replay of the same
//                 algorithm with float32 stores — BIT-EXACT gate (the
//                 test_doi_propagate.py escalation: tolerance in the message,
//                 equality as the gate).

import * as fs from "fs";
import * as path from "path";

import { computeMaxEmbeddingDistance } from "../utils/embedding";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { falloffValue, type FalloffShape } from "./falloff";
import { computeRecordDistances } from "./fieldDistanceCore";
import {
  chainScanTrajectoryCore,
  computeFieldPreview,
  type FieldPreviewShape,
} from "./fieldPreviewCore";
import { getPropagationPrecomputation, updateNodeGroup } from "./propagateDoi";

const fixtureDir = path.join(__dirname, "__fixtures__");

interface FalloffLaneInput {
  maxEmb: number;
  prox: number[];
  distances: number[];
  shapes: FalloffShape[];
  relTol: number;
}

interface ChainCase {
  name: string;
  past: number;
  future: number;
  values: number[];
}

interface FieldCase {
  name: string;
  shape: FieldPreviewShape;
  prox: number;
  past: number;
  future: number;
  seeds: string;
  /** #337: key into labeledSets — these ids never seed, codes cap. */
  labeled?: string;
  /** #337: key into pinnedSets — clamped to DoI 1 after the chain. */
  pinned?: string;
}

interface ParityInput {
  falloff: FalloffLaneInput;
  chain: {
    line: number[];
    predIndex: number[];
    succIndex: number[];
    cases: ChainCase[];
  };
  field: {
    gridResolution: number;
    maxEmb: number;
    x: number[];
    y: number[];
    line: number[];
    seedSets: Record<string, number[]>;
    labeledSets: Record<string, number[]>;
    pinnedSets: Record<string, number[]>;
    thresholds: { grayOut: number; annotation: number; inset: number };
    relTolDist: number;
    relTolDoi: number;
    cases: FieldCase[];
  };
}

interface FieldCaseExpected {
  recordDist: number[];
  doi: number[];
  codes: number[];
  codesComparable: number[];
}

interface ParityExpected {
  falloff: Record<string, number[][]>;
  chain: Record<string, number[]>;
  field: Record<string, FieldCaseExpected>;
}

const input = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "doiFieldParity.input.json"), "utf8")
) as ParityInput;
const expected = JSON.parse(
  fs.readFileSync(path.join(fixtureDir, "doiFieldParity.expected.json"), "utf8")
) as ParityExpected;

describe("doi field kernel parity (python-owned fixtures)", () => {
  test("falloff family matches doi_field._make_falloff within 1e-12", () => {
    const { maxEmb, prox, distances, shapes, relTol } = input.falloff;
    let maxDev = 0;
    for (const shape of shapes) {
      const perProx = expected.falloff[shape];
      expect(perProx).toHaveLength(prox.length);
      for (let pi = 0; pi < prox.length; pi++) {
        for (let di = 0; di < distances.length; di++) {
          const a = falloffValue(distances[di], shape, prox[pi], maxEmb);
          const e = perProx[pi][di];
          const dev = e === 0 ? Math.abs(a - e) : Math.abs(a - e) / Math.abs(e);
          if (dev > maxDev) maxDev = dev;
          if (dev > relTol) {
            throw new Error(
              `falloff[${shape}][prox=${prox[pi]}][D=${distances[di]}] ` +
                `client ${a} vs python ${e} (dev ${dev.toExponential(3)})`
            );
          }
        }
      }
    }
     
    console.info(
      `[doi field parity] falloff max deviation = ${maxDev.toExponential(3)}`
    );
  });

  test("chain closure is bit-exact vs the python f32 replay", () => {
    const pred = Int32Array.from(input.chain.predIndex);
    const succ = Int32Array.from(input.chain.succIndex);
    let maxDev = 0;
    for (const c of input.chain.cases) {
      const values = Float32Array.from(c.values);
      chainScanTrajectoryCore(values, pred, succ, c.past, c.future);
      const exp = expected.chain[c.name];
      expect(exp).toHaveLength(values.length);
      for (let i = 0; i < values.length; i++) {
        const a = values[i];
        const e = exp[i];
        const dev = e === 0 ? Math.abs(a - e) : Math.abs(a - e) / Math.abs(e);
        if (dev > maxDev) maxDev = dev;
        if (a !== e) {
          throw new Error(
            `chain[${c.name}][${i}] client ${a} vs replay ${e} ` +
              `(dev ${dev.toExponential(3)}; expected bit-exact — the replay ` +
              `mirrors f32 stores)`
          );
        }
      }
    }
     
    console.info(
      `[doi field parity] chain max deviation = ${maxDev.toExponential(3)} ` +
        `(gate: bit-exact)`
    );
  });
});

describe("doi field FIELD-lane parity (full pipeline, python-owned)", () => {
  const lane = input.field;
  const n = lane.x.length;
  // Minimal nodes drive the client's own pred/succ builder — the linkage the
  // production field lane will use.
  const nodes = lane.line.map((ln, i) => ({ id: i, line: ln })) as DataPoint[];
  const { predIndex, succIndex } = getPropagationPrecomputation(nodes);

  test("client projection diameter matches the generator's maxEmb", () => {
    const pts = lane.x.map((px, i) => ({ x: px, y: lane.y[i] }));
    const clientMaxEmb = computeMaxEmbeddingDistance(pts);
    const dev = Math.abs(clientMaxEmb - lane.maxEmb) / lane.maxEmb;
    expect(dev).toBeLessThanOrEqual(1e-12);
  });

  for (const c of lane.cases) {
    const exp = expected.field[c.name];
    const labeledList = c.labeled ? lane.labeledSets[c.labeled] : [];
    const pinnedList = c.pinned ? lane.pinnedSets[c.pinned] : [];
    const labeledIdxSet = new Set(labeledList);
    // #337 seed rule: seed_mask = selected & ~labeled — labeled points never
    // seed the distance field (they still receive DoI).
    const seedIdx = Int32Array.from(
      lane.seedSets[c.seeds].filter((i) => !labeledIdxSet.has(i))
    );

    test(`${c.name}: recordDist matches the engine's sampled geodesic`, () => {
      const { recordDist } = computeRecordDistances({
        x: lane.x,
        y: lane.y,
        seedIdx,
        gridResolution: lane.gridResolution,
      });
      expect(recordDist).toBeInstanceOf(Float32Array);
      let maxDev = 0;
      for (let i = 0; i < n; i++) {
        const a = recordDist[i];
        const e = exp.recordDist[i];
        const dev = e === 0 ? Math.abs(a) : Math.abs(a - e) / Math.abs(e);
        if (dev > maxDev) maxDev = dev;
        if (dev > lane.relTolDist) {
          throw new Error(
            `${c.name} recordDist[${i}] client ${a} vs python ${e} ` +
              `(dev ${dev.toExponential(3)})`
          );
        }
      }
       
      console.info(
        `[doi field parity] ${c.name} recordDist max deviation = ` +
          maxDev.toExponential(3)
      );
      // Ratchet (measured 0.0 on 2026-08-07): the FH EDT + rasterize +
      // bilinear port is BIT-EXACT vs scipy's transform. relTolDist stays as
      // the diagnostic slack in the per-element message above.
      expect(maxDev).toBe(0);
    });

    test(`${c.name}: committed DoI matches decay + clamp + chain`, () => {
      const { recordDist } = computeRecordDistances({
        x: lane.x,
        y: lane.y,
        seedIdx,
        gridResolution: lane.gridResolution,
      });
      const doi = computeFieldPreview({
        recordDist,
        predIndex,
        succIndex,
        seedIdx,
        shape: c.shape,
        prox: c.prox,
        past: c.past,
        future: c.future,
        maxEmb: lane.maxEmb,
      });
      // #337: pins clamp to DoI 1 AFTER the chain — the same order
      // applyResidentFieldLocally applies (pins receive, never emit).
      for (const i of pinnedList) doi[i] = 1;
      let maxDev = 0;
      for (let i = 0; i < n; i++) {
        const a = doi[i];
        const e = exp.doi[i];
        const dev = e === 0 ? Math.abs(a) : Math.abs(a - e) / Math.abs(e);
        if (dev > maxDev) maxDev = dev;
        if (dev > lane.relTolDoi) {
          throw new Error(
            `${c.name} doi[${i}] client ${a} vs python ${e} ` +
              `(dev ${dev.toExponential(3)})`
          );
        }
      }
      for (let i = 0; i < seedIdx.length; i++) {
        expect(doi[seedIdx[i]]).toBe(1);
      }

      console.info(
        `[doi field parity] ${c.name} doi max deviation = ` +
          maxDev.toExponential(3)
      );
      // Ratchet (measured 0.0 on 2026-08-07): decay + clamp + chain over the
      // f32 field is BIT-EXACT vs the python contract replay.
      expect(maxDev).toBe(0);
    });

    test(`${c.name}: doiGroup ladder + labeled cap match _group_codes_vec`, () => {
      // #337: codes were python-only until the labeled cap moved onto the
      // field lane. The client twin is the PRODUCTION ladder+cap —
      // updateNodeGroup with labeledNodeIds — evaluated on the (bit-exact)
      // client DoI, compared where codesComparable is 1.
      const { recordDist } = computeRecordDistances({
        x: lane.x,
        y: lane.y,
        seedIdx,
        gridResolution: lane.gridResolution,
      });
      const doi = computeFieldPreview({
        recordDist,
        predIndex,
        succIndex,
        seedIdx,
        shape: c.shape,
        prox: c.prox,
        past: c.past,
        future: c.future,
        maxEmb: lane.maxEmb,
      });
      for (const i of pinnedList) doi[i] = 1;
      const labeledNodeIds = labeledList.length
        ? new Set(labeledList.map(String))
        : undefined;
      const thresholds = {
        grayOutDoiThreshold: lane.thresholds.grayOut,
        annotationDoiThreshold: lane.thresholds.annotation,
        insetDoiThreshold: lane.thresholds.inset,
      };
      const GROUP_CODE: Record<string, number> = {
        gray: 0,
        transparent: 1,
        annotation: 2,
        inset: 3,
      };
      for (let i = 0; i < n; i++) {
        if (!exp.codesComparable[i]) continue;
        const probe = { id: i, DoI: doi[i] } as unknown as DataPoint;
        updateNodeGroup(probe, thresholds, labeledNodeIds);
        const a = GROUP_CODE[probe.doiGroup!];
        if (a !== exp.codes[i]) {
          throw new Error(
            `${c.name} codes[${i}] client ${probe.doiGroup} (${a}) vs ` +
              `python ${exp.codes[i]} (doi ${doi[i]})`
          );
        }
      }
    });
  }
});
