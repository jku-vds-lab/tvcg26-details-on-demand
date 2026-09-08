import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import { DataProvider } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import store, { setDatasetMetadata } from "src/store";
import { ABSTRACT_INSET_BASE_WIDTH_PX } from "./Abstract/AbstractDetailViewInset";
import { DefaultDatasetRenderer } from "./DefaultDatasetRenderer";
import { tabularInsetBaseWidthPx } from "./Tabular/tabularInsetLayout";

const makeSample = (extra: Record<string, unknown> = {}): DataPoint =>
  ({
    x: 0,
    y: 0,
    line: 0,
    id: 0,
    DoI: 1,
    ...extra,
  }) as unknown as DataPoint;

describe("DefaultDatasetRenderer tabular insets", () => {
  it("renders the feature-summary card for samples with numeric features", () => {
    const renderer = new DefaultDatasetRenderer();
    const samples = [makeSample({ reward: 1 }), makeSample({ reward: 2 })];
    const element = renderer.renderSingleNodeInset(samples);
    expect(element).toBeTruthy();

    const scale = renderer.getTransform().scale;
    // Width fits the longest feature name ("reward", 6 chars).
    expect(renderer.getBoundingBox().width).toBeCloseTo(tabularInsetBaseWidthPx(6) * scale);
  });

  it("falls back to the abstract placeholder without any feature columns", () => {
    const renderer = new DefaultDatasetRenderer();
    // Only reserved/internal keys — no numeric or categorical features.
    const samples = [makeSample()];
    renderer.renderSingleNodeInset(samples);

    const scale = renderer.getTransform().scale;
    // Abstract path unions the overlay label into the layout bbox; the visual
    // bbox stays the placeholder's own size.
    expect(renderer.getVisualBoundingBox().width).toBeCloseTo(
      ABSTRACT_INSET_BASE_WIDTH_PX * scale
    );
  });

  it("pins the abstract placeholder for paper-figure datasets even with feature columns", () => {
    // Paper-figure parity (2026-08-05): guiding/combination rows carry
    // step/algo/state_annotation, which would otherwise select the tabular
    // card — their catalog entries pin the abstract look the figures show.
    store.dispatch(
      setDatasetMetadata({ datasetPath: "data/guiding-example_knng_splines_stability.json.gz" })
    );
    try {
      const renderer = new DefaultDatasetRenderer();
      const samples = [makeSample({ reward: 1 }), makeSample({ reward: 2 })];
      renderer.renderSingleNodeInset(samples);
      const scale = renderer.getTransform().scale;
      expect(renderer.getVisualBoundingBox().width).toBeCloseTo(
        ABSTRACT_INSET_BASE_WIDTH_PX * scale
      );
    } finally {
      store.dispatch(setDatasetMetadata({ datasetPath: "" }));
    }
  });

  it("labels node insets from the mapped label field with a downward drop shadow (#305)", () => {
    const renderer = new DefaultDatasetRenderer();
    const samples = [
      makeSample({ reward: 1, label: "Setosa", action: "a1" }),
      makeSample({ reward: 2, label: "Setosa", action: "a2" }),
    ];
    render(<DataProvider>{renderer.renderSingleNodeInset(samples)}</DataProvider>);

    // The label field (upload-wizard class column copy) beats the action
    // fallback in the overlay-label chain.
    const overlayText = screen.getByText("Setosa");
    // Rubik's-parity shadow: blurred downward — never the old upward offset.
    const svg = overlayText.closest("svg") as SVGElement;
    expect(svg.style.filter).toMatch(/drop-shadow\(0px \d/);
  });

  it("paints the overlay label below the card so its shadow never covers inset content", () => {
    const renderer = new DefaultDatasetRenderer();
    const samples = [
      makeSample({ reward: 1, label: "Setosa" }),
      makeSample({ reward: 2, label: "Setosa" }),
    ];
    const { container } = render(
      <DataProvider>{renderer.renderSingleNodeInset(samples)}</DataProvider>
    );

    const labelDiv = screen.getByText("Setosa").closest("svg")!.parentElement!;
    const card = container.querySelector("[data-interaction-ignore]")!;
    // The label's downward drop-shadow spills onto the card's top edge; the
    // card must paint over it, i.e. the label comes FIRST in DOM order and
    // carries no z-index lifting it back above.
    expect(labelDiv.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(labelDiv.style.zIndex).toBe("");
  });

  it("labels node insets with the action majority when no label column resolves", () => {
    const renderer = new DefaultDatasetRenderer();
    const samples = [
      makeSample({ reward: 1, action: "setosa" }),
      makeSample({ reward: 2, action: "setosa" }),
    ];
    renderer.renderSingleNodeInset(samples);

    const scale = renderer.getTransform().scale;
    const cardWidth = tabularInsetBaseWidthPx(6) * scale;
    // The overlay label region is unioned into the layout bbox (annealer
    // reserves it); the visual bbox stays the card itself.
    expect(renderer.getVisualBoundingBox().width).toBeCloseTo(cardWidth);
    expect(renderer.getBoundingBox().height).toBeGreaterThan(
      renderer.getVisualBoundingBox().height
    );
  });

  it("keeps the user-selected action majority as the diff-inset overlay label", () => {
    const renderer = new DefaultDatasetRenderer();
    const edgeSample = makeSample({
      action: "setosa",
      edgeStart: makeSample({ v: 1 }),
      edgeEnd: makeSample({ v: 5 }),
    });
    renderer.renderSingleEdgeInset([edgeSample]);
    // Overlay label region is unioned into the layout bbox (annealer space).
    expect(renderer.getBoundingBox().height).toBeGreaterThan(
      renderer.getVisualBoundingBox().height
    );
  });

  it("renders the feature-diff card without an overlay when no action is set", () => {
    const renderer = new DefaultDatasetRenderer();
    const edgeSample = makeSample({
      edgeStart: makeSample({ v: 1 }),
      edgeEnd: makeSample({ v: 5 }),
    });
    renderer.renderSingleEdgeInset([edgeSample]);
    // No label union: layout bbox equals the card bbox exactly.
    expect(renderer.getBoundingBox()).toEqual(renderer.getVisualBoundingBox());
  });

  it("renders the feature-diff card when edge samples carry both sides", () => {
    const renderer = new DefaultDatasetRenderer();
    const edgeSample = makeSample({
      edgeStart: makeSample({ v: 1 }),
      edgeEnd: makeSample({ v: 5 }),
    });
    renderer.renderSingleEdgeInset([edgeSample]);

    const scale = renderer.getTransform().scale;
    expect(renderer.getBoundingBox().width).toBeCloseTo(tabularInsetBaseWidthPx(1) * scale);
  });

  it("keeps the abstract edge placeholder when sides are missing", () => {
    const renderer = new DefaultDatasetRenderer();
    renderer.renderSingleEdgeInset([makeSample({ v: 1 })]);

    const scale = renderer.getTransform().scale;
    expect(renderer.getVisualBoundingBox().width).toBeCloseTo(
      ABSTRACT_INSET_BASE_WIDTH_PX * scale
    );
  });
});
