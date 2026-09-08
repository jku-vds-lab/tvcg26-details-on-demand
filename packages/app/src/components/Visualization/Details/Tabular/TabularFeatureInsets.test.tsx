import { fireEvent, render, screen } from "@testing-library/react";
import { DataProvider } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { collectFeatureColumns, computeDiffRows, computeSummaryRows } from "./featureStats";
import {
  MAX_VISIBLE_ROWS,
  TABULAR_HEADER_HEIGHT_PX,
  TABULAR_ROW_HEIGHT_PX,
  tabularInsetBaseHeightPx,
  tabularInsetBaseWidthPx,
} from "./tabularInsetLayout";
import {
  FeatureDiffInset,
  FeatureSummaryInset,
  FeatureSummaryInsetContainer,
} from "./TabularFeatureInsets";

const makePoint = (extra: Record<string, unknown>): DataPoint =>
  ({ x: 0, y: 0, id: 0, line: 0, DoI: 1, ...extra }) as unknown as DataPoint;

const manyFeatureSamples = (): DataPoint[] => {
  const featureNames = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
  return [0, 1, 2].map((row) =>
    makePoint(Object.fromEntries(featureNames.map((n, i) => [n, row * (i + 1)])))
  );
};

const summaryRowsOf = (samples: DataPoint[], reference: DataPoint[] = samples) =>
  computeSummaryRows(samples, collectFeatureColumns(samples), reference);

describe("FeatureSummaryInset", () => {
  it("renders one row per feature inside an internally scrollable container", () => {
    const samples = manyFeatureSamples();
    render(
      <FeatureSummaryInset
        rows={summaryRowsOf(samples)}
        pointCount={samples.length}
        widthPx={tabularInsetBaseWidthPx(1)}
      />
    );

    const rows = screen.getAllByTestId("tabular-summary-row");
    expect(rows).toHaveLength(10);

    // Core UX ask: past MAX_VISIBLE_ROWS the rows scroll internally instead
    // of growing the inset.
    const scroller = screen.getByTestId("tabular-summary-rows");
    expect(scroller.style.overflowY).toBe("auto");
    expect(rows.length).toBeGreaterThan(MAX_VISIBLE_ROWS);
    const card = scroller.parentElement as HTMLElement;
    expect(card.style.height).toBe(`${tabularInsetBaseHeightPx(rows.length)}px`);
    expect(tabularInsetBaseHeightPx(rows.length)).toBe(
      TABULAR_HEADER_HEIGHT_PX + MAX_VISIBLE_ROWS * TABULAR_ROW_HEIGHT_PX
    );
    // Interactivity: the card re-enables pointer events (item roots are
    // pointerEvents: none) so its buttons and scrollbar are usable.
    expect(card.style.pointerEvents).toBe("auto");
  });

  it("defaults to difference-vs-dataset sort and re-sorts by value on click", () => {
    // Cluster = low half of "low", full spread of "flat" → low diverges more.
    const reference = [1, 2, 3, 4, 5, 6, 7, 8].map((v) => makePoint({ low: v, flat: v % 2 }));
    const cluster = reference.slice(0, 3);
    render(
      <FeatureSummaryInset
        rows={summaryRowsOf(cluster, reference)}
        pointCount={cluster.length}
        widthPx={tabularInsetBaseWidthPx(4)}
      />
    );

    const names = () =>
      screen.getAllByTestId("tabular-summary-row").map((r) => r.firstChild!.textContent);

    expect(names()[0]).toBe("low"); // highest JSD vs dataset first

    fireEvent.click(screen.getByTitle(/Sort by value/));
    expect(names()).toEqual(["low", "flat"]); // mean 2 vs ~0.33, descending

    fireEvent.click(screen.getByTitle(/Sort by value/));
    expect(names()).toEqual(["flat", "low"]); // ascending after flip

    fireEvent.click(screen.getByTitle("Sort by feature name"));
    expect(names()).toEqual(["flat", "low"]);
  });

  it("container computes rows from the DataContext dataset", () => {
    const samples = [makePoint({ v: 1 }), makePoint({ v: 2 })];
    render(
      <DataProvider>
        <FeatureSummaryInsetContainer
          samples={samples}
          columns={collectFeatureColumns(samples)}
          widthPx={tabularInsetBaseWidthPx(1)}
        />
      </DataProvider>
    );
    expect(screen.getAllByTestId("tabular-summary-row")).toHaveLength(1);
    expect(screen.getByText("v")).toBeTruthy();
  });
});

describe("InsetCard interactivity (#303)", () => {
  /** jsdom has no PointerEvent; a MouseEvent with the pointer type carries
   *  the fields the handlers read. offsetX/Y are not constructible — define
   *  them on the instance. */
  const firePointerDown = (el: Element, offset?: { offsetX: number; offsetY: number }) => {
    const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 });
    if (offset) {
      Object.defineProperty(event, "offsetX", { value: offset.offsetX });
      Object.defineProperty(event, "offsetY", { value: offset.offsetY });
    }
    fireEvent(el, event);
  };

  /** Renders a summary card inside a listener div standing in for the inset
   *  item root, whose bubble-phase handlers implement drag-to-reposition. */
  const renderCardInRoot = () => {
    const onPointerDown = jest.fn();
    const onWheel = jest.fn();
    const samples = manyFeatureSamples();
    render(
      <div onPointerDown={onPointerDown} onWheel={onWheel}>
        <FeatureSummaryInset
          rows={summaryRowsOf(samples)}
          pointCount={samples.length}
          widthPx={tabularInsetBaseWidthPx(1)}
        />
      </div>
    );
    // jsdom has no layout — give the scroller a client box so the scrollbar
    // gutter (offsetX/Y past clientWidth/Height) is distinguishable.
    const scroller = screen.getByTestId("tabular-summary-rows");
    Object.defineProperty(scroller, "clientWidth", { value: 90, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 105, configurable: true });
    return { onPointerDown, onWheel, scroller };
  };

  it("pointerdown on a feature row bubbles to the inset root (drag can engage)", () => {
    const { onPointerDown } = renderCardInRoot();
    firePointerDown(screen.getAllByTestId("tabular-summary-row")[0]);
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("pointerdown on the scroll container's content area bubbles to the inset root", () => {
    const { onPointerDown, scroller } = renderCardInRoot();
    firePointerDown(scroller, { offsetX: 40, offsetY: 40 });
    expect(onPointerDown).toHaveBeenCalledTimes(1);
  });

  it("pointerdown on the scrollbar gutter is stopped — it scrolls, never drags", () => {
    const { onPointerDown, scroller } = renderCardInRoot();
    firePointerDown(scroller, { offsetX: 95, offsetY: 40 }); // vertical scrollbar
    expect(onPointerDown).not.toHaveBeenCalled();
    firePointerDown(scroller, { offsetX: 40, offsetY: 110 }); // horizontal gutter
    expect(onPointerDown).not.toHaveBeenCalled();
  });

  it("wheel over the card is stopped — it scrolls the rows, never zooms", () => {
    const { onWheel, scroller } = renderCardInRoot();
    fireEvent.wheel(scroller, { deltaY: 10 });
    expect(onWheel).not.toHaveBeenCalled();
  });
});

describe("FeatureDiffInset", () => {
  const a = [makePoint({ big: 0, small: 0 }), makePoint({ big: 1, small: 1 })];
  const b = [makePoint({ big: 100, small: 1.5 }), makePoint({ big: 101, small: 2.5 })];
  const diffRows = () => computeDiffRows(a, b, collectFeatureColumns([...a, ...b]), [...a, ...b]);

  it("renders scrollable rows ranked by divergence by default", () => {
    render(<FeatureDiffInset rows={diffRows()} countA={2} countB={2} widthPx={120} />);

    const rows = screen.getAllByTestId("tabular-diff-row");
    expect(rows).toHaveLength(2);
    const scroller = screen.getByTestId("tabular-diff-rows");
    expect(scroller.style.overflowY).toBe("auto");
  });

  it("re-sorts by name via the header button and shows signed numeric deltas", () => {
    render(<FeatureDiffInset rows={diffRows()} countA={2} countB={2} widthPx={120} />);

    fireEvent.click(screen.getByTitle("Sort by feature name"));
    const rows = screen.getAllByTestId("tabular-diff-row");
    expect(rows[0].textContent).toContain("big");
    expect(rows[0].textContent).toContain("+100");
    expect(rows[1].textContent).toContain("small");
  });
});
