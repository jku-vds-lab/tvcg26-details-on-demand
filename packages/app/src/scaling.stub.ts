// src/scaling.stub.ts
//
// OPEN-CORE stub for the `@scaling` seam: this build ships no backend
// providers. Every export here mirrors the seam's surface but does nothing —
// no backend is ever resolved, so consumers fall back to the existing
// fully-client-side inset path and the app behaves byte-identically to
// before this seam existed.

import type {
  ResolveAggregateSource,
  ResolveColumnsProvider,
  ResolveCutProvider,
  ResolveInsetProvider,
  ResolveKnownLocalBackend,
  ResolveTileSource,
  SetActiveBackend,
} from "./scaling.types";

export type {
  AggregateMeta,
  AggregateTile,
  AggregateTileSource,
  BackendManifest,
  InsetContentProvider,
  InsetRequestOptions,
  InsetResponse,
  LeafRangeRef,
  MemberRef,
  ScatterTileSource,
  TileMeta,
} from "./scaling.types";
export { leafRangeOf, memberRefKey, toMemberRef } from "./scaling.types";

/** Always `null`: the open-core build draws its resident geometry. */
export const resolveTileSource: ResolveTileSource = async () => null;

/** Always `null`: the open-core build never renders server aggregates. */
export const resolveAggregateSource: ResolveAggregateSource = async () => null;

/** No-op: the open-core build has no backend. */
export const setActiveBackend: SetActiveBackend = () => {
  /* no backend in the open-core build */
};

/** Always `null`: the open-core build uses the client-side inset path. */
export const resolveInsetProvider: ResolveInsetProvider = () => null;

/** Always `null`: the open-core build never attaches local inset services. */
export const resolveKnownLocalBackend: ResolveKnownLocalBackend = async () => null;

/** Always `null`: the open-core build walks its shipped trees client-side. */
export const resolveCutProvider: ResolveCutProvider = () => null;

/** Always `null`: open-core manifests ship every column in `columns.bin`. */
export const resolveColumnsProvider: ResolveColumnsProvider = () => null;

export const hasLiveCutSubscription = (): boolean => false;

export const warmBootCut = (..._args: unknown[]): (() => void) => () => {};

/** False: the open-core build cannot serve backend-requiring datasets —
 * the catalog locks their entries (see isDatasetEntryLocked). */
export const scalingBuildHasBackends = false;
