// packages/app/src/components/Visualization/Details/backendInsetAdapter.ts
//
// OPEN-CORE factory for per-kind backend inset adapters (issue #315).
// An adapter owns everything one provider family needs on the client:
// gating on its manifest `kind`, the loading → ready/local state machine
// (sync cache hit → no spinner flash; cancellation on unmount), an offline
// circuit breaker, and the one-time "start the service like this" hint.
// The tabular-stats adapter (rows payloads) and the image adapter (object-URL
// payloads) are thin instantiations; a future board adapter would be too.
//
// Breaker rationale: a fetch to an unreachable localhost port takes 0.4–2.4 s
// to fail in Chrome, so a zoom burst against a dead service would keep every
// inset on a spinner for seconds — per burst. After the first unreachable
// failure the whole pending burst bails to the local path at once, and the
// backend is skipped until the retry window elapses.
//
// In public builds `@scaling` resolves to the stub, resolveInsetProvider
// returns null, and every hook reports "local" — the client-side path.

import { useEffect, useMemo, useState } from "react";
import {
  hasLiveCutSubscription,
  leafRangeOf,
  resolveInsetProvider,
  toMemberRef,
  type BackendManifest,
  type InsetContentProvider,
  type InsetRequestOptions,
  type InsetResponse,
} from "@scaling";
import { groupMemberRefs } from "src/clustering/groupMembers";
import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";
import { getCachedInset } from "src/services/insetBackendClient";
import { ledgerMark } from "src/utils/insetLedger";

const OFFLINE_RETRY_MS = 30_000;

/** Member refs for a request: index-backed groups (issue #315 R1c) resolve
 * columnar through their spec (their slots are holes); plain arrays keep
 * the per-row map. */
function memberRefsOf(samples: readonly DataPoint[]) {
  return groupMemberRefs(samples) ?? samples.map(toMemberRef);
}

export type BackendInsetState<P> =
  | { kind: "local" }
  /** `grace` (issue #315 H2): a live cut subscription may still push this
   * inset's content — consumers render a quiet shell instead of a spinner
   * until the grace expires. All other "loading" semantics (local-path
   * gating, fetch lifecycle) are unchanged. */
  | { kind: "loading"; grace?: boolean }
  | { kind: "ready"; payload: P };

/** Spinner deferral while pushed content may still win the mount race
 * (issue #315 H2 regression, measured: pushed PNGs landed 384-700 ms
 * after mount once T0b cut the client defer to 32 ms). The pull request
 * is NOT delayed — only the spinner state is. */
const PUSH_GRACE_MS = 800;

export interface BackendInsetAdapterOptions<PNode, PDiff> {
  /** The manifest `backend.kind` this adapter serves. */
  kind: string;
  /** Payload from a node response; null ⇒ malformed ⇒ local fallback. */
  decodeNode: (response: InsetResponse) => PNode | null;
  /** Payload from a diff response; null ⇒ malformed ⇒ local fallback. */
  decodeDiff: (response: InsetResponse) => PDiff | null;
  /** The "start the service like this" part of the one-time offline hint. */
  startHint: (manifest: BackendManifest) => string;
}

export interface BackendInsetAdapter<PNode, PDiff> {
  /** The active provider when it matches this adapter's kind and the
   * breaker is closed; null ⇒ callers use the client-side path. */
  resolveProvider(): InsetContentProvider | null;
  useNode(
    samples: readonly DataPoint[],
    reqOpts?: InsetRequestOptions
  ): BackendInsetState<PNode>;
  useDiff(
    aSamples: readonly DataPoint[],
    bSamples: readonly DataPoint[],
    reqOpts?: InsetRequestOptions
  ): BackendInsetState<PDiff>;
  /** Test hook: clear the breaker and re-arm the one-time hint. */
  __resetForTests(): void;
}

export function createBackendInsetAdapter<PNode, PDiff>(
  options: BackendInsetAdapterOptions<PNode, PDiff>
): BackendInsetAdapter<PNode, PDiff> {
  const { kind, decodeNode, decodeDiff, startHint } = options;

  let offlineUntil = 0;
  let offlineHintLogged = false;
  /** Hooks with a request in flight; ONE unreachable failure bails them all. */
  const offlineListeners = new Set<() => void>();

  function resolveProvider(): InsetContentProvider | null {
    if (Date.now() < offlineUntil) return null;
    const provider = resolveInsetProvider(undefined);
    return provider && provider.manifest.kind === kind ? provider : null;
  }

  /** fetch() rejects with TypeError when the service is unreachable: trip the
   * breaker, bail every pending hook to local, and hint once. */
  function handleUnreachable(err: unknown, provider: InsetContentProvider): void {
    if (!(err instanceof TypeError)) return;
    offlineUntil = Date.now() + OFFLINE_RETRY_MS;
    const pending = [...offlineListeners];
    offlineListeners.clear();
    for (const bailToLocal of pending) bailToLocal();
    if (offlineHintLogged) return;
    offlineHintLogged = true;
    console.info(
      `[${kind}] Service unreachable at ${provider.manifest.baseUrl}; using the ` +
        `client-side path (retrying every ${OFFLINE_RETRY_MS / 1000} s). ` +
        `Start it with: ${startHint(provider.manifest)}`
    );
  }

  function useBackendPayload<P>(
    aSamples: readonly DataPoint[],
    bSamples: readonly DataPoint[] | null,
    decode: (response: InsetResponse) => P | null,
    reqOpts?: InsetRequestOptions
  ): BackendInsetState<P> {
    const provider = resolveProvider();
    // Range-backed requests (issue #315): cut-driven group arrays carry a
    // `__leafRange` marker — the request then ships ranges instead of
    // O(members) refs, and the ref materialization below is skipped entirely
    // (it runs lazily only for the older-server fallback). Diffs go by range
    // when BOTH sides are full cut-driven memberships — hovering an inset of
    // a 100k-member cluster froze on building/keying/POSTing MB-scale ref
    // lists per revealed diff pair.
    const supportsRange = !!provider?.getNodeInsetByRange;
    const supportsDiffRange = !!provider?.getDiffInsetByRange;
    const aRangeMark = supportsRange ? leafRangeOf(aSamples) : null;
    const bRangeMark = bSamples && supportsDiffRange ? leafRangeOf(bSamples) : null;
    const aRange = !bSamples ? aRangeMark : null;
    // Memoized: a fresh { a, b } per render would bust the aRefs/bRefs memos
    // below every render (re-running the O(members) ref materialization on
    // the fallback lane) — the range marks are identity-stable per samples
    // array, so this only changes when the memberships do.
    const diffRanges = useMemo(
      () =>
        bSamples && supportsDiffRange && aRangeMark && bRangeMark
          ? { a: aRangeMark, b: bRangeMark }
          : null,
      [bSamples, supportsDiffRange, aRangeMark, bRangeMark]
    );
    const aRefs = useMemo(
      () => (aRange || diffRanges ? [] : memberRefsOf(aSamples)),
      [aSamples, aRange, diffRanges]
    );
    const bRefs = useMemo(
      () => (bSamples ? (diffRanges ? [] : memberRefsOf(bSamples)) : null),
      [bSamples, diffRanges]
    );
    // The order-independent cluster signature key — effect + cache identity.
    const key = provider
      ? bRefs
        ? diffRanges
          ? provider.diffInsetRangeKey!(diffRanges.a, diffRanges.b, reqOpts)
          : provider.diffInsetKey(aRefs, bRefs, reqOpts)
        : aRange
          ? provider.nodeInsetRangeKey!(aRange, reqOpts)
          : provider.nodeInsetKey(aRefs, reqOpts)
      : null;

    const readState = (k: string | null): BackendInsetState<P> => {
      if (!k) return { kind: "local" };
      const cached = getCachedInset<InsetResponse>(k);
      if (!cached) {
        return hasLiveCutSubscription()
          ? { kind: "loading", grace: true }
          : { kind: "loading" };
      }
      const payload = decode(cached);
      return payload !== null ? { kind: "ready", payload } : { kind: "local" };
    };

    const [state, setState] = useState<BackendInsetState<P>>(() => readState(key));

    useEffect(() => {
      const initial = readState(key);
      setState(initial);
      // Task 2 attribution (#315): per-signature fetch lifecycle. `k:`-
      // prefixed ids join to cluster uids via the spans in the range key.
      if (key) ledgerMark(`k:${key}`, initial.kind === "loading" ? "fetchEffect" : "cacheHitSync");
      if (initial.kind !== "loading" || !key || !provider) return;

      let cancelled = false;
      // Grace expiry: pushed content lost the race — surface the spinner.
      // Functional update so a ready/local result landing first is kept.
      const graceTimer =
        initial.kind === "loading" && initial.grace
          ? setTimeout(() => {
              setState((s) => (s.kind === "loading" ? { kind: "loading" } : s));
            }, PUSH_GRACE_MS)
          : undefined;
      const bailToLocal = () => {
        if (!cancelled) setState({ kind: "local" });
        provider.cancel(key);
      };
      offlineListeners.add(bailToLocal);
      const request = bRefs
        ? diffRanges
          ? provider.getDiffInsetByRange!(
              diffRanges.a,
              diffRanges.b,
              () => memberRefsOf(aSamples),
              () => memberRefsOf(bSamples!),
              reqOpts
            )
          : provider.getDiffInset(aRefs, bRefs, reqOpts)
        : aRange
          ? provider.getNodeInsetByRange!(aRange, () => memberRefsOf(aSamples), reqOpts)
          : provider.getNodeInset(aRefs, reqOpts);
      request
        .then((response) => {
          offlineListeners.delete(bailToLocal);
          if (cancelled) return;
          const payload = decode(response);
          ledgerMark(`k:${key}`, "fetchReady");
          setState(payload !== null ? { kind: "ready", payload } : { kind: "local" });
        })
        .catch((err: unknown) => {
          offlineListeners.delete(bailToLocal);
          if (cancelled || (err instanceof DOMException && err.name === "AbortError")) return;
          ledgerMark(`k:${key}`, "fetchError");
          handleUnreachable(err, provider);
          setState({ kind: "local" });
        });
      return () => {
        cancelled = true;
        if (graceTimer !== undefined) clearTimeout(graceTimer);
        offlineListeners.delete(bailToLocal);
        provider.cancel(key);
      };
      // provider/refs identities churn per render; `key` is the stable signature.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);

    return state;
  }

  function useNode(
    samples: readonly DataPoint[],
    reqOpts?: InsetRequestOptions
  ): BackendInsetState<PNode> {
    return useBackendPayload(samples, null, decodeNode, reqOpts);
  }

  function useDiff(
    aSamples: readonly DataPoint[],
    bSamples: readonly DataPoint[],
    reqOpts?: InsetRequestOptions
  ): BackendInsetState<PDiff> {
    return useBackendPayload(aSamples, bSamples, decodeDiff, reqOpts);
  }

  return {
    resolveProvider,
    useNode,
    useDiff,
    __resetForTests: () => {
      offlineUntil = 0;
      offlineHintLogged = false;
      offlineListeners.clear();
    },
  };
}
