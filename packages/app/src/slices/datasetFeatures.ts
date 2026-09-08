import { createSlice, PayloadAction } from "@reduxjs/toolkit";

export type FeatureVariableType = "categorical" | "sequential" | "diverging" | "boolean" | "unknown";

export interface FeatureCategoryStat {
  value: string;
  count: number;
}

export interface FeatureStats {
  key: string;
  variableType: FeatureVariableType;
  uniqueCount: number;
  totalCount: number;
  numericRatio: number;
  min?: number;
  max?: number;
  hasNegative?: boolean;
  hasPositive?: boolean;
  categories?: FeatureCategoryStat[];
  /** How many rows were scanned to produce this stat. */
  confidence: "provisional" | "preliminary" | "high";
}

export interface DatasetFeaturesState {
  availableKeys: string[];
  statsByKey: Record<string, FeatureStats>;
  featureTypeOverrides: Record<string, FeatureVariableType>;
  /** Bumped when a deferred column attaches (issue #315 R3c) so memoized
   * consumers of column values (inset overlay labels) re-resolve. */
  deferredColumnsRevision: number;
}

const initialState: DatasetFeaturesState = {
  availableKeys: [],
  statsByKey: {},
  featureTypeOverrides: {},
  deferredColumnsRevision: 0,
};

const datasetFeaturesSlice = createSlice({
  name: "datasetFeatures",
  initialState,
  reducers: {
    setAvailableFeatureKeys(state, action: PayloadAction<string[]>) {
      state.availableKeys = action.payload;
    },
    setFeatureMetadata(
      state,
      action: PayloadAction<{ availableKeys: string[]; statsByKey: Record<string, FeatureStats> }>
    ) {
      state.availableKeys = action.payload.availableKeys;
      state.statsByKey = action.payload.statsByKey;
      state.featureTypeOverrides = {};
    },
    /**
     * Merges provisional/preliminary stats without clearing featureTypeOverrides.
     * Use this for early partial dispatches; the final setFeatureMetadata call
     * (full scan) will replace everything and reset overrides as usual.
     */
    setFeatureMetadataProvisional(
      state,
      action: PayloadAction<{ availableKeys: string[]; statsByKey: Record<string, FeatureStats> }>
    ) {
      state.availableKeys = action.payload.availableKeys;
      state.statsByKey = action.payload.statsByKey;
      // Intentionally does NOT reset featureTypeOverrides.
    },
    setFeatureTypeOverride(
      state,
      action: PayloadAction<{ key: string; variableType?: FeatureVariableType }>
    ) {
      const { key, variableType } = action.payload;
      if (!key) return;
      if (!variableType) {
        delete state.featureTypeOverrides[key];
        return;
      }
      state.featureTypeOverrides[key] = variableType;
    },
    clearFeatureMetadata(state) {
      state.availableKeys = [];
      state.statsByKey = {};
      state.featureTypeOverrides = {};
    },
    /** A deferred column attached (issue #315 R3c) — see the state field. */
    bumpDeferredColumnsRevision(state) {
      state.deferredColumnsRevision += 1;
    },
  },
});

export const { setAvailableFeatureKeys, setFeatureMetadata, setFeatureMetadataProvisional, setFeatureTypeOverride, clearFeatureMetadata, bumpDeferredColumnsRevision } = datasetFeaturesSlice.actions;
export default datasetFeaturesSlice.reducer;
