import { describe, expect, it } from '@jest/globals';
import { ChessDatasetRenderer } from './ChessDatasetRenderer';
import type { DataPoint } from 'src/dataPreprocessing/dataPreprocessing';
import store, { updateSettings } from 'src/store';

const makeSample = (): DataPoint => ({
  x: 0,
  y: 0,
  line: 0,
  algo: 'test',
  id: 0,
  action: 'none',
  DoI: 1,
  nextEdgeCenter: { x: 0, y: 0 },
});

describe('computeInsetBoundingBox', () => {
  it('scales chess board by scaleFactor', () => {
    const renderer = new ChessDatasetRenderer();
    const bbox = renderer.computeInsetBoundingBox({
      mode: 'chess',
      tileSize: 20,
      fineTuneScale: 0.5,
      scaleFactor: 1.5,
    });
    expect(bbox.width).toBeCloseTo(120);
    expect(bbox.height).toBeCloseTo(120);
    // board starts at origin (minX=0), so maxX = minX + width
    expect(bbox.maxX).toBeCloseTo(120);
    expect(bbox.maxY).toBeCloseTo(120);
  });
});

describe('renderSingleNodeInset', () => {
  it('wraps inset with bounding box using computed size', () => {
    const renderer = new ChessDatasetRenderer();
    const element = renderer.renderSingleNodeInset([makeSample()]);
    const bbox = renderer.getBoundingBox();

    // Since round 2, getBoundingBox() returns the union of the raw inset area
    // AND the overlay-label area above it, so the layout engine reserves space
    // for the label.  The raw chess board at scale 1 is 80×80; adding the label
    // height (≈ 18 * 1.1 ≈ 19.8) and gap (6) makes the stored bbox taller.
    expect(bbox.width).toBeCloseTo(80); // width unchanged (board ≥ empty-string label)
    expect(bbox.height).toBeGreaterThan(80); // union includes label area above board

    // The wrapper div keeps the raw inset dimensions so the board renders
    // at its intended size; only the stored (annealer) bbox grows.
    const style = (element.props as { style: { width: number; height: number } }).style;
    expect(style.width).toBeCloseTo(80);
    expect(style.height).toBeCloseTo(80);
  });

  it('keeps the board-only visual bbox for leader-line clipping', () => {
    const renderer = new ChessDatasetRenderer();
    renderer.renderSingleNodeInset([makeSample()]);

    const visual = renderer.getVisualBoundingBox();
    expect(visual.width).toBeCloseTo(80);
    expect(visual.height).toBeCloseTo(80);
    // layout bbox (annealer) still reserves the label region above the board
    expect(renderer.getBoundingBox().height).toBeGreaterThan(visual.height);
  });

  it('suppresses meaningless numeric labels: bbox stays board-only (issue: "0" on chess40k insets)', () => {
    const renderer = new ChessDatasetRenderer();
    const sample = { ...makeSample(), algo: 0 as unknown as string }; // chess40k algo is a numeric code
    renderer.renderSingleNodeInset([sample]);

    const bbox = renderer.getBoundingBox();
    expect(bbox.width).toBeCloseTo(80);
    expect(bbox.height).toBeCloseTo(80); // no label union
  });

  it('setBoundingBox clears a previous visual override (falls back to layout bbox)', () => {
    const renderer = new ChessDatasetRenderer();
    renderer.renderSingleNodeInset([makeSample()]); // establishes visual override
    const box = { x: 0, y: 0, width: 10, height: 10, minX: 0, minY: 0, maxX: 10, maxY: 10 };
    renderer.setBoundingBox(box);
    expect(renderer.getVisualBoundingBox()).toEqual(box);
  });
});

describe('edge inset scaling', () => {
  it('edge board uses EDGE_BOARD_FINE_TUNE (0.6): 96px at scale 1', () => {
    const renderer = new ChessDatasetRenderer();
    renderer.renderSingleEdgeInset([makeSample()]);
    // 8 tiles × 20 × 0.6 = 96 (node boards stay at 0.5 → 80)
    expect(renderer.getVisualBoundingBox().width).toBeCloseTo(96);
  });

  it('scales with edge inset min/max + exponent', () => {
    const renderer1 = new ChessDatasetRenderer();
    const sample = makeSample();
    renderer1.renderSingleEdgeInset([sample]);
    const baseWidth = renderer1.getBoundingBox().width;
    // Force the lower clamp to 2× so single-sample clusters visibly grow
    store.dispatch(updateSettings({ edgeInsetMinScale: 2, edgeInsetMaxScale: 3, edgeScaleExponent: 1 }));
    const renderer2 = new ChessDatasetRenderer();
    renderer2.renderSingleEdgeInset([sample]);
    const scaledWidth = renderer2.getBoundingBox().width;
    expect(scaledWidth).toBeCloseTo(baseWidth * 2);
    store.dispatch(updateSettings({ edgeInsetMinScale: 1, edgeInsetMaxScale: 2, edgeScaleExponent: 1 }));
  });
});
