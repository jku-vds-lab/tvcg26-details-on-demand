// packages/app/src/clustering/groupClusterUid.ts
//
// Cluster identity WITHOUT per-point cluster ids (issue #315 R1a step 5,
// census item A11; CS decision 2026-08-02).
//
// The server lane used to stamp `annotationClusterId` / `insetClusterId` onto
// every winner member at each apply — ~2M property writes at boot, where the
// winners span the whole dataset — purely so three UI readers could ask a
// sample point "which cluster are you in?". The uid is already known where the
// member array is BUILT (cutDrivenGroups keys the groups map by it), so it is
// registered here instead: keyed by the member array's identity, which
// reconcile keeps stable (the same identity the label cache already keys on).
//
// Dependency-free by design — the inset renderers import it, and their module
// graph must not gain the clustering service or the server transport.

import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";

const uidByMembers = new WeakMap<readonly DataPoint[], string>();
/** Latest member array per uid. Overwritten on every rebuild; entries for
 * clusters that stopped being active linger until the next dataset switch,
 * which is harmless — every lookup comes from a currently drawn cluster. */
const membersByUid = new Map<string, readonly DataPoint[]>();

/** Record that `members` are exactly the points of cluster `uid`. */
export function registerGroupClusterUid(members: readonly DataPoint[], uid: string): void {
  uidByMembers.set(members, uid);
  membersByUid.set(uid, members);
}

/** The cluster uid of a member array built by the cut-driven group builder;
 * undefined for legacy groupBy arrays (client lane), whose callers fall back
 * to the per-point cluster-id fields. */
export function groupClusterUidOf(members: readonly DataPoint[]): string | undefined {
  return uidByMembers.get(members);
}

/** The members of cluster `uid` as last built, or undefined when no
 * cut-driven group was registered for it. */
export function groupMembersOfClusterUid(uid: string): readonly DataPoint[] | undefined {
  return membersByUid.get(uid);
}

/** Drop the uid → members index (dataset switch). The WeakMap needs no reset. */
export function resetGroupClusterUids(): void {
  membersByUid.clear();
}
