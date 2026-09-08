import type { DataPoint } from "src/dataPreprocessing/dataPreprocessing";

/**
 * Split a tag string into individual tokens using the given delimiter.
 * Trims whitespace and lowercases each token.
 */
export function parseTags(value: string, delimiter = ","): string[] {
  return value.split(delimiter).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/**
 * Heuristically detect the most common delimiter in a sample of values.
 * Falls back to "," if none of the candidates produce splits.
 */
export function detectDelimiter(sampleValues: string[]): string {
  const candidates = [",", ";", "|", "\t", " "];
  let bestCandidate = ",";
  let bestScore = 0;
  for (const d of candidates) {
    const score = sampleValues.reduce((sum, v) => sum + (v.split(d).length - 1), 0);
    if (score > bestScore) {
      bestScore = score;
      bestCandidate = d;
    }
  }
  return bestCandidate;
}

export interface ClusterCorpus {
  clusterId: string;
  /** Additive tag frequency across all samples in the cluster. */
  tagBag: Map<string, number>;
  totalTags: number;
}

/**
 * Build a tag-frequency bag for a single cluster.
 * Reads the raw feature value (no __assignedLabel override) so TF-IDF
 * reflects the original data, not user annotations.
 */
export function buildClusterCorpus(
  clusterId: string,
  samples: DataPoint[],
  column: string,
  delimiter: string,
): ClusterCorpus {
  const tagBag = new Map<string, number>();
  let totalTags = 0;

  for (const s of samples) {
    // Mirror BaseInsetRenderer.getAnnotationValue: try features bag first,
    // then fall back to direct property (many datasets store fields top-level).
    // Intentionally skip __assignedLabel so TF-IDF scores reflect raw data.
    const raw = s.features?.[column] ?? (s as unknown as Record<string, unknown>)[column];
    if (raw === undefined || raw === null) continue;
    const tags = parseTags(String(raw), delimiter);
    for (const tag of tags) {
      tagBag.set(tag, (tagBag.get(tag) ?? 0) + 1);
      totalTags++;
    }
  }

  return { clusterId, tagBag, totalTags };
}

/**
 * Given a corpus of clusters, compute per-cluster TF-IDF scores and return
 * the top-N distinguishing tags for each cluster as a display label.
 *
 * TF(t,c)  = count(t in c) / totalTags(c)
 * IDF(t)   = log(1 + N / (1 + df(t)))   [smoothed]
 * score    = TF * IDF
 */
export function computeTfIdfLabels(
  corpora: ClusterCorpus[],
  topN = 2,
): Record<string, string> {
  const N = corpora.length;
  if (N === 0) return {};

  // document frequency: how many clusters contain each tag
  const df = new Map<string, number>();
  for (const { tagBag } of corpora) {
    for (const [tag] of tagBag) {
      df.set(tag, (df.get(tag) ?? 0) + 1);
    }
  }

  const result: Record<string, string> = {};

  for (const { clusterId, tagBag, totalTags } of corpora) {
    if (totalTags === 0) {
      result[clusterId] = "";
      continue;
    }

    const scored: Array<[string, number]> = [];
    for (const [tag, count] of tagBag) {
      const tf = count / totalTags;
      const idf = Math.log(1 + N / (1 + (df.get(tag) ?? 0)));
      scored.push([tag, tf * idf]);
    }
    scored.sort((a, b) => b[1] - a[1]);

    const top = scored.slice(0, topN).map(([t]) => t).filter((t) => t.length > 0);
    result[clusterId] = top.join(" · ");
  }

  return result;
}
