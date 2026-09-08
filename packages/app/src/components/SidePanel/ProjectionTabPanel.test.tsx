import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { Provider } from "react-redux";
import { DataProvider, useDataRef } from "src/contexts/DataContext";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import type { FeatureStats } from "src/slices/datasetFeatures";
import { setFeatureMetadata } from "src/store";
import store from "src/store";
import type { KnnGraph } from "src/types/graphTypes";

const mockRun = jest.fn<
  (...args: unknown[]) => Promise<{ coords: Float32Array; knnGraph: KnnGraph }>
>();
const mockCancel = jest.fn();

jest.mock("../../workers/umapWorkerProxy", () => ({
  umapWorkerProxy: {
    run: (...args: unknown[]) => mockRun(...args),
    cancel: (...args: unknown[]) => mockCancel(...args),
  },
}));

// Imported after the mock so the component picks up the mocked proxy.
import ProjectionTabPanel from "./ProjectionTabPanel";

const mkStats = (key: string, partial: Partial<FeatureStats>): FeatureStats => ({
  key,
  variableType: "sequential",
  uniqueCount: 10,
  totalCount: 10,
  numericRatio: 1,
  confidence: "high",
  ...partial,
});

const mkPoint = (id: number, reward: number, speed: number): DataPoint =>
  ({
    x: id,
    y: id,
    line: 0,
    algo: "a",
    id,
    action: "left",
    DoI: 1,
    nextEdgeCenter: { x: 0, y: 0 },
    reward,
    speed,
  } as unknown as DataPoint);

const NODES = [mkPoint(1, 0.5, 10), mkPoint(2, 0.7, 20), mkPoint(3, 0.1, 30)];

const SeedNodes = ({ children }: { children: ReactNode }) => {
  const dataRef = useDataRef();
  dataRef.current = NODES;
  return <>{children}</>;
};

const renderPanel = (props?: Partial<Parameters<typeof ProjectionTabPanel>[0]>) => {
  const applyProjection = jest.fn();
  const restoreOriginalProjection = jest.fn();
  const utils = render(
    <Provider store={store}>
      <DataProvider>
        <SeedNodes>
          <ProjectionTabPanel
            applyProjection={applyProjection}
            restoreOriginalProjection={restoreOriginalProjection}
            canRestoreProjection={false}
            {...props}
          />
        </SeedNodes>
      </DataProvider>
    </Provider>
  );
  return { applyProjection, restoreOriginalProjection, ...utils };
};

describe("ProjectionTabPanel", () => {
  beforeEach(() => {
    mockRun.mockReset();
    mockCancel.mockReset();
    store.dispatch(
      setFeatureMetadata({
        availableKeys: ["reward", "speed", "action", "id", "line", "doiGroup", "selected"],
        statsByKey: {
          reward: mkStats("reward", {}),
          speed: mkStats("speed", {}),
          // Categorical string feature: projectable via one-hot encoding.
          action: mkStats("action", { variableType: "categorical", numericRatio: 0 }),
          // Identifier-ish numeric keys: projectable, but deselected by default.
          id: mkStats("id", {}),
          line: mkStats("line", {}),
          // Interaction/render state: never offered.
          doiGroup: mkStats("doiGroup", { variableType: "categorical", numericRatio: 0 }),
          selected: mkStats("selected", { variableType: "boolean", numericRatio: 0 }),
        },
      })
    );
  });

  it("offers every scanned feature, defaults to data features only, and shows a summary instead of chips", () => {
    renderPanel();

    // Summary placeholder, no chips: 2 data features (reward, speed) of 5
    // options (id/line metadata and the generic action column deselected).
    expect(screen.getByPlaceholderText("2 of 5 selected")).toBeTruthy();
    expect(document.querySelector(".MuiChip-root")).toBeNull();

    // The option list contains id/line/action (selectable, unticked) and the
    // data features (ticked); interaction state (doiGroup/selected) is never offered.
    const input = screen.getByRole("combobox", { name: /features to project/i });
    fireEvent.mouseDown(input);
    const listbox = screen.getByRole("listbox");
    const optionState = (label: string) => {
      const option = within(listbox).getByText(label).closest("li")!;
      return (within(option as HTMLElement).getByRole("checkbox") as HTMLInputElement).checked;
    };
    expect(optionState("reward")).toBe(true);
    expect(optionState("speed")).toBe(true);
    expect(optionState("action")).toBe(false);
    expect(optionState("id")).toBe(false);
    expect(optionState("line")).toBe(false);
    expect(within(listbox).queryByText("doiGroup")).toBeNull();
    expect(within(listbox).queryByText("selected")).toBeNull();
  });

  it("supports All / None quick selection", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByPlaceholderText("0 of 5 selected")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /run projection/i }) as HTMLButtonElement).disabled
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByPlaceholderText("5 of 5 selected")).toBeTruthy();
  });

  it("runs UMAP via the worker proxy and applies the result", async () => {
    const coords = new Float32Array([1, 2, 3, 4, 5, 6]);
    const knnGraph: KnnGraph = [[0], [1], [2]];
    mockRun.mockResolvedValue({ coords, knnGraph });

    const { applyProjection } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /run projection/i }));

    await waitFor(() => expect(applyProjection).toHaveBeenCalledWith(coords, knnGraph));

    // Matrix dimensions: 3 points × 2 default features (reward, speed;
    // the generic action column is deselected by default).
    const [, nRows, nCols] = mockRun.mock.calls[0] as [Float32Array, number, number];
    expect(nRows).toBe(3);
    expect(nCols).toBe(2);
  });

  it("shows Cancel while running and forwards it to the proxy", async () => {
    mockRun.mockReturnValue(new Promise(() => {})); // never settles
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /run projection/i }));
    const cancelButton = await screen.findByRole("button", { name: /cancel/i });
    fireEvent.click(cancelButton);
    expect(mockCancel).toHaveBeenCalled();
  });

  it("disables Restore until a projection was applied", () => {
    const { restoreOriginalProjection, rerender, applyProjection } = renderPanel();
    const restore = screen.getByRole("button", { name: /restore original/i });
    expect(restore).toHaveProperty("disabled", true);

    rerender(
      <Provider store={store}>
        <DataProvider>
          <SeedNodes>
            <ProjectionTabPanel
              applyProjection={applyProjection as never}
              restoreOriginalProjection={restoreOriginalProjection as never}
              canRestoreProjection={true}
            />
          </SeedNodes>
        </DataProvider>
      </Provider>
    );
    const restoreEnabled = screen.getByRole("button", { name: /restore original/i });
    expect(restoreEnabled).toHaveProperty("disabled", false);
    fireEvent.click(restoreEnabled);
    expect(restoreOriginalProjection).toHaveBeenCalled();
  });
});
