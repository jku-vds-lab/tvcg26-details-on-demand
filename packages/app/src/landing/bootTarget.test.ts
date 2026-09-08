import { makeBootTargetChangeHandler, resolveBootTarget } from "./bootTarget";

describe("resolveBootTarget", () => {
  it.each([
    ["", "app"],
    ["#", "app"],
    ["#v=1&ds=mnist&demo=1", "app"],
    ["#/", "landing"],
    ["#/figures", "landing"],
  ] as const)("maps %j to %s", (hash, target) => {
    expect(resolveBootTarget(hash)).toBe(target);
  });
});

describe("makeBootTargetChangeHandler", () => {
  it("reloads when the target flips from landing to app", () => {
    const reload = jest.fn();
    const handler = makeBootTargetChangeHandler("#/", reload);
    handler("#v=1&ds=mnist&demo=1");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads when the target flips from app to landing", () => {
    const reload = jest.fn();
    const handler = makeBootTargetChangeHandler("", reload);
    handler("#/");
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload on app-internal hash changes", () => {
    const reload = jest.fn();
    const handler = makeBootTargetChangeHandler("#v=1&ds=mnist", reload);
    handler("#v=1&ds=fashion&demo=1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not reload on landing-internal hash changes", () => {
    const reload = jest.fn();
    const handler = makeBootTargetChangeHandler("#/", reload);
    handler("#/figures");
    expect(reload).not.toHaveBeenCalled();
  });
});
