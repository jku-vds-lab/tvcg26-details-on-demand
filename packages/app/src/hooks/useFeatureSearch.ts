// src/hooks/useFeatureSearch.ts
import * as d3 from "d3";
import type { MutableRefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getFeatureValue } from "src/utils/getFeatureValue";
import type { SliderSettings } from "../components/InterestTabSliders";
import { useDataRef } from "../contexts/DataContext";
import { useSegmentsRef } from "../contexts/SegmentsContext";
import { useTrajectoryMidpointsRef } from "../contexts/TrajectoryMidpointsContext";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import { resolveCutProvider } from "@scaling";
import { updateTrajectoryMidpointDoIs } from "../dataPreprocessing/dataPreprocessing";
import { updateEdgeColumnDois } from "../dataPreprocessing/splineColumns";
import { sidecarColumnsFor } from "../dataPreprocessing/columnSidecar";
import {
  deferredColumnEntry,
  deferredColumnNames,
  pendingDeferredColumns,
} from "../dataPreprocessing/lazyColumns";
import { materializeRowsBlocking, rowAt } from "../dataPreprocessing/lazyRows";
import { ensureResidentColumnsWithChip } from "../utils/rowResidency";
import { allNodeIds, columnsOf, doiOpacityField, writeSelectionByIds } from "../dataPreprocessing/pointColumns";
import {
  propagateSelectionOnServer,
  runLocalFieldPropagation,
  serverPropagationEligible,
} from "../doiPropagation/serverPropagation";
import type { RendererAPI } from "../gl/api/RendererAPI";
import { freehandPinnedIds } from "../slices/freehandSlice";
import {
  bumpClusteringEpoch,
  isCurrentClusteringEpoch,
  runHdbscanClusteringWithStatus,
  runTrajectoryMidpointClusteringWithStatus,
} from "../clustering/hdbscanClustering";
import type { VisualizationSettings } from "../store";
import store, { setSelectedNodes } from "../store";
import type { PrecomputedHdbscanResult } from "./useFullSelectionHdbscanInstance";

export interface FeatureSearchDeps {
  rendererRef: MutableRefObject<RendererAPI | null>;
  canvasContainerRef: React.RefObject<HTMLDivElement>;
  scales:
    | { xScale: d3.ScaleLinear<number, number>; yScale: d3.ScaleLinear<number, number> }
    | null;
  visualSettings: VisualizationSettings;
  currentSliderSettingsRef: MutableRefObject<SliderSettings>;
  performZoomClustering: () => void;
  fullSelectionHdbscan: PrecomputedHdbscanResult | undefined;
  fullSelectionMidpointHdbscan: PrecomputedHdbscanResult | undefined;
  dataset?: DataPoint[];

  // Optional tuning knobs; sensible defaults are applied.
  includePixelKeysPolicy?: "auto" | "include" | "exclude";
  maxKeysInSuggestions?: number;
  sampleRowsForProfiling?: number;
  maxValueSuggestions?: number;
}

/* -----------------------------------------------------------
   Schema inference & ranking (dataset-agnostic)
----------------------------------------------------------- */

type ValueKind = "num" | "str" | "bool" | "null" | "mixed";

interface KeyStats {
  total: number;
  nulls: number;
  uniques: number;
  kind: ValueKind;
  avgStrLen: number;
}

const PIXEL_KEY_RE = /^\d+x\d+$/i;
const DEFAULT_EXCLUDE = new Set([
  "id", "selected", "DoI", "neighbors", "edges", "px", "py",
  // keep generic; do not exclude domain fields like "line"
]);

const PROFILE_SAMPLE_DEFAULT = 300;
const MAX_UNIQUE_TRACK = 512; // cap to bound memory
const MAX_KEYS_SUGGESTIONS_DEFAULT = 1000;
const MAX_VALUE_SUGGESTIONS_DEFAULT = 200;

function classify(v: unknown): ValueKind {
  if (v === null || v === undefined) return "null";
  const t = typeof v;
  if (t === "number") return Number.isFinite(v as number) ? "num" : "null";
  if (t === "boolean") return "bool";
  if (t === "string") return "str";
  return "mixed";
}

function profileKeys(rows: DataPoint[], sampleLimit: number) {
  const n = Math.min(sampleLimit, rows.length);
  const keySet = new Set<string>();
  const uniqMaps = new Map<string, Set<string>>();
  const totals = new Map<string, number>();
  const nulls = new Map<string, number>();
  const kinds = new Map<string, ValueKind>();
  const strLen = new Map<string, number>();

  for (let i = 0; i < n; i++) {
    // Bounded row probe (issue #315 R1b): 300 rows, built on demand on the
    // row-lazy lane — the sample is what defines the searchable key set, so it
    // has to see real own-property shapes.
    const r = rowAt(rows, i);
    if (!r) continue;
    const keys = Object.keys(r);
    for (const k of keys) {
      keySet.add(k);
      totals.set(k, (totals.get(k) ?? 0) + 1);
      const raw = getFeatureValue(r, k);
      const kind = classify(raw);
      const prevKind = kinds.get(k);
      kinds.set(k, prevKind ? (prevKind === kind ? kind : "mixed") : kind);

      if (raw === null || raw === undefined) {
        nulls.set(k, (nulls.get(k) ?? 0) + 1);
      } else {
        const s = String(raw);
        if (!uniqMaps.has(k)) uniqMaps.set(k, new Set<string>());
        const set = uniqMaps.get(k)!;
        if (set.size < MAX_UNIQUE_TRACK) set.add(s);
        if (typeof raw === "string") {
          strLen.set(k, (strLen.get(k) ?? 0) + (raw as string).length);
        }
      }
    }
  }

  const allKeys = Array.from(keySet);
  const stats = new Map<string, KeyStats>();
  let pixelKeyCount = 0;

  for (const k of allKeys) {
    const total = totals.get(k) ?? 0;
    const nul = nulls.get(k) ?? 0;
    const uniq = (uniqMaps.get(k)?.size ?? 0);
    const kind = kinds.get(k) ?? "mixed";
    const avgStrLen = (strLen.get(k) ?? 0) / Math.max(1, total - nul);
    if (PIXEL_KEY_RE.test(k)) pixelKeyCount++;
    stats.set(k, { total, nulls: nul, uniques: uniq, kind, avgStrLen: isFinite(avgStrLen) ? avgStrLen : 0 });
  }

  return { allKeys, stats, pixelKeyCount, sampledRows: n };
}

function searchabilityScore(k: string, s: KeyStats): number {
  if (DEFAULT_EXCLUDE.has(k)) return -1e9;
  const filled = 1 - (s.nulls / Math.max(1, s.total));
  const uniqFrac = s.total > 0 ? Math.min(1, s.uniques / s.total) : 1;

  // Base on completeness
  let score = 0.6 * filled;

  // Type bonuses
  if (s.kind === "bool") score += 0.6;
  else if (s.kind === "str") score += 0.35;
  else if (s.kind === "num") score += 0.25;

  // Cardinality preference: low/moderate > extreme
  if (uniqFrac < 0.05) score += 0.25;          // few values (categories)
  else if (uniqFrac < 0.8) score += 0.15;      // moderate variety
  else score -= 0.15;                          // near-unique per row

  // Penalize very long strings (likely free text)
  if (s.kind === "str" && s.avgStrLen > 40) score -= 0.15;

  return score;
}

/* -----------------------------------------------------------
   Core hook (lazy per-feature indexing; schema-aware keys)
----------------------------------------------------------- */

function compareValues(candidate: string, operator: string, queryValue: string): boolean {
  const candNum = parseFloat(candidate);
  const queryNum = parseFloat(queryValue);
  const bothNumeric = !isNaN(candNum) && !isNaN(queryNum);
  switch (operator) {
    case "=":  return bothNumeric ? candNum === queryNum : candidate.toLowerCase() === queryValue.toLowerCase();
    case "!=": return bothNumeric ? candNum !== queryNum : candidate.toLowerCase() !== queryValue.toLowerCase();
    case "<":  return bothNumeric ? candNum <  queryNum : candidate.toLowerCase() <  queryValue.toLowerCase();
    case ">":  return bothNumeric ? candNum >  queryNum : candidate.toLowerCase() >  queryValue.toLowerCase();
    case "<=": return bothNumeric ? candNum <= queryNum : candidate.toLowerCase() <= queryValue.toLowerCase();
    case ">=": return bothNumeric ? candNum >= queryNum : candidate.toLowerCase() >= queryValue.toLowerCase();
    default:   return false;
  }
}

// --- Query parsing (same as before) ---
type ASTNode = ConditionNode | AndNode | OrNode | NotNode;
interface ConditionNode { type: "condition"; feature: string; operator: string; value: string; }
interface AndNode { type: "and"; left: ASTNode; right: ASTNode; }
interface OrNode  { type: "or"; left: ASTNode; right: ASTNode; }
interface NotNode { type: "not"; expr: ASTNode; }

function tokenize(query: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < query.length) {
    if (/\s/.test(query[i])) { i++; continue; }
    const ch = query[i];

    if (ch === '"') {
      let j = i + 1, quoted = "";
      while (j < query.length) {
        if (query[j] === "\\" && j + 1 < query.length && query[j + 1] === '"') { quoted += '"'; j += 2; }
        else if (query[j] === '"') { break; }
        else { quoted += query[j++]; }
      }
      i = (j < query.length && query[j] === '"') ? j + 1 : j;
      tokens.push(quoted);
      continue;
    }
    if (ch === "(" || ch === ")" || ch === ",") { tokens.push(ch); i++; continue; }

    if (ch === "!") {
      if (i + 1 < query.length && query[i + 1] === "=") { tokens.push("!="); i += 2; }
      else { tokens.push("not"); i++; }
      continue;
    }
    if (i + 1 < query.length) {
      const two = query.slice(i, i + 2);
      if (two === ">=" || two === "<=") { tokens.push(two); i += 2; continue; }
    }
    if ("=<>".includes(ch)) { tokens.push(ch); i++; continue; }

    let j = i;
    while (j < query.length && !/\s/.test(query[j]) && !"()=<>!,".includes(query[j])) j++;
    if (j === i) { i++; continue; }
    tokens.push(query.slice(i, j));
    i = j;
  }
  return tokens;
}
function insertImplicitAnds(tokens: string[]): string[] {
  const delim = new Set(["(", ")", "and", "or", "not", "=", "!=", "<", ">", "<=", ">=", ","]);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    out.push(tokens[i]);
    const next = tokens[i + 1];
    if (!next) continue;
    const currLower = tokens[i].toLowerCase();
    const nextLower = next.toLowerCase();
    const isValueOrClose = !delim.has(currLower);
    const isFeatureStart = !delim.has(nextLower);
    if (isValueOrClose && isFeatureStart) out.push("and");
  }
  return out;
}
function parseQuery(query: string): ASTNode | null {
  const raw = tokenize(query);
  const tokens = insertImplicitAnds(raw);
  let pos = 0;

  function parseExpression(): ASTNode {
    let node = parseTerm();
    while (pos < tokens.length && tokens[pos].toLowerCase() === "or") { pos++; node = { type: "or", left: node, right: parseTerm() }; }
    return node;
  }
  function parseTerm(): ASTNode {
    let node = parseFactor();
    while (pos < tokens.length && tokens[pos].toLowerCase() === "and") { pos++; node = { type: "and", left: node, right: parseFactor() }; }
    return node;
  }
  function parseFactor(): ASTNode {
    if (pos < tokens.length && tokens[pos].toLowerCase() === "not") { pos++; return { type: "not", expr: parseFactor() }; }
    return parsePrimary();
  }
  function parsePrimary(): ASTNode {
    if (tokens[pos] === "(") { pos++; const expr = parseExpression(); if (tokens[pos] !== ")") throw new Error("Expected ')'"); pos++; return expr; }
    return parseCondition();
  }
  function parseCondition(): ASTNode {
    if (pos >= tokens.length) throw new Error("Unexpected end of query");
    const feature = tokens[pos++];
    if (pos >= tokens.length) throw new Error("Expected operator after feature");
    const operator = tokens[pos++];
    if (!["=", "!=", "<", ">", "<=", ">="].includes(operator)) throw new Error("Invalid operator: " + operator);
    if (pos >= tokens.length) throw new Error("Expected value after operator");
    const value = tokens[pos++];
    return { type: "condition", feature, operator, value };
  }

  try {
    const ast = parseExpression();
    if (pos < tokens.length) throw new Error("Unexpected token: " + tokens[pos]);
    return ast;
  } catch { return null; }
}

/** Every feature name a query's conditions reference (issue #315 R3c): the
 * set a deferred-column fetch must cover before evaluation. */
function collectConditionFeatures(ast: ASTNode): string[] {
  switch (ast.type) {
    case "condition": return [ast.feature];
    case "and": return [...collectConditionFeatures(ast.left), ...collectConditionFeatures(ast.right)];
    case "or": return [...collectConditionFeatures(ast.left), ...collectConditionFeatures(ast.right)];
    case "not": return collectConditionFeatures(ast.expr);
  }
}

/* -----------------------------------------------------------
   Hook
----------------------------------------------------------- */

interface FeatureIndex { [feature: string]: { values: { [value: string]: number[] } }; }

export function useFeatureSearch(deps: FeatureSearchDeps) {
  const {
    rendererRef,
    visualSettings,
    currentSliderSettingsRef,
    performZoomClustering,
    fullSelectionHdbscan,
    fullSelectionMidpointHdbscan,
    dataset,
    includePixelKeysPolicy = "include",
    maxKeysInSuggestions = MAX_KEYS_SUGGESTIONS_DEFAULT,
    sampleRowsForProfiling = PROFILE_SAMPLE_DEFAULT,
    maxValueSuggestions = MAX_VALUE_SUGGESTIONS_DEFAULT,
  } = deps;

  const dataRef = useDataRef();
  const segmentsRef = useSegmentsRef();
  const trajectoryMidpointsRef = useTrajectoryMidpointsRef();
  const effectiveDataset: DataPoint[] = dataset ?? dataRef.current;

  // Profile a sample to infer schema and rank keys.
  // Computed asynchronously (after first paint) so that switching to this tab
  // never blocks the render. Starts empty; populates within one setTimeout(0).
  const emptySchema = { allKeys: [] as string[], rankedVisible: [] as string[], pixelKeyCount: 0, mapAll: new Map<string, string>() };
  const [schema, setSchema] = useState(emptySchema);

  useEffect(() => {
    if (!effectiveDataset.length) {
      setSchema({ allKeys: [], rankedVisible: [], pixelKeyCount: 0, mapAll: new Map() });
      return;
    }
    // Defer the heavy work to after the browser has painted so the tab switch
    // feels instant.  The options list will fill in shortly after.
    const timerId = setTimeout(() => {
      const { allKeys, stats, pixelKeyCount } = profileKeys(effectiveDataset, sampleRowsForProfiling);

      // Deferred columns (issue #315 R3c): manifest-declared names live as
      // prototype accessors, so the Object.keys row probe above never sees
      // them — merge them from the declaration with stats synthesized from
      // the manifest types (values fetch on first use; discovery must not).
      const sampled = Math.min(sampleRowsForProfiling, effectiveDataset.length);
      for (const name of deferredColumnNames(effectiveDataset)) {
        if (stats.has(name)) continue;
        const entry = deferredColumnEntry(effectiveDataset, name);
        const cats = entry?.categories;
        const catStrings = cats?.filter((c): c is string => typeof c === "string");
        allKeys.push(name);
        stats.set(name, {
          total: sampled,
          nulls: 0,
          uniques: cats ? cats.length : Math.min(sampled, 32),
          kind: cats ? (catStrings?.length === cats.length ? "str" : "mixed") : "num",
          avgStrLen: catStrings?.length
            ? catStrings.reduce((a, s) => a + s.length, 0) / catStrings.length
            : 0,
        });
      }

      // Build canonical map from ALL observed keys (typed queries must work).
      const mapAll = new Map<string, string>();
      for (const k of allKeys) mapAll.set(k.toLowerCase(), k);

      // Rank keys by searchability; then apply pixel policy.
      const scored = allKeys.map(k => ({ k, score: searchabilityScore(k, stats.get(k)!) }));
      scored.sort((a, b) => b.score - a.score);

      let includePixels = true;
      if (includePixelKeysPolicy === "exclude") includePixels = false;
      else if (includePixelKeysPolicy === "include") includePixels = true;
      else {
        // auto: hide if there is a large grid family
        includePixels = pixelKeyCount <= 128;
      }

      const rankedVisible: string[] = [];
      for (const { k, score } of scored) {
        if (rankedVisible.length >= maxKeysInSuggestions) break;
        if (score < -1e6) continue; // hard excluded
        if (!includePixels && PIXEL_KEY_RE.test(k)) continue;
        rankedVisible.push(k);
      }

      setSchema({ allKeys, rankedVisible, pixelKeyCount, mapAll });
    }, 0);
    return () => clearTimeout(timerId);
  }, [effectiveDataset, includePixelKeysPolicy, maxKeysInSuggestions, sampleRowsForProfiling]);

  // Lazy per-feature index cache.
  const indexRef = useRef<FeatureIndex>({});
  const builtKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    indexRef.current = {};
    builtKeysRef.current = new Set();
  }, [effectiveDataset]);

  function canonicalKeyOrUndefined(feature: string): string | undefined {
    const lower = feature.toLowerCase();
    return schema.mapAll.get(lower);
  }

  function ensureIndexed(featureCanonical: string): boolean {
    if (builtKeysRef.current.has(featureCanonical)) return true;
    // Deferred column not yet fetched (issue #315 R3c): building the index
    // now would freeze an all-undefined column into the cache. Trigger the
    // one-time fetch (chip-visible) and report not-ready — the search path
    // awaits the fetch up front, so only bare suggestions ever see this.
    if (pendingDeferredColumns(effectiveDataset, [featureCanonical]).length > 0) {
      void ensureResidentColumnsWithChip(effectiveDataset, [featureCanonical]).catch(
        () => undefined
      );
      return false;
    }
    const values: { [value: string]: number[] } = {};
    // Columnar value index (issue #315 R1b): a sidecar column holds exactly
    // the values the rows copied out of it, and `getFeatureValue` is
    // `String(row[column] ?? "")` — so the two produce identical keys, and the
    // canonical id column supplies the ids. This is what keeps feature search
    // off the row seam on the server lane.
    const cols = columnsOf(effectiveDataset);
    const sidecarCol = cols
      ? sidecarColumnsFor(effectiveDataset)?.byName[featureCanonical]
      : undefined;
    if (cols && sidecarCol && sidecarCol.length === cols.count) {
      const ids = cols.id;
      for (let i = 0; i < cols.count; i++) {
        const vs = String(sidecarCol[i] ?? "");
        if (!values[vs]) values[vs] = [];
        values[vs].push(ids[i]);
      }
    } else {
      // Runtime-only keys (DoI) and every non-sidecar lane keep the row walk —
      // which on a row-lazy array means materializing first.
      materializeRowsBlocking(effectiveDataset);
      for (const n of effectiveDataset) {
        const raw = getFeatureValue(n, featureCanonical);
        if (raw == null) continue;
        const vs = String(raw);
        if (!values[vs]) values[vs] = [];
        values[vs].push(n.id);
      }
    }
    indexRef.current[featureCanonical] = { values };
    builtKeysRef.current.add(featureCanonical);
    return true;
  }

  // Suggestions: keys ranked from schema; values are per-feature and lazy.
  const suggestions = useCallback(
    (query: string): string[] => {
      const toks = tokenize(query).filter(t => t !== "(" && t !== ")" && t !== ",");
      if (!toks.length) return schema.rankedVisible;

      const ops = ["=", "!=", "<", ">", "<=", ">="];
      const last = toks[toks.length - 1].toLowerCase();

      if (ops.includes(last)) {
        const feat = toks[toks.length - 2] || "";
        const canonical = canonicalKeyOrUndefined(feat);
        if (!canonical) return [];
        if (!ensureIndexed(canonical)) return []; // deferred fetch in flight
        const allValues = Object.keys(indexRef.current[canonical].values).sort((a,b)=>a.localeCompare(b));
        return allValues.slice(0, maxValueSuggestions);
      }

      if (toks.length >= 2 && ops.includes(toks[toks.length - 2])) {
        const feat = toks[toks.length - 3] || "";
        const part = toks[toks.length - 1];
        const canonical = canonicalKeyOrUndefined(feat);
        if (!canonical) return [];
        if (!ensureIndexed(canonical)) return []; // deferred fetch in flight
        const vals = Object.keys(indexRef.current[canonical].values);
        return vals
          .filter(v => v.toLowerCase().startsWith(part.toLowerCase()))
          .sort((a,b)=>a.localeCompare(b))
          .slice(0, maxValueSuggestions);
      }

      const prefix = last;
      // Prefix-match over all keys, but show ranked ones first.
      const ranked = schema.rankedVisible.filter(k => k.toLowerCase().startsWith(prefix));
      if (ranked.length >= 10) return ranked; // enough
      const extras = schema.allKeys
        .filter(k => !schema.rankedVisible.includes(k) && k.toLowerCase().startsWith(prefix))
        .slice(0, Math.max(0, 50 - ranked.length));
      return [...ranked, ...extras];
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- helper fns are re-created per render but close over the same schema listed here; keying on their inputs keeps this callback's identity useful
    [schema, maxValueSuggestions]
  );

  // AST evaluator using lazy per-feature index
  function evaluateCondition(node: ConditionNode): Set<number> {
    const canonical = canonicalKeyOrUndefined(node.feature);
    if (!canonical) return new Set();
    // handleFeatureSearch fetches referenced deferred columns before
    // evaluating, so not-ready here only means the fetch FAILED — match no
    // rows rather than freeze a wrong index.
    if (!ensureIndexed(canonical)) return new Set();
    const out = new Set<number>();
    const bag = indexRef.current[canonical].values;
    for (const cand of Object.keys(bag)) {
      if (compareValues(cand, node.operator, node.value)) {
        for (const id of bag[cand]) out.add(id);
      }
    }
    return out;
  }
  function evaluateAST(ast: ASTNode): Set<number> {
    switch (ast.type) {
      case "condition": return evaluateCondition(ast);
      case "and": {
        const a = evaluateAST(ast.left);
        const b = evaluateAST(ast.right);
        return new Set([...a].filter(x => b.has(x)));
      }
      case "or": {
        const a = evaluateAST(ast.left);
        const b = evaluateAST(ast.right);
        return new Set([...a, ...b]);
      }
      case "not": {
        const inner = evaluateAST(ast.expr);
        const allIds = new Set<number>(allNodeIds(effectiveDataset));
        return new Set([...allIds].filter(x => !inner.has(x)));
      }
    }
  }

  const handleFeatureSearch = useCallback(
    async (query: string): Promise<number> => {
      const epoch = bumpClusteringEpoch();
      const pushOpacityField = (s: SliderSettings) => {
        const renderer = rendererRef.current;
        const nodes = dataRef.current;
        if (!renderer || !nodes?.length) return;

        renderer.setOpacityParams({
          threshold: s.grayOutDoiThreshold,
          minAlpha: visualSettings.minimumOpacityClamping,
          maxAlpha: visualSettings.maximumOpacityClamping,
        });

        renderer.setOpacityField(doiOpacityField(nodes));
        renderer.render();
      };

      if (!query.trim()) {
        const allIds = allNodeIds(effectiveDataset);
        store.dispatch(setSelectedNodes(allIds));
        // Select-all through the column (issue #315 R1a, §3.1).
        const allNodes = dataRef.current;
        const allCols = columnsOf(allNodes);
        if (allCols) {
          writeSelectionByIds(allNodes, allIds);
          allCols.doi.fill(1);
        } else {
          allNodes.forEach(n => { n.selected = true; n.DoI = 1; });
        }

        const s = currentSliderSettingsRef.current;
        // Field lane (#337 PR B — this site had no field dispatch): all
        // points seed, so the distance field is trivially 0 and the falloff
        // floods DoI 1, exactly the graph oracle's select-all result; pins
        // clamp in-lane.
        await runLocalFieldPropagation(dataRef.current, {
          proximitySlider: s.proximitySlider,
          pastSlider: s.pastSlider,
          futureSlider: s.futureSlider,
          maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
          grayOutDoiThreshold: s.grayOutDoiThreshold,
          annotationDoiThreshold: s.annotationDoiThreshold,
          insetDoiThreshold: s.insetDoiThreshold
        }, undefined, { pinnedNodeIds: freehandPinnedIds(store.getState().freehand) });

        updateEdgeColumnDois(segmentsRef.current, dataRef.current);
        updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);
        pushOpacityField(s);

        // Server-cut datasets ship no trees but must still recluster (S2b).
        if (fullSelectionHdbscan || resolveCutProvider(undefined)) {
          await runHdbscanClusteringWithStatus(dataRef.current, fullSelectionHdbscan, undefined, epoch);
          if (fullSelectionMidpointHdbscan || resolveCutProvider(undefined)) {
            await runTrajectoryMidpointClusteringWithStatus(
              trajectoryMidpointsRef.current,
              s.annotationDoiThreshold,
              fullSelectionMidpointHdbscan,
              undefined,
              epoch
            );
          }
        }
        if (isCurrentClusteringEpoch(epoch)) performZoomClustering();
        return allIds.length;
      }

      const ast = parseQuery(query);
      if (!ast) return 0;

      // Deferred columns the query references fetch ONCE before evaluation
      // (issue #315 R3c, §8.8b): one chip-visible RTT, then the value index
      // builds exactly as on the fat lane. A failed fetch degrades to
      // no-matches below instead of a wrong index.
      const referenced = collectConditionFeatures(ast)
        .map((f) => canonicalKeyOrUndefined(f))
        .filter((c): c is string => c !== undefined);
      const pendingCols = pendingDeferredColumns(effectiveDataset, referenced);
      if (pendingCols.length > 0) {
        try {
          await ensureResidentColumnsWithChip(effectiveDataset, pendingCols);
        } catch {
          return 0;
        }
      }

      const ids = Array.from(evaluateAST(ast));
      if (!ids.length) return 0;

      store.dispatch(setSelectedNodes(ids));
      // Selection column + index list (issue #315 R1a, §3.1). Also closes two
      // gaps the row census named: the predicate was `ids.includes(n.id)`
      // INSIDE a full-array walk (O(n·|ids|)), and the seed DoI pre-write ran
      // even when a server propagate would overwrite the whole field one RTT
      // later — the gate App's selection workflow and the lasso already apply.
      {
        const nodes = dataRef.current;
        const cols = columnsOf(nodes);
        const seedWrite = resolveCutProvider(undefined)?.selectPropagate == null;
        if (cols) {
          writeSelectionByIds(nodes, ids);
          if (seedWrite) {
            const sel = cols.selected;
            for (let i = 0; i < nodes.length; i++) cols.doi[i] = sel[i];
          }
        } else {
          const idSet = new Set(ids);
          nodes.forEach(n => {
            const sel = idSet.has(n.id);
            n.selected = sel;
            if (seedWrite) n.DoI = sel ? 1 : 0;
          });
        }
      }

      const s = currentSliderSettingsRef.current;
      const commitSettings = {
        proximitySlider: s.proximitySlider,
        pastSlider: s.pastSlider,
        futureSlider: s.futureSlider,
        maxEmbeddingDistance: visualSettings.maxEmbeddingDistance,
        grayOutDoiThreshold: s.grayOutDoiThreshold,
        annotationDoiThreshold: s.annotationDoiThreshold,
        insetDoiThreshold: s.insetDoiThreshold
      };
      // Server-cut datasets (issue #315 A3 / P-d): the matched ids seed a
      // server propagation (one RTT); the CLIENT FIELD lane on any failure
      // (#337 PR B — this site previously fell back to the graph oracle;
      // the field lane needs no kNN graph, so the R3a trajectory-only
      // degradation and its warnServerLoss are gone).
      let serverApplied = false;
      if (serverPropagationEligible({
        nodeCount: dataRef.current.length,
        labeledExclusionActive: false,
        pinnedCount: freehandPinnedIds(store.getState().freehand).size,
      })) {
        serverApplied = await propagateSelectionOnServer(dataRef.current, commitSettings);
      }
      if (!serverApplied) {
        await runLocalFieldPropagation(dataRef.current, commitSettings, undefined, {
          pinnedNodeIds: freehandPinnedIds(store.getState().freehand),
        });
        // Deletion census (plan §7.4): both writes are server-path dead —
        // edgeDoi's reader is unreachable, midpoint DoI is write-only.
        updateEdgeColumnDois(segmentsRef.current, dataRef.current);
        updateTrajectoryMidpointDoIs(trajectoryMidpointsRef.current);
      }
      pushOpacityField(s);

      // Server-cut datasets ship no trees but must still recluster (S2b).
      if (fullSelectionHdbscan || resolveCutProvider(undefined)) {
        await runHdbscanClusteringWithStatus(dataRef.current, fullSelectionHdbscan, undefined, epoch);
        if (fullSelectionMidpointHdbscan || resolveCutProvider(undefined)) {
          await runTrajectoryMidpointClusteringWithStatus(
            trajectoryMidpointsRef.current,
            s.annotationDoiThreshold,
            fullSelectionMidpointHdbscan,
            undefined,
            epoch
          );
        }
      }
      if (isCurrentClusteringEpoch(epoch)) performZoomClustering();
      return ids.length;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- evaluateAST is re-created per render but closes over the same schema/index state keyed below
    [
      rendererRef,
      visualSettings,
      currentSliderSettingsRef,
      performZoomClustering,
      fullSelectionHdbscan,
      fullSelectionMidpointHdbscan,
      effectiveDataset,
      dataRef,
      segmentsRef,
      trajectoryMidpointsRef,
      schema,
    ]
  );

  return {
    suggestions,
    handleFeatureSearch,
    /**
     * True once the deferred schema profiling has run for a non-empty dataset.
     * Queries evaluated before this resolve feature names to nothing — callers
     * replaying a query programmatically (deep links) must wait for it.
     */
    schemaReady: schema.allKeys.length > 0,
  };
}
