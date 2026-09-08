/**
 * hooks/useRelationHover.test.tsx
 *
 * Issue #264 regression: the D2 diff-hover spotlight must clear BOTH channels
 * (spotlightUids for JSX dimming, the WebGL tween via spotlight(null)) when the
 * hovered relation inset unmounts without ever firing a mouse-out (budget
 * re-selection, cut change, anchor deactivation).
 */

import { describe, expect, it, jest } from "@jest/globals";
import { act, renderHook } from "@testing-library/react";
import type { ClusterItem } from "./reconcileClusterItems";
import { useRelationHover } from "./useRelationHover";

function mkItem(id: string, uidA: string, uidB: string): ClusterItem {
  return {
    element: { id, relationAnchors: { uidA, uidB } },
    hull: null,
  } as unknown as ClusterItem;
}

function setup(initialIds: ReadonlySet<string>) {
  const spotlight = jest.fn<(item: ClusterItem | null) => void>();
  const rendered = renderHook(
    ({ ids }: { ids: ReadonlySet<string> }) => useRelationHover(spotlight, ids),
    { initialProps: { ids: initialIds } }
  );
  return { spotlight, ...rendered };
}

describe("useRelationHover", () => {
  it("does not fire the spotlight on initial mount", () => {
    const { spotlight, result } = setup(new Set(["r1"]));
    expect(spotlight).not.toHaveBeenCalled();
    expect(result.current.spotlightUids).toBeNull();
    expect(result.current.hoveredRelationItem).toBeNull();
  });

  it("sets both channels and fires the spotlight tween on hover", () => {
    const { spotlight, result } = setup(new Set(["r1"]));
    const item = mkItem("r1", "uidA", "uidB");

    act(() => result.current.onHoverRelation(item));

    expect(result.current.hoveredRelationItem).toBe(item);
    expect(result.current.spotlightUids).toEqual(new Set(["uidA", "uidB"]));
    expect(spotlight).toHaveBeenCalledTimes(1);
    expect(spotlight).toHaveBeenLastCalledWith(item);
  });

  it("clears both channels on normal mouse-out", () => {
    const { spotlight, result } = setup(new Set(["r1"]));
    const item = mkItem("r1", "uidA", "uidB");

    act(() => result.current.onHoverRelation(item));
    act(() => result.current.onHoverRelation(null));

    expect(result.current.hoveredRelationItem).toBeNull();
    expect(result.current.spotlightUids).toBeNull();
    expect(spotlight).toHaveBeenLastCalledWith(null);
  });

  it("resets both channels when the hovered inset leaves the rendered set (#264)", () => {
    const { spotlight, result, rerender } = setup(new Set(["r1", "r2"]));
    const item = mkItem("r1", "uidA", "uidB");

    act(() => result.current.onHoverRelation(item));
    expect(spotlight).toHaveBeenLastCalledWith(item);

    // The hovered inset unmounts (e.g. budget drop): no mouse-out ever fires.
    act(() => rerender({ ids: new Set(["r2"]) }));

    expect(result.current.hoveredRelationItem).toBeNull();
    expect(result.current.spotlightUids).toBeNull();
    // The WebGL tween must be restored too — both channels un-dim together.
    expect(spotlight).toHaveBeenLastCalledWith(null);
    expect(spotlight).toHaveBeenCalledTimes(2);
  });

  it("keeps the hover when the rendered set changes but still contains the inset", () => {
    const { spotlight, result, rerender } = setup(new Set(["r1", "r2"]));
    const item = mkItem("r1", "uidA", "uidB");

    act(() => result.current.onHoverRelation(item));
    act(() => rerender({ ids: new Set(["r1"]) }));

    expect(result.current.hoveredRelationItem).toBe(item);
    expect(result.current.spotlightUids).toEqual(new Set(["uidA", "uidB"]));
    expect(spotlight).toHaveBeenCalledTimes(1); // no spurious restore tween
  });

  it("does not fire a spurious restore when the set shrinks with nothing hovered", () => {
    const { spotlight, rerender } = setup(new Set(["r1", "r2"]));
    act(() => rerender({ ids: new Set<string>() }));
    expect(spotlight).not.toHaveBeenCalled();
  });
});
