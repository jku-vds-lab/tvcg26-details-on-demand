// packages/app/src/stores/liveSliderSettingsStore.ts
//
// Live slider values as a tiny external store (issue #330).
//
// During a propagation-slider drag the preview pipeline is imperative
// (currentSliderSettingsRef → PreviewPropagator RAF loop → opacity texture),
// but the per-frame UI echo used to go through App-level React state — one
// full App-tree re-render per animation frame, measured at 12.7 fps on a
// production build. This store replaces that echo: only the components that
// actually render live slider values subscribe (the slider rows, the color
// legend), so a drag frame re-renders exactly those. App state still updates
// on COMMIT (thumb release) — everything reading committed values is
// unaffected. The demo-glide choreography drives the same setter, so glides
// keep moving the visible thumbs.

import { useSyncExternalStore } from "react";
import type { SliderSettings } from "../components/InterestTabSliders";
import { initialVisualizationSettings } from "../store";

let snapshot: SliderSettings = {
  proximitySlider: initialVisualizationSettings.proximitySlider,
  pastSlider: initialVisualizationSettings.pastSlider,
  futureSlider: initialVisualizationSettings.futureSlider,
  grayOutDoiThreshold: initialVisualizationSettings.grayOutDoiThreshold,
  annotationDoiThreshold: initialVisualizationSettings.annotationDoiThreshold,
  insetDoiThreshold: initialVisualizationSettings.insetDoiThreshold,
};

const listeners = new Set<() => void>();

export function getLiveSliderSettings(): SliderSettings {
  return snapshot;
}

export function setLiveSliderSettings(next: SliderSettings): void {
  if (
    snapshot.proximitySlider === next.proximitySlider &&
    snapshot.pastSlider === next.pastSlider &&
    snapshot.futureSlider === next.futureSlider &&
    snapshot.grayOutDoiThreshold === next.grayOutDoiThreshold &&
    snapshot.annotationDoiThreshold === next.annotationDoiThreshold &&
    snapshot.insetDoiThreshold === next.insetDoiThreshold
  ) {
    return;
  }
  snapshot = { ...next };
  listeners.forEach((l) => l());
}

export function subscribeLiveSliderSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribe a component to the live values (identity-stable snapshot). */
export function useLiveSliderSettings(): SliderSettings {
  return useSyncExternalStore(
    subscribeLiveSliderSettings,
    getLiveSliderSettings,
    getLiveSliderSettings,
  );
}
