// src/utils/serverLoss.ts
//
// Loud server-loss reporting (issue #315 R3a, CS §8.8d): "not acceptable to
// silently break mechanisms" — when a server-lane dataset loses its server
// mid-session (failed propagation with no local knn graph, unreachable
// deferred columns), the ONE acceptable shape is an explicit warning. Every
// degraded surface funnels through here; the banner shows once and stays
// until dismissed.

import store, { setServerLossWarning } from "../store";

/** The §8.8d wording — one message for every server-loss surface. */
export const SERVER_LOSS_MESSAGE =
  "Dataset server unavailable — some features are degraded. Reload the page to use the client-only version.";

/** Show the persistent server-loss banner (idempotent while visible). */
export function warnServerLoss(): void {
  if (store.getState().ui.serverLossWarning) return;
  console.error(`[serverLoss] ${SERVER_LOSS_MESSAGE}`);
  store.dispatch(setServerLossWarning(SERVER_LOSS_MESSAGE));
}
