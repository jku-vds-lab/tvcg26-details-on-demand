import type { FeatureCategoryStat, FeatureStats, FeatureVariableType } from "../slices/datasetFeatures";

const SYNTHETIC_CATEGORY_MAX = 24;

export function compareCategoryValue(a: string, b: string): number {
  const aNum = Number(a);
  const bNum = Number(b);
  const aIsNum = Number.isFinite(aNum) && a.trim() !== "";
  const bIsNum = Number.isFinite(bNum) && b.trim() !== "";

  if (aIsNum && bIsNum) {
    if (aNum !== bNum) return aNum - bNum;
    return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
  }
  if (aIsNum) return -1;
  if (bIsNum) return 1;
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function canUseSmallIntegerHeuristic(stats: FeatureStats): boolean {
  if (stats.numericRatio < 0.95) return false;
  if (!Number.isFinite(stats.min) || !Number.isFinite(stats.max)) return false;
  if (stats.uniqueCount > 12) return false;

  const min = stats.min as number;
  const max = stats.max as number;
  if (!Number.isInteger(min) || !Number.isInteger(max)) return false;
  if (max - min > SYNTHETIC_CATEGORY_MAX) return false;
  return true;
}

export function getEffectiveFeatureKind(
  featureKey: string | undefined,
  stats: FeatureStats | undefined,
  override: FeatureVariableType | undefined
): FeatureVariableType {
  if (featureKey === "DoI") return "sequential";
  if (override) return override === "boolean" ? "categorical" : override;
  if (!stats) return "unknown";

  if (stats.variableType === "boolean") return "categorical";

  if (stats.variableType === "sequential" && canUseSmallIntegerHeuristic(stats)) {
    return "categorical";
  }

  return stats.variableType;
}

export function getLegendCategories(
  stats: FeatureStats | undefined,
  effectiveKind: FeatureVariableType
): FeatureCategoryStat[] {
  if (!stats) return [];
  if (stats.categories && stats.categories.length > 0) {
    return [...stats.categories].sort((a, b) => compareCategoryValue(a.value, b.value));
  }

  if (effectiveKind !== "categorical" && effectiveKind !== "boolean") return [];
  if (!canUseSmallIntegerHeuristic(stats)) return [];

  const min = stats.min as number;
  const max = stats.max as number;
  const categories: FeatureCategoryStat[] = [];
  for (let value = min; value <= max; value += 1) {
    categories.push({ value: String(value), count: 0 });
    if (categories.length >= SYNTHETIC_CATEGORY_MAX) break;
  }

  return categories.sort((a, b) => compareCategoryValue(a.value, b.value));
}
