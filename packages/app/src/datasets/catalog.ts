// Single source of truth for dataset definitions.
// All types, the master list, and dataset-related helpers live here.
// UI concerns (icons, group order, labels) stay in PredefinedDatasets.tsx.

import { scalingBuildHasBackends } from "@scaling";
import { isGymUnlocked } from "./gymUnlock";

export type DatasetKind =
  | "chess"
  | "rubik"
  | "mnist"
  | "cctv"
  | "gymnasium"
  | "cartpole" // upload/renderer type only (hand-coded TS inset); no predefined entry
  | "default"
  | string;

export interface DatasetEntry {
  path: string;        // e.g. "data/all-openings_seed0_dedup.json.gz"
  type: string;        // e.g. "json"
  display: string;     // short human-readable label
  datasetType: DatasetKind;
  iconKind?: DatasetKind; // optional: override icon per row
  /** Stable short identifier used by deep-link URLs (`ds=` param). */
  slug: string;
  /**
   * Only offered when the app runs on localhost: the dataset files are
   * gitignored (not deployed) and/or its insets need the local render
   * service (rl_trajectories/render_server.py).
   */
  localOnly?: boolean;
  /**
   * Pin the pre-tabular ABSTRACT placeholder inset (paper-figure parity,
   * 2026-08-05): the paper's guiding/combination figures were made before
   * the tabular feature card existed, and their deep links must reproduce
   * the printed look. Without this flag a "default" dataset whose rows carry
   * feature columns renders the tabular card.
   */
  abstractInsets?: boolean;
  /**
   * The dataset cannot function without its backend service (slim data whose
   * insets live server-side, or a treeless manifest whose hierarchy comes
   * from the cut service). Locked on builds without the `@scaling` provider
   * tree (the open-core stub) — a public user could click it but only ever
   * get blank insets or a clustering that never finishes.
   */
  requiresBackend?: boolean;
}

/** Master list of predefined datasets. */
export const PREDEFINED_DATASETS: DatasetEntry[] = [
  // Rubik
  {
    path: "data/10x2-origins_splines_stability.json.gz",
    type: "json",
    display: "10×2 origins",
    datasetType: "rubik",
    slug: "rubik10",
  },
  {
    path: "data/100x2-origins_splines_stability/manifest.json",
    type: "json",
    display: "100×2 origins",
    datasetType: "rubik",
    slug: "rubik100",
  },
  // Chess
  {
    path: "data/all_chess_openings/manifest.json",
    type: "json",
    display: "All openings",
    datasetType: "chess",
    slug: "chess",
  },
  // Local-only (gitignored) PSE comparison dataset for the paper; regenerate with:
  // .venv310/Scripts/python.exe scripts/data-prep/preprocess_dataset_generate_knng.py \
  //   packages/app/site/data/chess40k.csv packages/app/public/data/chess40k.json \
  //   --multipart --dataset-type chess -k 2
  {
    path: "data/chess40k/manifest.json",
    type: "json",
    display: "450 games (40k, PSE)",
    datasetType: "chess",
    slug: "chess40k",
    // NOT requiresBackend: the endgame manifest defers columns to 8548, but
    // its JSON chunks are the FAT originals — without a provider (open-core
    // build, dead server) the loader falls back to them and the dataset is
    // fully client-complete.
  },
  // Paper examples
  {
    path: "data/guiding-example_knng_splines_stability.json.gz",
    type: "json",
    display: "Guiding example",
    datasetType: "default",
    slug: "guiding",
    abstractInsets: true,
  },
  // MNIST
  {
    path: "data/digits_test_10k_nn=100/manifest.json",
    type: "json",
    display: "Digits (10k)",
    datasetType: "mnist",
    slug: "mnist",
  },
  {
    path: "data/fashion_test_10k_nn=25/manifest.json",
    type: "json",
    display: "Fashion (10k)",
    datasetType: "mnist",
    slug: "fashion",
  },
  // CCTV
  {
    path: "data/CCTV-labeled/manifest.json",
    type: "json",
    display: "Edinburgh Office",
    datasetType: "cctv",
    slug: "cctv",
  },
  // Local-only (gitignored) on-demand-render demo datasets; regenerate with
  // generate_mujoco_trajectories.py --env-id <id> --render-port <port>.
  // Insets need the matching render service running, one per dataset:
  // python -m rl_trajectories.render_server --npz-dir packages/app/public/data/<name>/npz --env-id <id> --port <port>
  {
    path: "data/hopper/manifest.json", // Hopper-v5, port 8531
    type: "json",
    display: "Hopper (MuJoCo)",
    datasetType: "gymnasium",
    slug: "hopper",
    localOnly: true,
  },
  {
    path: "data/pendulum/manifest.json", // Pendulum-v1, port 8532
    type: "json",
    display: "Pendulum",
    datasetType: "gymnasium",
    slug: "pendulum",
    localOnly: true,
  },
  {
    path: "data/walker2d/manifest.json", // Walker2d-v5, port 8533
    type: "json",
    display: "Walker2d (MuJoCo)",
    datasetType: "gymnasium",
    slug: "walker2d",
    localOnly: true,
  },
  {
    path: "data/lunarlander/manifest.json", // LunarLander-v3, port 8534 (replay-tier demo)
    type: "json",
    display: "LunarLander",
    datasetType: "gymnasium",
    slug: "lunarlander",
    localOnly: true,
  },
  // Gridworld: x/y = player cell (no embedding); generate_gridworld_trajectories.py.
  // Service needs --env-kwargs "{\"map_name\": \"8x8\", \"is_slippery\": true}"
  {
    path: "data/frozenlake/manifest.json", // FrozenLake-v1 8x8, port 8535
    type: "json",
    display: "FrozenLake (gridworld)",
    datasetType: "gymnasium",
    slug: "frozenlake",
    localOnly: true,
  },
  // Gridworld: key->door->goal, curious vs vanilla explorer in ONE dataset
  // (compare side by side via the algo column); x/y = agent cell;
  // generate_keydoor_trajectories.py. Service needs --import-module minigrid
  {
    path: "data/keydoor/manifest.json", // MiniGrid-DoorKey-8x8-v0, port 8536
    type: "json",
    display: "DoorKey (exploration)",
    datasetType: "gymnasium",
    slug: "keydoor",
    localOnly: true,
  },
  // Reward-hacking demo: mid-training PPO hovers out the full episode instead
  // of risking the landing; generate_lunarlander_hover.py.
  {
    path: "data/lunarlander-hover/manifest.json", // LunarLander-v3, port 8538
    type: "json",
    display: "LunarLander (hover exploit)",
    datasetType: "gymnasium",
    slug: "lunarhover",
    localOnly: true,
  },
  // Misspecified-reward variant: per-step airborne bonus, so hovering FARMS
  // reward (long trajectories of repeated positive reward);
  // generate_lunarlander_hover.py --reward-farm.
  {
    path: "data/lunarlander-farm/manifest.json", // LunarLander-v3, port 8539
    type: "json",
    display: "LunarLander (reward farming)",
    datasetType: "gymnasium",
    slug: "lunarfarm",
    localOnly: true,
  },
  // Local-only (gitignored) demo for the server-side tabular stats backend
  // (issue #315 phase 2): its manifest declares `backend:` pointing at the dev
  // stats service. Regenerate with generate_tabular_stats_demo.py; insets need:
  // python -m rl_trajectories.stats_server --dataset packages/app/public/data/tabular-stats-demo/manifest.json --dataset-id tabular-stats-demo
  {
    path: "data/tabular-stats-demo/manifest.json", // stats service, port 8540
    type: "json",
    display: "Tabular stats (backend demo)",
    datasetType: "default",
    slug: "tabularstats",
    localOnly: true,
  },
  // The slim chess40k variant ("chessslim", port 8546) was RETIRED here
  // (issue #315 merge gate, CS 2026-08-06): the endgame chess40k row above
  // now boots treeless whenever its 8548 cut service is live (the loader
  // skips the shipped hierarchies), so the hand-slimmed second row and its
  // second server had no remaining advantage.
  // Local-only (gitignored) synthetic scaling smoke tests (issue #315, the
  // road to millions): Markov walks over cluster centers, treeless client
  // manifest, hierarchies served by the cut service (synthetic bisection
  // trees — cut mechanics, not real HDBSCAN semantics).
  // Regenerate with: python generate_synth1m_dataset.py [--points N --name X --port P]
  // Serve: python -m rl_trajectories.stats_server --dataset packages/app/public/data/<name>/manifest-server.json --dataset-id <name> --port <port>
  {
    path: "data/synth250k/manifest.json", // cut service, port 8549 (8548 belongs to the chess40k endgame server)
    type: "json",
    display: "Synthetic 250k (smoke test)",
    datasetType: "default",
    slug: "synth250k",
    localOnly: true,
    requiresBackend: true, // treeless manifest: no cut service = clustering never finishes
  },
  {
    path: "data/synth1m/manifest.json", // cut service, port 8547
    type: "json",
    display: "Synthetic 1M (smoke test)",
    datasetType: "default",
    slug: "synth1m",
    localOnly: true,
    requiresBackend: true,
  },
  // The "(backend demo)" manifest variants (issue #315 phase 3) are RETIRED
  // (2026-07-31, catalog unification): builds with a backend provider attach the known
  // local inset services to the ORIGINAL entries at runtime when their
  // /health answers — see the @scaling seam provider registry and
  // the service launch commands. No separate rows, no separate manifests.
];

/** The dataset to auto-load at startup. */
export const INITIAL_DATASET: DatasetEntry =
  findDatasetEntryByPath("data/10x2-origins_splines_stability.json.gz") ??
  PREDEFINED_DATASETS[0];

/** Whether the app runs on localhost (hostname injectable for tests). */
export function isLocalHost(
  hostname: string = typeof window !== "undefined" ? window.location.hostname : ""
): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Origin of the local static data server (rl_trajectories/static_server.py)
 * serving the gitignored demo dataset files to a cheat-unlocked deployed app. */
export const LOCAL_DATA_SERVER_ORIGIN = "http://localhost:8530";

/** Whether a localOnly entry is locked (shown disabled, deep links refused):
 * on deployed hosts localOnly datasets are gitignored/unserved, unless the
 * cheat unlock (gymUnlock.ts) routes their files to the local data server. */
export function isDatasetEntryLocked(
  entry: Pick<DatasetEntry, "localOnly" | "requiresBackend">,
  hostname?: string,
  unlocked: boolean = isGymUnlocked(),
  buildHasBackends: boolean = scalingBuildHasBackends
): boolean {
  // Backend-requiring datasets are dead weight on a provider-less build —
  // no unlock can help; provider-equipped builds never lock on this clause.
  if (entry.requiresBackend && !buildHasBackends) return true;
  return Boolean(entry.localOnly) && !isLocalHost(hostname) && !unlocked;
}

/** Lookup by deep-link slug. Locked localOnly entries resolve to undefined so
 * deployed deep links fall back to the default dataset instead of a 404. */
export function findDatasetEntryBySlug(
  slug: string,
  hostname?: string,
  unlocked?: boolean
): DatasetEntry | undefined {
  const entry = PREDEFINED_DATASETS.find(d => d.slug === slug);
  if (entry && isDatasetEntryLocked(entry, hostname, unlocked)) return undefined;
  return entry;
}

/** Path to hand to the dataset loader. localOnly datasets opened from a
 * deployed host (cheat-unlocked) are fetched from the local data server —
 * their files are gitignored and never deployed. Everything downstream
 * (chunk URLs) resolves relative to this manifest URL. */
export function resolveDatasetFetchPath(path: string, hostname?: string): string {
  const entry = findDatasetEntryByPath(path);
  if (entry?.localOnly && !isLocalHost(hostname)) {
    return `${LOCAL_DATA_SERVER_ORIGIN}/${path.replace(/^\/+/, "")}`;
  }
  return path;
}

/** Lookup by path, tolerating different URL bases. */
export function findDatasetEntryByPath(path: string): DatasetEntry | undefined {
  const norm = normalizePath(path);
  const exact = PREDEFINED_DATASETS.find(d => normalizePath(d.path) === norm);
  if (exact) return exact;
  return PREDEFINED_DATASETS.find(d => norm.endsWith(normalizePath(d.path)));
}

/** True when the dataset at `path` pins the abstract placeholder inset
 * (paper-figure parity — see DatasetEntry.abstractInsets). */
export function prefersAbstractInsets(path: string | undefined): boolean {
  if (!path) return false;
  return findDatasetEntryByPath(path)?.abstractInsets === true;
}

/**
 * Resolves the effective dataset type from two sources.
 * The predefined-tab hint wins unless the embedded file type provides
 * a more specific value.
 */
export function resolveDatasetType(
  predefinedHint: string | undefined,
  fileType: string | undefined,
): string {
  const hint = predefinedHint?.toLowerCase();
  const embedded = fileType?.toLowerCase();
  if (hint && (embedded === undefined || embedded === "custom" || embedded === "default")) return hint;
  return (hint ?? embedded ?? "default").toLowerCase();
}

function normalizePath(p: string): string {
  try {
    const u = new URL(p, window.location.href);
    p = u.pathname;
  } catch {
    // keep as-is if relative
  }
  const q = p.indexOf("?"); if (q >= 0) p = p.slice(0, q);
  const h = p.indexOf("#"); if (h >= 0) p = p.slice(0, h);
  return p;
}
