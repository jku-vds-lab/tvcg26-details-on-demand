/**
 * Reprojection gate on server-resident datasets (issue #315 R1a, CS decision
 * 2026-08-02, §8.2 option b). The projection is computed from the rows' own
 * `features`/`pixels`; a server dataset ships only the columns the client
 * needs, so on a slim one a run would quietly use fewer columns than the
 * picker lists. The Run button is therefore blocked with a stated reason —
 * and stays live on locally loaded datasets.
 */

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { DataProvider, useDataRef } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { FeatureStats } from "src/slices/datasetFeatures";
import store, { setFeatureMetadata } from "src/store";

const mockResolveCutProvider = jest.fn<() => unknown>(() => null);
jest.mock("@scaling", () => ({
  resolveCutProvider: () => mockResolveCutProvider(),
  resolveInsetProvider: () => null,
  resolveTileSource: () => null,
  resolveAggregateSource: () => null,
  hasLiveCutSubscription: () => false,
}));

jest.mock("../../workers/umapWorkerProxy", () => ({
  umapWorkerProxy: { run: jest.fn(), cancel: jest.fn() },
}));

// Imported after the mocks so the component picks them up.
import ProjectionTabPanel from "./ProjectionTabPanel";

const mkStats = (key: string): FeatureStats => ({
  key,
  variableType: "sequential",
  uniqueCount: 10,
  totalCount: 10,
  numericRatio: 1,
  confidence: "high",
});

const NODES = [1, 2, 3].map(
  (id) =>
    ({
      x: id, y: id, line: 0, algo: "a", id, action: "left", DoI: 1,
      nextEdgeCenter: { x: 0, y: 0 }, reward: id / 10, speed: id * 10,
    }) as unknown as DataPoint
);

const SeedNodes = ({ children }: { children: ReactNode }) => {
  const dataRef = useDataRef();
  dataRef.current = NODES;
  return <>{children}</>;
};

const renderPanel = () =>
  render(
    <Provider store={store}>
      <DataProvider>
        <SeedNodes>
          <ProjectionTabPanel
            applyProjection={jest.fn()}
            restoreOriginalProjection={jest.fn()}
            canRestoreProjection={false}
          />
        </SeedNodes>
      </DataProvider>
    </Provider>
  );

const runButton = () => screen.getByRole("button", { name: /run projection/i }) as HTMLButtonElement;

beforeEach(() => {
  mockResolveCutProvider.mockReset();
  mockResolveCutProvider.mockReturnValue(null);
  store.dispatch(
    setFeatureMetadata({
      availableKeys: ["reward", "speed"],
      statsByKey: { reward: mkStats("reward"), speed: mkStats("speed") },
    })
  );
});

describe("ProjectionTabPanel server-dataset gate", () => {
  it("keeps Run enabled on a locally loaded dataset", () => {
    renderPanel();
    expect(runButton().disabled).toBe(false);
  });

  it("blocks Run, with a reason, when a cut provider owns the dataset", async () => {
    mockResolveCutProvider.mockReturnValue({ getLeafOrder: jest.fn() });
    renderPanel();

    expect(runButton().disabled).toBe(true);

    // The reason reaches the user: the wrapper span keeps the disabled button
    // hoverable, so the tooltip explains why rather than leaving a dead button.
    fireEvent.mouseOver(runButton().parentElement!);
    expect(await screen.findByText(/features live on the server/i)).toBeTruthy();
  });
});
