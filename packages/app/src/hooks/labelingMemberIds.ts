// packages/app/src/hooks/labelingMemberIds.ts
//
// Member ids for a cluster-uid labeling assign (issue #315 R1c E2E finding).
//
// The registered group of a cluster uid is, on the server lane, an
// index-backed HOLEY array — its slots stay holes even once the canonical
// rows are resident, so a `for...of` slot walk yields `undefined` per member
// (the inline-assign crash this module pins). Ids resolve through the member
// spec's columnar refs instead; plain registered arrays keep the slot walk,
// and unregistered uids keep the legacy per-point cluster-id scan.
//
// Store/DOM-free so the mechanism stays instantly testable.

import { groupMembersOfClusterUid } from "../clustering/groupClusterUid";
import { groupMemberRefs } from "../clustering/groupMembers";
import type { DataPoint } from "../dataPreprocessing/dataPreprocessing";
import type { ClusterId } from "../types/labeling";

/** The point ids labeled by an assign to `clusterUid`. */
export function collectClusterUidMemberIds(
  clusterUid: string,
  fallbackPoints: readonly DataPoint[]
): ClusterId[] {
  const ids: ClusterId[] = [];
  // Cluster membership from the group the uid was drawn from (issue #315
  // R1a step 5): the server lane stamps no per-point cluster ids any more,
  // and even where it did, this was a full-dataset scan to find a few
  // thousand members. Legacy groupBy lanes keep the row scan.
  const registered = groupMembersOfClusterUid(clusterUid);
  if (registered) {
    const refs = groupMemberRefs(registered);
    if (refs) for (const r of refs) ids.push(String(r.id) as ClusterId);
    else for (const node of registered) ids.push(String(node.id) as ClusterId);
  } else {
    fallbackPoints.forEach((node) => {
      const insetCid = node.insetClusterId;
      const annoCid = node.annotationClusterId;
      if (String(insetCid) === clusterUid || String(annoCid) === clusterUid) {
        ids.push(String(node.id) as ClusterId);
      }
    });
  }
  return ids;
}
