import { describe, expect, it } from "@jest/globals";
import reducer, {
    addFreehandInset,
    replaceFreehandInsets,
    setFreehandMode,
    setShowAutoInsets,
    type FreehandState,
} from "./freehandSlice";

const initial = (): FreehandState =>
  reducer(undefined, { type: "@@INIT" });

describe("freehandSlice", () => {
  it("plain lasso replaces all freehand insets with exactly one", () => {
    let state = initial();
    state = reducer(state, replaceFreehandInsets([1, 2, 3]));
    state = reducer(state, replaceFreehandInsets([4, 5]));
    expect(state.insets).toHaveLength(1);
    expect(state.insets[0].memberIds).toEqual([4, 5]);
  });

  it("Ctrl+lasso adds a separate inset per lasso (no union)", () => {
    let state = initial();
    state = reducer(state, replaceFreehandInsets([1, 2]));
    state = reducer(state, addFreehandInset([3, 4]));
    expect(state.insets).toHaveLength(2);
    expect(state.insets[0].memberIds).toEqual([1, 2]);
    expect(state.insets[1].memberIds).toEqual([3, 4]);
    expect(state.insets[0].id).not.toBe(state.insets[1].id);
  });

  it("an empty plain lasso clears freehand insets", () => {
    let state = initial();
    state = reducer(state, replaceFreehandInsets([1]));
    state = reducer(state, replaceFreehandInsets([]));
    expect(state.insets).toHaveLength(0);
  });

  it("an empty Ctrl lasso is a no-op", () => {
    let state = initial();
    state = reducer(state, replaceFreehandInsets([1]));
    state = reducer(state, addFreehandInset([]));
    expect(state.insets).toHaveLength(1);
  });

  it("never reuses inset ids after a replace", () => {
    let state = initial();
    state = reducer(state, replaceFreehandInsets([1]));
    const firstId = state.insets[0].id;
    state = reducer(state, replaceFreehandInsets([2]));
    expect(state.insets[0].id).not.toBe(firstId);
  });

  it("leaving freehand mode clears insets; entering does not", () => {
    let state = initial();
    state = reducer(state, setFreehandMode(true));
    state = reducer(state, replaceFreehandInsets([1, 2]));
    state = reducer(state, setFreehandMode(false));
    expect(state.isFreehandMode).toBe(false);
    expect(state.insets).toHaveLength(0);

    state = reducer(state, setFreehandMode(true));
    expect(state.insets).toHaveLength(0);
  });

  it("dataset switch clears insets but keeps mode and visibility toggles", () => {
    let state = initial();
    state = reducer(state, setFreehandMode(true));
    state = reducer(state, setShowAutoInsets(false));
    state = reducer(state, replaceFreehandInsets([1, 2]));
    state = reducer(state, {
      type: "dataset/setDatasetMetadata",
      payload: { datasetType: "chess", datasetPath: "x" },
    });
    expect(state.insets).toHaveLength(0);
    expect(state.isFreehandMode).toBe(true);
    expect(state.showAutoInsets).toBe(false);
  });
});
