// src/hooks/useRelationInsetMidpoints.ts
import { useEffect, useRef } from "react";
import {
  applyPartial as layoutApplyPartial,
  getSnapshot as layoutGet,
  subscribe as layoutSubscribe,
  type Pos,
} from "src/layout/layoutStore";
import type { VisualElement } from "src/models/VisualElement";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export interface MidpointRelation {
  insetId: string;
  nodeIdA: string;
  nodeIdB: string;
}

/**
 * Pure: for each relation whose two node positions are present in `positions`,
 * compute the midpoint and return it as a patch.  Relations where either node is
 * unresolved are skipped (inset stays wherever it was seeded).  Relations where
 * the inset is already at the exact midpoint are omitted (idempotent — the
 * layoutStore's `same()` guard would catch this too, but we skip them early to
 * avoid allocating Map entries on every quiet frame).
 */
export function computeMidpointPatch(
  relations: MidpointRelation[],
  positions: Map<string, Pos>
): Map<string, Pos> {
  const patch = new Map<string, Pos>();
  for (const { insetId, nodeIdA, nodeIdB } of relations) {
    const a = positions.get(nodeIdA);
    const b = positions.get(nodeIdB);
    if (!a || !b) continue; // node not placed yet → leave inset alone
    const mid: Pos = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const cur = positions.get(insetId);
    if (cur && cur.x === mid.x && cur.y === mid.y) continue; // already there
    patch.set(insetId, mid);
  }
  return patch;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Pins each floating relation inset to the midpoint of its two node insets'
 * placed (annealed) positions, writing directly into the layoutStore.
 *
 * Uses an imperative layoutStore subscription (not useLayout()) so that
 * ClusterVisualizations does NOT re-render on every annealing step.
 * The subscription fires the midpoint patch synchronously after each position
 * update; it self-terminates once node insets settle (patch returns empty).
 */
export function useRelationInsetMidpoints(
  floatingItems: { element: VisualElement }[],
  nodeElementMap: Map<string, VisualElement>
): void {
  // Ref holds the current relations list so the layout subscription can read
  // it without being re-created every time floatingItems/nodeElementMap change.
  const relationsRef = useRef<MidpointRelation[]>([]);

  // Rebuild relations list and apply immediately when data changes.
  useEffect(() => {
    const relations: MidpointRelation[] = [];
    for (const { element } of floatingItems) {
      const anchors = element.relationAnchors;
      if (!anchors) continue;
      const ea = nodeElementMap.get(anchors.uidA);
      const eb = nodeElementMap.get(anchors.uidB);
      if (!ea || !eb) continue;
      relations.push({ insetId: element.id, nodeIdA: ea.id, nodeIdB: eb.id });
    }
    relationsRef.current = relations;

    const { positions } = layoutGet();
    const patch = computeMidpointPatch(relations, positions);
    if (patch.size) layoutApplyPartial(patch);
  }, [floatingItems, nodeElementMap]);

  // React to each layout position change imperatively — no React re-render on the parent.
  // Self-terminating: once node insets settle, computeMidpointPatch returns an empty map.
  useEffect(() => {
    return layoutSubscribe(() => {
      const { positions } = layoutGet();
      const patch = computeMidpointPatch(relationsRef.current, positions);
      if (patch.size) layoutApplyPartial(patch);
    });
  }, []);
}
