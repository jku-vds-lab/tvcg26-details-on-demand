/**
 * The two-chip taxonomy (issue #315 P7 amendment A5): every chip is set at
 * cause time and cleared at effect time, with NO timer between the two. This
 * suite pins the `doi` chip — the one `pipelineChips.ts` owns — plus the
 * property the missing timer rests on: a cause and its effect landing in the
 * same tick are batched by React 18, so the dock never paints.
 * (The `refining` chip lives in hdbscanClustering.ts; see
 * hdbscanClustering.progressive.test.ts.)
 */

import { beforeEach, describe, expect, it } from "@jest/globals";
import { act, render, screen } from "@testing-library/react";
import { Provider } from "react-redux";
import GlobalProgressDock from "../components/GlobalProgressDock";
import store from "../store";
import { progressResetAll } from "../slices/progressSlice";
import { beginDoiChip, endDoiChip } from "./pipelineChips";

const phases = () =>
  Object.values(store.getState().progress.tasks).map((t) => t.phase);

beforeEach(() => {
  store.dispatch(progressResetAll());
});

describe("doi chip", () => {
  it("carries no timer guard: it is visible in the tick it was set", () => {
    beginDoiChip();
    const task = Object.values(store.getState().progress.tasks)[0];
    expect(task.minShowMs).toBeUndefined();
    expect(task.visible).toBe(true);
    endDoiChip(); // balance the depth: it is module state shared across tests
  });

  it("is set at propagate dispatch and cleared when the overlay applies", () => {
    beginDoiChip();
    expect(phases()).toEqual(["Updating interest…"]);
    endDoiChip();
    expect(phases()).toEqual([]);
  });

  it("folds a nested re-seed into ONE pending state", () => {
    beginDoiChip(); // slider commit
    beginDoiChip(); // 409 re-seed through the selection path
    expect(phases()).toEqual(["Updating interest…"]);
    endDoiChip();
    expect(phases()).toEqual(["Updating interest…"]);
    endDoiChip();
    expect(phases()).toEqual([]);
  });

  it("an unbalanced clear cannot drive the depth negative", () => {
    endDoiChip();
    beginDoiChip();
    expect(phases()).toEqual(["Updating interest…"]);
    endDoiChip();
    expect(phases()).toEqual([]);
  });
});

describe("no flash on a synchronous apply (the missing timer)", () => {
  it("never paints a chip whose cause and effect land in one tick", () => {
    render(
      <Provider store={store}>
        <GlobalProgressDock />
      </Provider>
    );
    expect(screen.queryByText("Updating interest…")).toBeNull();

    // A propagate that routes straight back to the local path: React batches
    // set+clear.
    act(() => {
      beginDoiChip();
      endDoiChip();
    });
    expect(screen.queryByText("Updating interest…")).toBeNull();

    // Contrast: a genuinely pending propagate DOES paint, within the same tick
    // as its cause (no minShowMs delay before it becomes visible).
    act(() => {
      beginDoiChip();
    });
    expect(screen.getByText("Updating interest…")).toBeTruthy();

    act(() => {
      endDoiChip();
    });
    expect(screen.queryByText("Updating interest…")).toBeNull();
  });
});
