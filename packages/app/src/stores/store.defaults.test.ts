/**
 * Tests for store initial-state defaults (issue #172 – side panel chrome cleanup).
 *
 * Verifies that sidePanelBgColor was updated to white (#ffffff) as part of the
 * chrome cleanup, replacing the old blue-tinted default (#f6f8fb).
 */
import { describe, expect, it } from '@jest/globals';
import { initialClusterSettings, initialVisualizationSettings } from '../store';

describe('initialVisualizationSettings defaults', () => {
  it('sidePanelBgColor defaults to #ffffff (pure white)', () => {
    expect(initialVisualizationSettings.sidePanelBgColor).toBe('#ffffff');
  });

  it('sidePanelBgColor is NOT the old blue-tinted default (#f6f8fb)', () => {
    expect(initialVisualizationSettings.sidePanelBgColor).not.toBe('#f6f8fb');
  });

  it('canvasBgColor still defaults to #ffffff', () => {
    // Ensure we did not accidentally change canvasBgColor.
    expect(initialVisualizationSettings.canvasBgColor).toBe('#ffffff');
  });
});

describe('initialClusterSettings defaults', () => {
  it('insetHoverScale defaults to 1.5', () => {
    expect(initialClusterSettings.insetHoverScale).toBe(1.5);
  });

  // Issue #261 part 3: the cluster budget is a true total cap.
  it('maxActiveClusters defaults to 12 (absorbs the former additive chain slots)', () => {
    expect(initialClusterSettings.maxActiveClusters).toBe(12);
  });

  // Issue #261 part 4: the edge-inset budget replaced the visibility toggle;
  // 0 = edge insets hidden (the old default-off behavior).
  it('relationInsetBudget defaults to 0 (edge insets hidden)', () => {
    expect(initialClusterSettings.relationInsetBudget).toBe(0);
  });
});
