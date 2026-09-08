// packages/app/src/components/Visualization/Details/Tabular/TabularFeatureInsets.tsx
//
// Scrollable tabular insets for datasets without a bespoke detail renderer:
// - FeatureSummaryInset: per-cluster feature rows — value + a density cue
//   showing the cluster's distribution (blue) over the whole dataset's
//   (gray), default-ranked by Jensen-Shannon divergence vs. the dataset.
// - FeatureDiffInset: two-cluster rows — the two sides' densities overlaid
//   (blue vs orange), default-ranked by JSD(A,B).
// The *Container variants read the full dataset from DataContext and memoize
// row computation; reference distributions are cached per dataset in
// featureStats.ts, so insets never re-scan the whole dataset.
//
// Interactivity: pointer events bubble out of the card so the inset item
// root's drag-to-reposition handlers work (#303) — the canvas behaviors
// still never claim card gestures because the card carries
// `data-interaction-ignore` (lasso) and pan only filters right-button.
// Only two events are shielded: wheel (capture-phase stopPropagation
// WITHOUT preventDefault — the container's zoom listener never sees it and
// the row list scrolls natively, `overflow-y: auto`, capped at
// MAX_VISIBLE_ROWS visible rows), and pointerdown on the scroll container's
// scrollbar gutter (so a native scrollbar drag scrolls instead of starting
// an inset drag).

import { CircularProgress } from "@mui/material";
import {
  type CSSProperties,
  type PointerEventHandler,
  type ReactNode,
  useMemo,
  useState,
} from "react";
import { useDataRef } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import {
  computeDiffRows,
  computeSummaryRows,
  type DiffRow,
  type DiffSortKey,
  type FeatureColumn,
  formatStatValue,
  sortDiffRows,
  sortSummaryRows,
  type SummaryRow,
  type SummarySortKey,
} from "./featureStats";
import { useBackendDiffRows, useBackendSummaryRows } from "./tabularStatsBackend";
import {
  TABULAR_CUE_WIDTH_PX,
  TABULAR_HEADER_HEIGHT_PX,
  TABULAR_ROW_HEIGHT_PX,
  TABULAR_VALUE_WIDTH_PX,
  tabularInsetBaseHeightPx,
} from "./tabularInsetLayout";

const CUE_HEIGHT = 14;
const COLOR_A = "#4477aa"; // cluster / side A
const COLOR_B = "#ee7733"; // side B (colorblind-safe pair)
const COLOR_REFERENCE = "#9e9e9e"; // whole-dataset reference

const headerStyle: CSSProperties = {
  height: TABULAR_HEADER_HEIGHT_PX,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 4,
  padding: "0 6px",
  borderBottom: "1px solid #ddd",
  fontSize: 10,
  color: "#444",
  flex: "none",
};

const rowStyle: CSSProperties = {
  height: TABULAR_ROW_HEIGHT_PX,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "0 6px",
  fontSize: 10,
  color: "#222",
};

const nameStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const valueStyle: CSSProperties = {
  flex: "none",
  fontVariantNumeric: "tabular-nums",
  textAlign: "right",
  minWidth: TABULAR_VALUE_WIDTH_PX,
  maxWidth: TABULAR_VALUE_WIDTH_PX,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

/**
 * Interactive card shell: re-enables pointer events (inset item roots are
 * pointerEvents: none) and lets wheel events scroll the card instead of
 * zooming the scatterplot. Pointer events deliberately bubble through to the
 * inset item root so drag-to-reposition works on tabular insets too (#303).
 */
function InsetCard({
  widthPx,
  heightPx,
  children,
}: {
  widthPx: number;
  heightPx: number;
  children: ReactNode;
}) {
  return (
    <div
      data-interaction-ignore="true"
      // stopPropagation only — preventDefault would kill the scroll itself.
      onWheelCapture={(e) => e.stopPropagation()}
      style={{
        width: widthPx,
        height: heightPx,
        boxSizing: "border-box",
        background: "rgba(255,255,255,0.96)",
        border: "1px solid #999",
        borderRadius: 4,
        fontFamily: "sans-serif",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        filter: "drop-shadow(0px 1px 4px rgba(0,0,0,0.35))",
        pointerEvents: "auto",
        userSelect: "none",
      }}
    >
      {children}
    </div>
  );
}

interface SortButtonSpec<K extends string> {
  key: K;
  label: string;
  title: string;
}

function SortHeader<K extends string>({
  title,
  buttons,
  active,
  descending,
  onSort,
}: {
  title: string;
  buttons: SortButtonSpec<K>[];
  active: K;
  descending: boolean;
  onSort: (key: K) => void;
}) {
  return (
    <div style={headerStyle}>
      <span style={{ ...nameStyle, fontWeight: 600 }} title={title}>
        {title}
      </span>
      <span style={{ display: "flex", gap: 2, flex: "none" }}>
        {buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            title={b.title}
            onClick={(e) => {
              e.stopPropagation();
              onSort(b.key);
            }}
            style={{
              border: "1px solid #ccc",
              borderRadius: 3,
              background: active === b.key ? "#e3ecf7" : "#fff",
              color: "#333",
              fontSize: 9,
              lineHeight: "12px",
              padding: "0 3px",
              cursor: "pointer",
            }}
          >
            {b.label}
            {active === b.key ? (descending ? "↓" : "↑") : ""}
          </button>
        ))}
      </span>
    </div>
  );
}

/**
 * A pointerdown on the scroll container's own scrollbar gutter must scroll,
 * not start an inset drag: the gutter lies outside the client box, so
 * offsetX/Y at or past clientWidth/Height identifies it. Scrollbar events
 * target the scrolling element itself — presses on rows pass through.
 */
const stopScrollbarGutterPointerDown: PointerEventHandler<HTMLDivElement> = (e) => {
  const el = e.currentTarget;
  if (e.target !== el) return;
  const { offsetX, offsetY } = e.nativeEvent;
  if (offsetX >= el.clientWidth || offsetY >= el.clientHeight) e.stopPropagation();
};

/** The scroll region: this is what makes the inset "scrollable". */
function ScrollableRows({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div
      data-testid={testId}
      onPointerDown={stopScrollbarGutterPointerDown}
      style={{
        flex: "1 1 auto",
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
        scrollbarWidth: "thin",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Smooth (Catmull-Rom → bezier) closed area path for one density vector,
 * scaled against a shared peak so overlaid curves are comparable.
 */
function densityAreaPath(
  probs: readonly number[],
  width: number,
  height: number,
  peak: number
): string {
  const n = probs.length;
  if (n === 0) return "";
  const xs = probs.map((_, i) => ((i + 0.5) / n) * width);
  const ys = probs.map((p) => height - (peak > 0 ? (p / peak) * (height - 1.5) : 0));
  let d = `M0,${height} L${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const p0x = xs[Math.max(0, i - 1)];
    const p0y = ys[Math.max(0, i - 1)];
    const p3x = xs[Math.min(n - 1, i + 2)];
    const p3y = ys[Math.min(n - 1, i + 2)];
    const c1x = xs[i] + (xs[i + 1] - p0x) / 6;
    const c1y = ys[i] + (ys[i + 1] - p0y) / 6;
    const c2x = xs[i + 1] - (p3x - xs[i]) / 6;
    const c2y = ys[i + 1] - (p3y - ys[i]) / 6;
    d += ` C${c1x},${c1y} ${c2x},${c2y} ${xs[i + 1]},${ys[i + 1]}`;
  }
  d += ` L${width},${height} Z`;
  return d;
}

/**
 * Density-pair cue: overlaid smoothed density areas for numeric features
 * (both normalized to the shared peak so the shapes are comparable), paired
 * per-category bars for categorical ones. `q` renders first (background).
 */
function DistPairCue({
  kind,
  p,
  q,
  colorP,
  colorQ,
}: {
  kind: SummaryRow["kind"];
  p: readonly number[];
  q: readonly number[];
  colorP: string;
  colorQ: string;
}) {
  const w = TABULAR_CUE_WIDTH_PX;
  const h = CUE_HEIGHT;
  if (kind === "numeric") {
    const peak = Math.max(...p, ...q, 1e-12);
    return (
      <svg width={w} height={h} style={{ flex: "none", pointerEvents: "none" }} aria-hidden>
        <path d={densityAreaPath(q, w, h, peak)} fill={colorQ} fillOpacity={0.35} stroke={colorQ} strokeWidth={1} />
        <path d={densityAreaPath(p, w, h, peak)} fill={colorP} fillOpacity={0.4} stroke={colorP} strokeWidth={1.2} />
      </svg>
    );
  }
  const n = Math.max(p.length, 1);
  const slot = w / n;
  const barW = Math.max(1, slot / 2 - 0.5);
  const peak = Math.max(...p, ...q, 1e-12);
  return (
    <svg width={w} height={h} style={{ flex: "none", pointerEvents: "none" }} aria-hidden>
      {p.map((pi, i) => {
        const qi = q[i] ?? 0;
        const x = i * slot;
        return (
          <g key={i}>
            <rect x={x + slot / 2} y={h - (qi / peak) * h} width={barW} height={(qi / peak) * h} fill={colorQ} fillOpacity={0.7} />
            <rect x={x + slot / 2 - barW} y={h - (pi / peak) * h} width={barW} height={(pi / peak) * h} fill={colorP} />
          </g>
        );
      })}
    </svg>
  );
}

const percent = (v: number): string => `${Math.round(v * 100)}%`;

// ---------------------------------------------------------------------------
// Summary view
// ---------------------------------------------------------------------------

export interface FeatureSummaryInsetProps {
  rows: SummaryRow[];
  pointCount: number;
  widthPx: number;
}

const summaryTooltip = (r: SummaryRow): string =>
  r.kind === "numeric"
    ? `${r.column} — mean ${formatStatValue(r.mean!)}, median ${formatStatValue(r.median!)}, ` +
      `range ${formatStatValue(r.min!)}…${formatStatValue(r.max!)}, σ ${formatStatValue(r.std!)}; ` +
      `difference vs. all data ${percent(r.divergence)} (Jensen-Shannon)`
    : `${r.column} — most common: ${r.modeLabel} (${percent(r.modeShare!)}); ` +
      `difference vs. all data ${percent(r.divergence)} (Jensen-Shannon)`;

export function FeatureSummaryInset({ rows, pointCount, widthPx }: FeatureSummaryInsetProps) {
  const [sortKey, setSortKey] = useState<SummarySortKey>("difference");
  const [descending, setDescending] = useState(true);
  const sorted = useMemo(
    () => sortSummaryRows(rows, sortKey, descending),
    [rows, sortKey, descending]
  );
  const onSort = (key: SummarySortKey) => {
    if (key === sortKey) setDescending((d) => !d);
    else {
      setSortKey(key);
      setDescending(key !== "name");
    }
  };

  return (
    <InsetCard widthPx={widthPx} heightPx={tabularInsetBaseHeightPx(sorted.length)}>
      <SortHeader<SummarySortKey>
        title={`${pointCount} pts · ${sorted.length} features`}
        buttons={[
          { key: "name", label: "Az", title: "Sort by feature name" },
          { key: "difference", label: "Δ", title: "Sort by difference vs. all data (Jensen-Shannon divergence)" },
          { key: "value", label: "μ", title: "Sort by value (mean; share of the most common category for categorical features)" },
          { key: "variance", label: "σ²", title: "Sort by spread (variance; impurity for categorical features)" },
        ]}
        active={sortKey}
        descending={descending}
        onSort={onSort}
      />
      <ScrollableRows testId="tabular-summary-rows">
        {sorted.map((r) => (
          <div key={r.column} style={rowStyle} data-testid="tabular-summary-row">
            <span style={nameStyle} title={summaryTooltip(r)}>
              {r.column}
            </span>
            <span
              style={valueStyle}
              title={
                r.kind === "numeric"
                  ? `cluster mean of ${r.column}`
                  : `most common ${r.column} in this cluster`
              }
            >
              {r.kind === "numeric" ? formatStatValue(r.mean!) : r.modeLabel}
            </span>
            <DistPairCue
              kind={r.kind}
              p={r.probs}
              q={r.referenceProbs}
              colorP={COLOR_A}
              colorQ={COLOR_REFERENCE}
            />
          </div>
        ))}
      </ScrollableRows>
    </InsetCard>
  );
}

/** Spinner card shown while the stats service resolves a cluster's rows;
 * sized to the expected row count so the card doesn't jump on arrival. */
function LoadingCard({
  widthPx,
  rowCount,
  quiet,
}: {
  widthPx: number;
  rowCount: number;
  /** Pushed-content grace (issue #315 H2): shell without the spinner. */
  quiet?: boolean;
}) {
  return (
    <InsetCard widthPx={widthPx} heightPx={tabularInsetBaseHeightPx(rowCount)}>
      <div
        data-testid={quiet ? "tabular-grace" : "tabular-loading"}
        style={{ flex: "1 1 auto", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        {!quiet && <CircularProgress size={16} />}
      </div>
    </InsetCard>
  );
}

/** Server-rendered inset shell (issue #315 wave S): the whole card is ONE
 * <img> — no per-row React trees in the settle burst. The corner button
 * switches this inset to live rows (the sortable/interactive view), which
 * re-requests the JSON payload. Height matches the rows layout so the
 * annealer boxes don't jump between shell and rows modes. */
function RenderedInsetCard({
  url,
  widthPx,
  rowCount,
  onWantRows,
}: {
  url: string;
  widthPx: number;
  rowCount: number;
  onWantRows: () => void;
}) {
  return (
    <InsetCard widthPx={widthPx} heightPx={tabularInsetBaseHeightPx(rowCount)}>
      <div style={{ position: "relative", flex: "1 1 auto", minHeight: 0 }} data-testid="tabular-rendered">
        <img
          src={url}
          alt=""
          draggable={false}
          style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }}
        />
        <button
          type="button"
          title="Switch to live rows (sortable)"
          data-testid="tabular-rendered-to-rows"
          onClick={(e) => {
            e.stopPropagation();
            onWantRows();
          }}
          style={{
            position: "absolute",
            top: 2,
            right: 2,
            width: 16,
            height: 16,
            padding: 0,
            border: "none",
            borderRadius: 3,
            background: "rgba(255,255,255,0.75)",
            color: "#666",
            fontSize: 10,
            lineHeight: "16px",
            cursor: "pointer",
          }}
        >
          ≡
        </button>
      </div>
    </InsetCard>
  );
}

/**
 * Computes/fetches the summary rows and renders them. With a `tabular-stats`
 * backend active (issue #315), rows arrive fully binned from the service —
 * no raw features and no whole-dataset reference are read here; otherwise
 * (or when the service is unreachable) the rows are computed client-side
 * from the dataset in context, exactly as before the backend existed.
 * Wave S: the service is asked to RENDER the card server-side first; a
 * service without render support answers rows and everything proceeds as
 * before, so the paper build and older servers are unaffected.
 */
export function FeatureSummaryInsetContainer({
  samples,
  columns,
  widthPx,
}: {
  samples: DataPoint[];
  columns: FeatureColumn[];
  widthPx: number;
}) {
  const dataRef = useDataRef();
  const [wantRows, setWantRows] = useState(false);
  const backend = useBackendSummaryRows(samples, { preferRendered: !wantRows });
  const rows = useMemo(
    () =>
      backend.kind === "ready"
        ? backend.rows
        : backend.kind === "local"
          ? computeSummaryRows(samples, columns, dataRef.current)
          : [],
    [backend, samples, columns, dataRef]
  );
  if (backend.kind === "image") {
    return (
      <RenderedInsetCard
        url={backend.url}
        widthPx={widthPx}
        rowCount={columns.length}
        onWantRows={() => setWantRows(true)}
      />
    );
  }
  if (backend.kind === "loading") {
    return (
      <LoadingCard widthPx={widthPx} rowCount={columns.length} quiet={backend.grace} />
    );
  }
  return <FeatureSummaryInset rows={rows} pointCount={samples.length} widthPx={widthPx} />;
}

// ---------------------------------------------------------------------------
// Difference view
// ---------------------------------------------------------------------------

export interface FeatureDiffInsetProps {
  rows: DiffRow[];
  countA: number;
  countB: number;
  widthPx: number;
}

const diffTooltip = (r: DiffRow): string =>
  r.kind === "numeric"
    ? `${r.column} — A mean ${formatStatValue(r.meanA!)} → B mean ${formatStatValue(r.meanB!)} ` +
      `(Δ ${formatStatValue(r.deltaMean!)}); difference ${percent(r.divergence)} (Jensen-Shannon)`
    : `${r.column} — A: ${r.modeA} → B: ${r.modeB}; difference ${percent(r.divergence)} (Jensen-Shannon)`;

export function FeatureDiffInset({ rows, countA, countB, widthPx }: FeatureDiffInsetProps) {
  const [sortKey, setSortKey] = useState<DiffSortKey>("difference");
  const [descending, setDescending] = useState(true);
  const sorted = useMemo(
    () => sortDiffRows(rows, sortKey, descending),
    [rows, sortKey, descending]
  );
  const onSort = (key: DiffSortKey) => {
    if (key === sortKey) setDescending((d) => !d);
    else {
      setSortKey(key);
      setDescending(key !== "name");
    }
  };

  return (
    <InsetCard widthPx={widthPx} heightPx={tabularInsetBaseHeightPx(sorted.length)}>
      <SortHeader<DiffSortKey>
        title={`Δ ${countA} vs ${countB} pts`}
        buttons={[
          { key: "name", label: "Az", title: "Sort by feature name" },
          { key: "difference", label: "Δ", title: "Sort by distribution difference between A and B (Jensen-Shannon divergence)" },
          { key: "value", label: "μΔ", title: "Sort by |Δ mean| (categorical features by their distribution difference)" },
        ]}
        active={sortKey}
        descending={descending}
        onSort={onSort}
      />
      <ScrollableRows testId="tabular-diff-rows">
        {sorted.map((r) => (
          <div key={r.column} style={rowStyle} data-testid="tabular-diff-row">
            <span style={nameStyle} title={diffTooltip(r)}>
              {r.column}
            </span>
            <span
              style={{
                ...valueStyle,
                color:
                  r.kind !== "numeric" || r.deltaMean === 0
                    ? "#666"
                    : r.deltaMean! > 0
                      ? COLOR_B
                      : COLOR_A,
              }}
              title={
                r.kind === "numeric"
                  ? `difference of means (B − A) for ${r.column}`
                  : `distribution difference (Jensen-Shannon) for ${r.column}`
              }
            >
              {r.kind === "numeric"
                ? `${r.deltaMean! > 0 ? "+" : ""}${formatStatValue(r.deltaMean!)}`
                : percent(r.divergence)}
            </span>
            <DistPairCue kind={r.kind} p={r.probsA} q={r.probsB} colorP={COLOR_A} colorQ={COLOR_B} />
          </div>
        ))}
      </ScrollableRows>
    </InsetCard>
  );
}

/** Diff-row counterpart of FeatureSummaryInsetContainer: backend rows when a
 * `tabular-stats` service is active, the client-side path otherwise. */
export function FeatureDiffInsetContainer({
  aSamples,
  bSamples,
  columns,
  widthPx,
}: {
  aSamples: DataPoint[];
  bSamples: DataPoint[];
  columns: FeatureColumn[];
  widthPx: number;
}) {
  const dataRef = useDataRef();
  const [wantRows, setWantRows] = useState(false);
  const backend = useBackendDiffRows(aSamples, bSamples, { preferRendered: !wantRows });
  const rows = useMemo(
    () =>
      backend.kind === "ready"
        ? backend.rows
        : backend.kind === "local"
          ? computeDiffRows(aSamples, bSamples, columns, dataRef.current)
          : [],
    [backend, aSamples, bSamples, columns, dataRef]
  );
  if (backend.kind === "image") {
    return (
      <RenderedInsetCard
        url={backend.url}
        widthPx={widthPx}
        rowCount={columns.length}
        onWantRows={() => setWantRows(true)}
      />
    );
  }
  if (backend.kind === "loading") {
    return (
      <LoadingCard widthPx={widthPx} rowCount={columns.length} quiet={backend.grace} />
    );
  }
  return (
    <FeatureDiffInset
      rows={rows}
      countA={aSamples.length}
      countB={bSamples.length}
      widthPx={widthPx}
    />
  );
}
