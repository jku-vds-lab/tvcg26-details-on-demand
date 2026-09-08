/**
 * SemanticZoomSection.test.tsx — smoke test for the issue-#261 restructure:
 * renamed labels present, selection-only subgroup announced, and the
 * advanced ranking/hysteresis controls tucked into a collapsed sub-accordion.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { render } from '@testing-library/react';
import { initialClusterSettings } from 'src/store';
import SemanticZoomSection from './SemanticZoomSection';

function renderSection() {
  const handler = jest.fn(() => jest.fn());
  return render(
    <SemanticZoomSection
      cluster={initialClusterSettings}
      onClusterChange={handler as never}
    />,
  );
}

describe('SemanticZoomSection (issue #261 restructure)', () => {
  it('renders the renamed always-active controls', () => {
    const { container } = renderSection();
    expect(container.textContent).toContain('Base split size (% of view)');
    expect(container.textContent).toContain('Min annotation size (× base)');
    // The misleading old labels are gone.
    expect(container.textContent).not.toContain('Split threshold');
    expect(container.textContent).not.toContain('% viewport');
  });

  it('announces the selection-only subgroup with its chain controls', () => {
    const { container } = renderSection();
    expect(container.textContent).toContain('Focus & chains — selection only');
    expect(container.textContent).toContain('Gap disclosure (px)');
    expect(container.textContent).toContain('Chain rescue DoI threshold');
    expect(container.textContent).toContain('Chain slots (reserved)');
    expect(container.textContent).toContain('DoI density weight');
  });

  it('keeps ranking weights and hysteresis inside a collapsed Advanced accordion', () => {
    const { container, getByText } = renderSection();

    // The advanced controls exist (MUI keeps collapsed content mounted)…
    expect(container.textContent).toContain('Stability weight');
    expect(container.textContent).toContain('Hysteresis activate (×)');

    // …but their accordion starts collapsed (MUI AccordionSummary is a <button>).
    const summary = getByText('Advanced ranking & hysteresis').closest('button');
    expect(summary).not.toBeNull();
    expect(summary!.getAttribute('aria-expanded')).toBe('false');
  });
});
