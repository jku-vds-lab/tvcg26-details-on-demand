/**
 * ActiveClusterReadout.test.tsx — the live status line must report the
 * active clusters against the cluster-budget cap and break out the
 * chain-rescue share (issue #261).
 */
import { describe, expect, it } from '@jest/globals';
import { act, render } from '@testing-library/react';
import { Provider } from 'react-redux';
import store, {
  initialClusterSettings,
  setActiveClusterStats,
  updateClusterSettings,
} from 'src/store';
import ActiveClusterReadout from './ActiveClusterReadout';

function renderWithStats(base: number, chain: number) {
  // Reset settings so tests are order-independent (default budget 12).
  store.dispatch(updateClusterSettings({ ...initialClusterSettings }));
  store.dispatch(setActiveClusterStats({ base, chain }));
  return render(
    <Provider store={store}>
      <ActiveClusterReadout />
    </Provider>,
  );
}

describe('ActiveClusterReadout', () => {
  it('shows the base + chain breakdown against the budget when the reserve contributed', () => {
    const { container } = renderWithStats(2, 3);
    expect(container.textContent).toBe('Showing 5 of 12 clusters (2 base + 3 chain)');
  });

  it('omits the breakdown when no clusters are chain-rescued', () => {
    const { container } = renderWithStats(4, 0);
    expect(container.textContent).toBe('Showing 4 of 12 clusters');
  });

  it('updates live when the stats change', () => {
    const { container } = renderWithStats(2, 0);
    act(() => {
      store.dispatch(setActiveClusterStats({ base: 3, chain: 2 }));
    });
    expect(container.textContent).toBe('Showing 5 of 12 clusters (3 base + 2 chain)');
  });

  it('updates live when the budget changes', () => {
    const { container } = renderWithStats(4, 0);
    act(() => {
      store.dispatch(updateClusterSettings({ maxActiveClusters: 6 }));
    });
    expect(container.textContent).toBe('Showing 4 of 6 clusters');
  });
});
