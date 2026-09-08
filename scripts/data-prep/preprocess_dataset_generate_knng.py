import argparse
import gc
import json
import os
import gzip
import sys
from bisect import bisect_right
from math import ceil
from typing import Any, IO, Iterator, Tuple

import hdbscan  # HDBSCAN clustering library
import numpy as np
import pandas as pd
from hdbscan._hdbscan_tree import compute_stability
from scipy.cluster.hierarchy import to_tree
from sklearn.neighbors import NearestNeighbors
from tqdm import tqdm


def ensure_ids_in_records(records: list[dict]) -> None:
    """Ensure each record has a stable integer id; fill missing ids deterministically."""
    next_id = 0
    seen_ids: set[int] = set()

    for record in records:
        raw_id = record.get("id")
        if isinstance(raw_id, bool) or (raw_id is not None and not isinstance(raw_id, int)):
            raise ValueError(f"Invalid id value in record: {raw_id!r}")

        if raw_id is None:
            while next_id in seen_ids:
                next_id += 1
            record["id"] = next_id
            seen_ids.add(next_id)
            next_id += 1
        else:
            if raw_id in seen_ids:
                raise ValueError(f"Duplicate id detected in records: {raw_id}")
            seen_ids.add(raw_id)
            if raw_id >= next_id:
                next_id = raw_id + 1


# -----------------------------------------------------------------------------
# Multipart dataset helpers
# -----------------------------------------------------------------------------

def chunk_by_count(total_count: int, target_per_chunk: int) -> list[tuple[int, int]]:
    """
    Returns a list of (start, end) index pairs that cover [0,total_count) in
    contiguous chunks with sizes close to target_per_chunk.
    """
    if total_count <= 0:
        return []
    n_chunks = max(1, ceil(total_count / target_per_chunk))
    base = total_count // n_chunks
    rem = total_count % n_chunks
    bounds: list[tuple[int, int]] = []
    start = 0
    for i in range(n_chunks):
        size = base + (1 if i < rem else 0)
        end = start + size
        bounds.append((start, end))
        start = end
    return bounds


def write_json_gz(path: str, obj: Any) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as f:
        iterative_json_dump(sanitize_for_json_iterative(obj), f)


def write_multipart_dataset(
    output_manifest_path: str,
    dataset_type: str,
    data_records: list[dict],
    knn_graph: list[list[int]],
    hdbscan_hierarchy: dict | None,
    midpoint_hierarchy: dict | None,
    target_records_per_chunk: int = 120_000,
    *,
    segments: list[dict] | None = None,
    trajectory_midpoints: list[dict] | None = None,
    segment_tiles: dict | None = None,
    omit_knn: bool = False,
) -> None:
    """
    Writes dataset parts and manifest.

    output_manifest_path example: data/chess/manifest.json
    """
    base_dir = os.path.dirname(output_manifest_path)

    total = len(data_records)
    bounds = chunk_by_count(total, target_records_per_chunk)
    cutoffs = [end for (_, end) in bounds]  # for bisect
    num_chunks = len(bounds)

    print(
        f"[multipart] Preparing chunks: total records={total:,}, "
        f"target_per_chunk={target_records_per_chunk:,}, "
        f"chunks={num_chunks}"
    )

    data_chunks_meta: list[dict] = []
    knn_chunks_meta: list[dict] = []
    seg_chunks_meta: list[dict] = []
    mp_chunks_meta: list[dict] = []

    # Pre-bucket segments/midpoints by chunk to avoid O(n^2) filtering
    seg_buckets: list[list[dict]] | None = None
    mp_buckets: list[list[dict]] | None = None

    if segments is not None:
        print(f"[multipart] Bucketing {len(segments):,} segments by chunk...")
        seg_buckets = [[] for _ in bounds]
        for s in tqdm(segments, desc="Bucketing segments"):
            start_idx = int(s["startIndex"])
            ci = max(0, bisect_right(cutoffs, start_idx) - 1)
            seg_buckets[ci].append(s)

    if trajectory_midpoints is not None:
        print(f"[multipart] Bucketing {len(trajectory_midpoints):,} trajectory midpoints by chunk...")
        mp_buckets = [[] for _ in bounds]
        for m in tqdm(trajectory_midpoints, desc="Bucketing midpoints"):
            start_idx = int(m["startIndex"])
            ci = max(0, bisect_right(cutoffs, start_idx) - 1)
            mp_buckets[ci].append(m)

    print("[multipart] Writing data/knn/segment/midpoint chunks...")
    for i, (start, end) in enumerate(
        tqdm(bounds, desc="Writing chunks"), start=0
    ):
        # data
        data_slice = data_records[start:end]
        data_rel = f"data/data-{i:03d}.json.gz"
        write_json_gz(os.path.join(base_dir, data_rel), data_slice)
        data_chunks_meta.append({"path": data_rel, "count": len(data_slice)})

        # knn rows aligned to data rows. Omitted for server-cut datasets
        # (issue #315 A3): the graph exists only for CLIENT DoI propagation,
        # and the client tolerates an absent knnGraph manifest section.
        if not omit_knn:
            knn_slice = knn_graph[start:end]
            knn_rel = f"knn/knn-{i:03d}.json.gz"
            write_json_gz(os.path.join(base_dir, knn_rel), knn_slice)
            knn_chunks_meta.append({"path": knn_rel, "count": len(knn_slice)})

        # segments that start with a point inside [start,end)
        if seg_buckets is not None:
            seg_slice = seg_buckets[i]
            seg_rel = f"segments/segments-{i:03d}.json.gz"
            write_json_gz(os.path.join(base_dir, seg_rel), seg_slice)
            seg_chunks_meta.append({"path": seg_rel, "count": len(seg_slice)})

        # midpoints keyed by startIndex
        if mp_buckets is not None:
            mp_slice = mp_buckets[i]
            mp_rel = f"midpoints/midpoints-{i:03d}.json.gz"
            write_json_gz(os.path.join(base_dir, mp_rel), mp_slice)
            mp_chunks_meta.append({"path": mp_rel, "count": len(mp_slice)})

    print("[multipart] Writing hierarchy files (hdbscan / midpointHdbscan)...")
    hdbscan_rel = None
    if hdbscan_hierarchy is not None:
        hdbscan_rel = "hdbscan.json.gz"
        write_json_gz(os.path.join(base_dir, hdbscan_rel), {"hierarchyTree": hdbscan_hierarchy})

    midpoint_rel = None
    if midpoint_hierarchy is not None:
        midpoint_rel = "midpointHdbscan.json.gz"
        write_json_gz(os.path.join(base_dir, midpoint_rel), {"hierarchyTree": midpoint_hierarchy})

    # Phase 4a (issue #315): quadtree segment tiles for the server-build tile client.
    # A tiled dataset omits the linear segments chunks — trajectories render
    # only through tile hydration, by design (see plan-315-tiled-backend.md).
    segment_tiles_meta = None
    if segment_tiles is not None:
        print(f"[multipart] Writing {len(segment_tiles['tiles'])} segment tiles...")
        tile_index = []
        for (z, x, y), tile_segments_list in sorted(segment_tiles["tiles"].items()):
            tile_rel = f"tiles/segments/{z}/{x}_{y}.json.gz"
            write_json_gz(os.path.join(base_dir, tile_rel), tile_segments_list)
            tile_index.append({"z": z, "x": x, "y": y, "path": tile_rel,
                               "count": len(tile_segments_list)})
        segment_tiles_meta = {
            "scheme": segment_tiles["scheme"],
            "bounds": segment_tiles["bounds"],
            "maxZoom": segment_tiles["maxZoom"],
            "capPerTile": segment_tiles["capPerTile"],
            "tiles": tile_index,
        }

    manifest = {
        "format": "multipart-dataset-v1",
        "datasetType": dataset_type,
        "data": {"chunks": data_chunks_meta},
        "knnGraph": ({"chunks": knn_chunks_meta} if not omit_knn else None),
        "hdbscan": ({"path": hdbscan_rel} if hdbscan_rel else None),
        "midpointHdbscan": ({"path": midpoint_rel} if midpoint_rel else None),
        # New optional geometry sets:
        "segments": (
            {"chunks": seg_chunks_meta}
            if seg_chunks_meta and segment_tiles is None
            else None
        ),
        "trajectoryMidpoints": ({"chunks": mp_chunks_meta} if mp_chunks_meta else None),
        "segmentTiles": segment_tiles_meta,
    }

    os.makedirs(os.path.dirname(output_manifest_path), exist_ok=True)
    print(f"[multipart] Writing manifest to {output_manifest_path}...")
    with open(output_manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False)
    print("[multipart] Manifest written.")



# -----------------------------------------------------------------------------
# Geometry helpers
# -----------------------------------------------------------------------------

def catmull_rom_point(t: float, p0, p1, p2, p3):
    t2 = t * t
    t3 = t2 * t
    x = 0.5 * (
        2 * p1[0]
        + (-p0[0] + p2[0]) * t
        + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
        + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
    )
    y = 0.5 * (
        2 * p1[1]
        + (-p0[1] + p2[1]) * t
        + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
    )
    return [x, y]


def compute_edge_midpoint(p0, p1, p2, p3):
    samples = 20
    points = [catmull_rom_point(i / samples, p0, p1, p2, p3) for i in range(samples + 1)]
    num_segments = len(points) - 1
    for i in range(num_segments):
        start = i / num_segments
        end = (i + 1) / num_segments
        if start <= 0.5 <= end:
            x0, y0 = points[i]
            x1, y1 = points[i + 1]
            return [(x0 + x1) / 2.0, (y0 + y1) / 2.0]
    # fallback
    return [(p1[0] + p2[0]) / 2.0, (p1[1] + p2[1]) / 2.0]


def compute_all_midpoints(df: pd.DataFrame) -> list[tuple[float, float]]:
    midpoints: list[tuple[float, float]] = []
    for _, group in df.groupby("line", sort=False):
        coords = group[["x", "y"]].values.tolist()
        n = len(coords)
        for i in range(n - 1):
            p0 = coords[i - 1] if i > 0 else coords[i]
            p1 = coords[i]
            p2 = coords[i + 1]
            p3 = coords[i + 2] if i + 2 < n else coords[i + 1]
            mid = compute_edge_midpoint(p0, p1, p2, p3)
            midpoints.append(tuple(mid))
    return midpoints


def perturb_duplicates(coords: np.ndarray, eps: float = 1e-9) -> np.ndarray:
    """
    Return a copy of coords where perfectly overlapping points are slightly perturbed.
    Only points beyond the first occurrence of a set of duplicates are jittered.
    """
    perturbed = coords.copy()
    _, inverse, counts = np.unique(coords, axis=0, return_inverse=True, return_counts=True)
    for dup_val, count in enumerate(counts):
        if count > 1:
            dup_indices = np.where(inverse == dup_val)[0]
            for idx in dup_indices[1:]:
                perturbed[idx] += np.random.normal(scale=eps, size=coords.shape[1])
    return perturbed


def build_splines_and_midpoints(
    df: pd.DataFrame,
    *,
    samples_per_edge: int = 20,
) -> tuple[list[dict], list[dict], dict[int, dict]]:
    """
    Replicates the frontend's spline building:
    - returns list of spline segments (each with x0,y0,x1,y1, startIndex, endIndex, etc.)
    - returns list of trajectory midpoints (one per edge)
    - returns mapping: startIndex -> {"x": mid_x, "y": mid_y} for nextEdgeCenter
    """
    segments: list[dict] = []
    midpoints: list[dict] = []
    next_center: dict[int, dict] = {}

    has_action = "action" in df.columns

    # group by trajectory line, preserving input order
    for _, group in df.groupby("line", sort=False):
        coords = group[["x", "y"]].to_numpy(dtype=float)
        idxs = group.index.to_numpy()
        actions = group["action"].to_numpy() if has_action else None
        n = len(coords)
        if n <= 1:
            continue

        # For each edge (i -> i+1)
        for i in range(n - 1):
            p1 = coords[i]
            p2 = coords[i + 1]
            p0 = coords[i - 1] if i > 0 else p1
            p3 = coords[i + 2] if i + 2 < n else p2

            # pre-sample curve points along Catmull–Rom
            curve: list[list[float]] = []
            for s in range(samples_per_edge + 1):
                t = s / samples_per_edge
                curve.append(catmull_rom_point(t, p0, p1, p2, p3))

            num_segments = samples_per_edge
            # build segments
            for s in range(num_segments):
                x0, y0 = curve[s]
                x1, y1 = curve[s + 1]
                start_pct = s / num_segments
                end_pct = (s + 1) / num_segments
                mid_x = (x0 + x1) * 0.5
                mid_y = (y0 + y1) * 0.5
                is_arrow = (s == num_segments - 1)

                segments.append({
                    "x0": float(x0), "y0": float(y0),
                    "x1": float(x1), "y1": float(y1),
                    "startIndex": int(idxs[i]),
                    "endIndex": int(idxs[i + 1]),
                    "startPercentage": float(start_pct),
                    "endPercentage": float(end_pct),
                    "splineMidPoint": {"x": float(mid_x), "y": float(mid_y)},
                    "isArrowSegment": bool(is_arrow),
                    # Optional fields that mirror frontend defaults:
                    "doi": 0.0,
                    "action": (str(actions[i]) if has_action else None),
                })

                # Record the "halfway" midpoint for the start node
                if start_pct <= 0.5 <= end_pct and int(idxs[i]) not in next_center:
                    next_center[int(idxs[i])] = {"x": float(mid_x), "y": float(mid_y)}

            # one trajectory midpoint per edge (used for annotations / midpoint R-tree)
            # reuse the Catmull–Rom halfway midpoint we just computed:
            if int(idxs[i]) in next_center:
                mp = next_center[int(idxs[i])]
                midpoints.append({
                    "midPoint": {"x": mp["x"], "y": mp["y"]},
                    "startIndex": int(idxs[i]),
                    "endIndex": int(idxs[i + 1]),
                    "action": (str(actions[i]) if has_action else None),
                })
            else:
                # robust fallback: compute once via helper (very rare degeneracy)
                mx, my = compute_edge_midpoint(p0, p1, p2, p3)
                midpoints.append({
                    "midPoint": {"x": float(mx), "y": float(my)},
                    "startIndex": int(idxs[i]),
                    "endIndex": int(idxs[i + 1]),
                    "action": (str(actions[i]) if has_action else None),
                })
                next_center[int(idxs[i])] = {"x": float(mx), "y": float(my)}

    return segments, midpoints, next_center


# -----------------------------------------------------------------------------
# k-NN graph
# -----------------------------------------------------------------------------

def compute_knn_graph(df: pd.DataFrame, k: int = 5) -> list:
    coords = df[["x", "y"]].values
    nbrs = NearestNeighbors(n_neighbors=k, algorithm="auto").fit(coords)
    _, indices = nbrs.kneighbors(coords)
    return indices.tolist()


# -----------------------------------------------------------------------------
# Signature-based mapping for stability/birth distances (O(N) memory)   
# -----------------------------------------------------------------------------

def splitmix64(x: int) -> int:
    """Deterministic 64-bit scrambling suitable for XOR-set signatures."""
    x = (x + 0x9E3779B97F4A7C15) & ((1 << 64) - 1)
    x ^= (x >> 30)
    x = (x * 0xBF58476D1CE4E5B9) & ((1 << 64) - 1)
    x ^= (x >> 27)
    x = (x * 0x94D049BB133111EB) & ((1 << 64) - 1)
    x ^= (x >> 31)
    return x & ((1 << 64) - 1)


def build_signature_maps_from_condensed(
    raw_tree: np.ndarray,
    n_points: int,
    root_birth_fallback: float | None = None,
):
    """
    Compute a 64-bit XOR signature for every cluster id in the condensed tree,
    then produce maps {signature -> stability} and {signature -> birthDistance}.
    No materialization of member leaf sets.
    """
    # Build adjacency: parent -> children
    children: dict[int, list[int]] = {}
    parent_ids: set[int] = set()
    child_ids: set[int] = set()
    for p, c, _, _ in raw_tree:
        p = int(p)
        c = int(c)
        children.setdefault(p, []).append(c)
        parent_ids.add(p)
        child_ids.add(c)

    roots = list(parent_ids - child_ids)  # typically length 1

    # Post-order traversal to compute signatures
    sig_cache: dict[int, int] = {}
    stack: list[tuple[int, bool]] = [(r, False) for r in roots]
    while stack:
        node, seen = stack.pop()
        if seen:
            s = 0
            for ch in children.get(node, []):
                if ch < n_points:  # leaf
                    s ^= splitmix64(ch)
                else:
                    s ^= sig_cache[ch]
            sig_cache[node] = s
        else:
            stack.append((node, True))
            for ch in children.get(node, []):
                if ch >= n_points:
                    stack.append((ch, False))

    # Stability per cluster id
    stab_by_cluster = compute_stability(raw_tree)  # dict-like: {cluster_id: stability}

    sig_to_stability: dict[int, float] = {}
    for cid, stab in stab_by_cluster.items():
        cid = int(cid)
        if cid in sig_cache:
            sig_to_stability[sig_cache[cid]] = float(stab)

    # Birth distance: first time a child appears; 1/lambda
    birth_by_cluster: dict[int, float] = {}
    for _, c, lambda_val, _ in raw_tree:
        c = int(c)
        birth_by_cluster.setdefault(c, float(1.0 / lambda_val))

    sig_to_birth: dict[int, float] = {}
    for cid, b in birth_by_cluster.items():
        if cid in sig_cache:
            sig_to_birth.setdefault(sig_cache[cid], b)

    # Ensure roots have a birth set
    if root_birth_fallback is not None:
        for r in roots:
            r_sig = sig_cache.get(r)
            if r_sig is not None and r_sig not in sig_to_birth:
                sig_to_birth[r_sig] = float(root_birth_fallback)

    return sig_to_stability, sig_to_birth


def convert_tree_iterative_light(
    root: Any,
    total_nodes: int,
    sig_to_stability: dict[int, float],
    sig_to_birth: dict[int, float],
):
    """
    Convert SciPy ClusterNode tree to a dict hierarchy without storing member lists.
    Uses XOR signatures of leaf indices to look up stability/birthDistance.
    """
    pbar = tqdm(total=total_nodes, desc="Converting hierarchical tree (light)")
    node_to_dict: dict[int, dict] = {}
    sig_cache: dict[int, int] = {}

    stack: list[Tuple[Any, bool]] = [(root, False)]
    while stack:
        node, seen = stack.pop()
        if node is None:
            continue
        if seen:
            if node.is_leaf():
                leaf_idx = node.id
                s = splitmix64(leaf_idx)
                sig_cache[node.id] = s
                node_to_dict[node.id] = {
                    "id": node.id,
                    "leafIndex": leaf_idx,
                    "distance": node.dist,
                    "size": node.count,
                    "stability": sig_to_stability.get(s, 0.0),
                    "birthDistance": sig_to_birth.get(s, 0.0),
                    "leftChild": None,
                    "rightChild": None,
                }
            else:
                left = node.left.id if node.left else None
                right = node.right.id if node.right else None
                s_left = sig_cache[left] if left is not None else 0
                s_right = sig_cache[right] if right is not None else 0
                s = s_left ^ s_right
                sig_cache[node.id] = s
                node_to_dict[node.id] = {
                    "id": node.id,
                    "distance": node.dist,
                    "size": node.count,
                    "stability": sig_to_stability.get(s, 0.0),
                    "birthDistance": sig_to_birth.get(s, 0.0),
                    "leftChild": node_to_dict.get(left) if left is not None else None,
                    "rightChild": node_to_dict.get(right) if right is not None else None,
                }
            pbar.update(1)
        else:
            stack.append((node, True))
            if not node.is_leaf():
                if node.right:
                    stack.append((node.right, False))
                if node.left:
                    stack.append((node.left, False))
    pbar.close()
    return node_to_dict[root.id]


# -----------------------------------------------------------------------------
# Bounding boxes without materializing member lists
# -----------------------------------------------------------------------------

def assign_bboxes_iterative_leafindex(root: dict, data_records: list[dict]) -> None:
    """
    Assign axis-aligned bounding boxes to all nodes.
    Leaves hold a 'leafIndex'; internal nodes take the min/max of children.
    """
    stack: list[Tuple[dict, bool]] = [(root, False)]
    while stack:
        node, visited = stack.pop()
        if node is None:
            continue
        if not visited:
            stack.append((node, True))
            if node.get("rightChild"):
                stack.append((node["rightChild"], False))
            if node.get("leftChild"):
                stack.append((node["leftChild"], False))
        else:
            left = node.get("leftChild")
            right = node.get("rightChild")
            if left is None and right is None:
                idx = node["leafIndex"]
                x = data_records[idx]["x"]
                y = data_records[idx]["y"]
                node["bbox"] = {"minX": x, "minY": y, "maxX": x, "maxY": y}
            else:
                b1 = left.get("bbox") if left is not None else None
                b2 = right.get("bbox") if right is not None else None
                if b1 and b2:
                    node["bbox"] = {
                        "minX": min(b1["minX"], b2["minX"]),
                        "minY": min(b1["minY"], b2["minY"]),
                        "maxX": max(b1["maxX"], b2["maxX"]),
                        "maxY": max(b1["maxY"], b2["maxY"]),
                    }
                elif b1:
                    node["bbox"] = b1
                elif b2:
                    node["bbox"] = b2


def assign_bboxes_recursive(root: dict, data_records: list[dict]) -> None:
    """Assign bounding boxes using recursive traversal (legacy helper)."""
    left = root.get("leftChild")
    right = root.get("rightChild")
    if left is None and right is None:
        idx = root.get("leafIndex")
        if idx is None and root.get("children"):
            idx = root["children"][0]
        x = data_records[idx]["x"]
        y = data_records[idx]["y"]
        root["bbox"] = {"minX": x, "minY": y, "maxX": x, "maxY": y}
        return
    if left is not None:
        assign_bboxes_recursive(left, data_records)
    if right is not None:
        assign_bboxes_recursive(right, data_records)
    b1 = left.get("bbox") if left is not None else None
    b2 = right.get("bbox") if right is not None else None
    if b1 and b2:
        root["bbox"] = {
            "minX": min(b1["minX"], b2["minX"]),
            "minY": min(b1["minY"], b2["minY"]),
            "maxX": max(b1["maxX"], b2["maxX"]),
            "maxY": max(b1["maxY"], b2["maxY"]),
        }
    elif b1:
        root["bbox"] = b1
    elif b2:
        root["bbox"] = b2


def assign_bboxes_iterative(root: dict, data_records: list[dict]) -> None:
    """Compatibility helper that prefers iterative leaf-index method."""
    try:
        assign_bboxes_iterative_leafindex(root, data_records)
    except KeyError:
        assign_bboxes_recursive(root, data_records)


# -----------------------------------------------------------------------------
# JSON utils
# -----------------------------------------------------------------------------

def sanitize_for_json_iterative(obj: Any) -> Any:
    """
    Replace NaN with None and +-inf with strings, iteratively (no recursion).
    Supports dicts, lists, and floats.
    """
    if isinstance(obj, float):
        if np.isnan(obj):
            return None
        if np.isinf(obj):
            return "Infinity" if obj > 0 else "-Infinity"
        return obj
    if not isinstance(obj, (list, dict)):
        return obj

    new_obj = {} if isinstance(obj, dict) else []
    stack = [(obj, new_obj)]
    while stack:
        current, sanitized = stack.pop()
        if isinstance(current, dict):
            for key, value in current.items():
                if isinstance(value, float):
                    if np.isnan(value):
                        sanitized[key] = None
                    elif np.isinf(value):
                        sanitized[key] = "Infinity" if value > 0 else "-Infinity"
                    else:
                        sanitized[key] = value
                elif isinstance(value, dict):
                    sanitized[key] = {}
                    stack.append((value, sanitized[key]))
                elif isinstance(value, list):
                    sanitized[key] = []
                    stack.append((value, sanitized[key]))
                else:
                    sanitized[key] = value
        elif isinstance(current, list):
            for item in current:
                if isinstance(item, float):
                    if np.isnan(item):
                        sanitized.append(None)
                    elif np.isinf(item):
                        sanitized.append("Infinity" if item > 0 else "-Infinity")
                    else:
                        sanitized.append(item)
                elif isinstance(item, dict):
                    new_dict = {}
                    sanitized.append(new_dict)
                    stack.append((item, new_dict))
                elif isinstance(item, list):
                    new_list = []
                    sanitized.append(new_list)
                    stack.append((item, new_list))
                else:
                    sanitized.append(item)
    return new_obj


def iterative_json_dump(obj: Any, f: IO[str]) -> None:
    """
    Iteratively dumps JSON to the given file-like object using a stack.
    Supports dict, list, str, int, float, bool, and None.
    """
    def write_primitive(x: Any) -> None:
        f.write(json.dumps(x))

    if isinstance(obj, dict):
        f.write("{")
        stack: list[Tuple[Iterator, str, bool]] = [(iter(obj.items()), "dict", True)]
    elif isinstance(obj, list):
        f.write("[")
        stack = [(iter(enumerate(obj)), "list", True)]
    else:
        write_primitive(obj)
        return

    while stack:
        current_iter, container_type, is_first = stack[-1]
        try:
            if container_type == "dict":
                key, value = next(current_iter)
                if not is_first:
                    f.write(",")
                else:
                    stack[-1] = (current_iter, container_type, False)
                f.write(json.dumps(key))
                f.write(":")
                if isinstance(value, dict):
                    f.write("{")
                    stack.append((iter(value.items()), "dict", True))
                elif isinstance(value, list):
                    f.write("[")
                    stack.append((iter(enumerate(value)), "list", True))
                else:
                    write_primitive(value)
            else:  # list
                _, element = next(current_iter)
                if not is_first:
                    f.write(",")
                else:
                    stack[-1] = (current_iter, container_type, False)
                if isinstance(element, dict):
                    f.write("{")
                    stack.append((iter(element.items()), "dict", True))
                elif isinstance(element, list):
                    f.write("[")
                    stack.append((iter(enumerate(element)), "list", True))
                else:
                    write_primitive(element)
        except StopIteration:
            stack.pop()
            f.write("}" if container_type == "dict" else "]")


# -----------------------------------------------------------------------------
# Main processing
# -----------------------------------------------------------------------------

# Fields every slim record keeps regardless of --slim-columns: the core the
# frontend runtime needs (rendering/clustering/refs/labels) plus injected
# geometry. Everything else is high-dim content that lives only in the
# server edition's fat copy (issue #315 slim datasets).
SLIM_ALWAYS_KEPT = ("x", "y", "line", "id", "action", "label", "nextEdgeCenter")


def project_records_to_slim(records: list[dict], slim_columns: list[str]) -> None:
    """Strip every field not in SLIM_ALWAYS_KEPT + slim_columns, in place.

    Must run AFTER ensure_ids_in_records: the (id, line) pair is the member-ref
    identity the inset service resolves against its fat copy, so ids must be
    materialized before projection and both copies must come from the same
    row order.
    """
    keep = set(SLIM_ALWAYS_KEPT) | set(slim_columns)
    for record in records:
        for key in [k for k in record.keys() if k not in keep]:
            del record[key]


def process_dataset(
    input_csv: str,
    output_json: str,
    k: int,
    multipart: bool = False,
    dataset_type: str = "default",
    target_records_per_chunk: int = 120_000,
    samples_per_edge: int = 20,
    tile_segments_quadtree: bool = False,
    slim_columns: list[str] | None = None,
    omit_knn: bool = False,
) -> None:
    """
    Loads the dataset, computes the k-NN graph and HDBSCAN-based hierarchical clustering
    for points and for trajectory midpoints, builds spline geometry, assigns bounding boxes,
    and saves to JSON (single-file or multipart).
    """
    print(f"Loading data from {input_csv}...")
    df = pd.read_csv(input_csv)
    print("Data loaded.")

    if "x" not in df.columns or "y" not in df.columns:
        raise ValueError("The input CSV must contain 'x' and 'y' columns.")
    if "line" not in df.columns and "episode" in df.columns:
        # RL datasets name the trajectory column 'episode'. Copy (not rename)
        # into the internal 'line' field the frontend groups by, so 'episode'
        # stays available as a user-facing column (e.g. for color encoding).
        df["line"] = df["episode"]
    if "line" not in df.columns:
        raise ValueError("The input CSV must contain a 'line' (or 'episode') column (trajectory id).")

    # Ensure row index is a dense 0..N-1 (we key geometry by row index)
    if not np.array_equal(df.index.values, np.arange(len(df))):
        df = df.reset_index(drop=True)

    print(f"Computing k-NN graph with k={k}...")
    knn_graph = compute_knn_graph(df, k=k)
    print("k-NN graph computed.")

    print("Computing hierarchical clustering with HDBSCAN (points)...")
    coords = df[["x", "y"]].values
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=k,
        gen_min_span_tree=False,
        approx_min_span_tree=True,
    )
    clusterer.fit(perturb_duplicates(coords))

    linkage_matrix = clusterer.single_linkage_tree_.to_numpy()
    tree_root, _ = to_tree(linkage_matrix, rd=True)
    total_nodes = 2 * len(df) - 1

    raw_tree = clusterer.condensed_tree_._raw_tree
    sig_to_stability, sig_to_birth = build_signature_maps_from_condensed(
        raw_tree, len(df), root_birth_fallback=float(linkage_matrix[-1][2])
    )

    hdbscan_hierarchy = convert_tree_iterative_light(
        tree_root, total_nodes, sig_to_stability, sig_to_birth
    )
    print("Hierarchical clustering computed.")

    # Free large temporaries before midpoint pass
    del clusterer, linkage_matrix, raw_tree, sig_to_stability, sig_to_birth, tree_root
    gc.collect()

    print("Building spline geometry + trajectory midpoints...")
    segments, traj_midpoints, next_center = build_splines_and_midpoints(
        df, samples_per_edge=samples_per_edge
    )
    print(f"Spline segments: {len(segments):,} | trajectory midpoints: {len(traj_midpoints):,}")

    print("Computing trajectory midpoint clustering...")
    if traj_midpoints:
        mp_coords = np.array([[m["midPoint"]["x"], m["midPoint"]["y"]] for m in traj_midpoints], dtype=np.float64)
        mp_clusterer = hdbscan.HDBSCAN(
            min_cluster_size=k,
            gen_min_span_tree=False,
            approx_min_span_tree=True,
        )
        mp_clusterer.fit(mp_coords)

        mp_linkage = mp_clusterer.single_linkage_tree_.to_numpy()
        mp_root, _ = to_tree(mp_linkage, rd=True)
        mp_total = 2 * len(traj_midpoints) - 1

        mp_raw = mp_clusterer.condensed_tree_._raw_tree
        mp_sig_to_stability, mp_sig_to_birth = build_signature_maps_from_condensed(
            mp_raw, len(traj_midpoints), root_birth_fallback=float(mp_linkage[-1][2])
        )

        midpoint_hierarchy = convert_tree_iterative_light(
            mp_root, mp_total, mp_sig_to_stability, mp_sig_to_birth
        )

        # bbox assign uses "records" with x/y fields
        midpoint_records = [{"x": float(x), "y": float(y)} for x, y in mp_coords.tolist()]
        assign_bboxes_iterative_leafindex(midpoint_hierarchy, midpoint_records)

        # Free midpoint temporaries
        del mp_clusterer, mp_linkage, mp_raw, mp_sig_to_stability, mp_sig_to_birth, mp_root, mp_coords
        gc.collect()
    else:
        midpoint_hierarchy = None
    print("Midpoint clustering computed.")

    print("Assigning bounding boxes to each cluster node...")
    data_records = df.to_dict(orient="records")

    # populate nextEdgeCenter on records (fallback: arithmetic midpoint to next node)
    for i in range(len(data_records) - 1):
        if data_records[i]["line"] != data_records[i + 1]["line"]:
            continue  # last point in a line
        if i in next_center:
            data_records[i]["nextEdgeCenter"] = {"x": float(next_center[i]["x"]), "y": float(next_center[i]["y"])}
        else:
            x0, y0 = data_records[i]["x"], data_records[i]["y"]
            x1, y1 = data_records[i + 1]["x"], data_records[i + 1]["y"]
            data_records[i]["nextEdgeCenter"] = {"x": float((x0 + x1) * 0.5), "y": float((y0 + y1) * 0.5)}

    assign_bboxes_iterative_leafindex(hdbscan_hierarchy, data_records)
    print("Bounding boxes assigned.")

    ensure_ids_in_records(data_records)
    print("IDs ensured in data records.")

    if slim_columns is not None:
        project_records_to_slim(data_records, slim_columns)
        print(f"Records slimmed to core + {slim_columns} (server edition holds the fat copy).")

    out = {
        "data": data_records,
        "knnGraph": knn_graph,
        "hdbscan": {"hierarchyTree": hdbscan_hierarchy},
        "midpointHdbscan": ({"hierarchyTree": midpoint_hierarchy} if midpoint_hierarchy else None),
        # New geometry outputs (included only in single-file mode; in multipart we chunk them)
        "segments": segments,
        "trajectoryMidpoints": traj_midpoints,
    }

    if multipart:
        # Derive the output folder from the output filename, stripping multi-extensions like .json.gz
        base_name = os.path.basename(output_json)
        stem = base_name
        for ext in (".gz", ".json"):
            if stem.lower().endswith(ext):
                stem = stem[: -len(ext)]
        out_dir = os.path.join(os.path.dirname(output_json), stem)
        manifest_path = os.path.join(out_dir, "manifest.json")

        # Phase 4a (issue #315): bucket segments into a quadtree pyramid with
        # trajectory-length importance; the manifest then carries segmentTiles
        # instead of linear segments chunks. Pure logic lives in
        # rl_trajectories/segment_tiler.py (stdlib) so a hosted preprocessing
        # job can reuse it.
        segment_tiles = None
        if tile_segments_quadtree and segments:
            repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
            if repo_root not in sys.path:
                sys.path.insert(0, repo_root)
            from rl_trajectories.segment_tiler import line_importance_ranks, tile_segments

            print(f"Tiling {len(segments):,} segments into a quadtree pyramid...")
            line_of_segment = [data_records[s["startIndex"]]["line"] for s in segments]
            importance = line_importance_ranks(line_of_segment)
            segment_tiles = tile_segments(segments, importance)
            print(f"Segment pyramid: maxZoom {segment_tiles['maxZoom']}, "
                  f"{len(segment_tiles['tiles'])} tiles")

        write_multipart_dataset(
            output_manifest_path=manifest_path,
            dataset_type=dataset_type,
            data_records=data_records,
            knn_graph=knn_graph,
            hdbscan_hierarchy=hdbscan_hierarchy,
            midpoint_hierarchy=midpoint_hierarchy,
            target_records_per_chunk=target_records_per_chunk,
            segments=None if segment_tiles is not None else segments,
            trajectory_midpoints=traj_midpoints,
            segment_tiles=segment_tiles,
            omit_knn=omit_knn,
        )
        print(f"Multipart dataset manifest written to {manifest_path}")
    else:
        print("Sanitizing data for JSON...")
        sanitized_out = sanitize_for_json_iterative(out)
        print("Data sanitized.")

        print(f"Saving processed data to {output_json}...")
        if output_json.endswith(".gz"):
            with gzip.open(output_json, "wt", encoding="utf-8") as f:
                iterative_json_dump(sanitized_out, f)
        else:
            with open(output_json, "w", encoding="utf-8") as f:
                iterative_json_dump(sanitized_out, f)
        print(f"Processed dataset with k-NN graph, hierarchy, and geometry saved to {output_json}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Process a dataset to compute k-NN graph, HDBSCAN clustering, splines, and embed bboxes."
    )
    parser.add_argument("input_csv", help="Path to the input CSV file containing 'x' and 'y' coordinates.")
    parser.add_argument("output_json", help="Path to the output JSON file for the processed data.")
    parser.add_argument(
        "-k",
        "--neighbors",
        type=int,
        default=2,
        help="Number of neighbors / min cluster size for HDBSCAN (default: 2).",
    )
    parser.add_argument(
        "--multipart",
        action="store_true",
        help="Write a multipart dataset with a manifest instead of a single JSON.",
    )
    parser.add_argument(
        "--target-records-per-chunk",
        type=int,
        default=120_000,
        help="Approx rows per chunk for multipart (default: 120k).",
    )
    parser.add_argument(
        "--dataset-type",
        type=str,
        default="default",
        help="Dataset type label stored in the manifest (e.g., 'chess').",
    )
    parser.add_argument(
        "--samples-per-edge",
        type=int,
        default=20,
        help="Number of segments per edge for Catmull–Rom sampling (default: 20).",
    )
    parser.add_argument(
        "--tile-segments",
        action="store_true",
        help="Multipart only (issue #315 phase 4): bucket spline segments into "
        "a quadtree pyramid (manifest segmentTiles section) instead of linear "
        "chunks. Tiled trajectories render only through the server-build tile client.",
    )
    parser.add_argument(
        "--slim-columns",
        type=str,
        default=None,
        help="Comma list of extra per-point columns to KEEP (issue #315 slim "
        "datasets); core fields (x,y,line,id,action,label,nextEdgeCenter) are "
        "always kept. All other columns are stripped from the data records — "
        "the inset service (server edition) must be pointed at a fat copy "
        "generated from the SAME CSV so (id,line) member refs stay aligned.",
    )
    parser.add_argument(
        "--omit-knn",
        action="store_true",
        help="Multipart only (issue #315 A3): write no knn chunks and no "
        "manifest knnGraph section. For server-cut datasets, where the "
        "graph's only consumer is client DoI propagation. Do NOT use for "
        "client-complete datasets - their propagation needs the graph.",
    )

    args = parser.parse_args()
    process_dataset(
        args.input_csv,
        args.output_json,
        args.neighbors,
        multipart=args.multipart,
        dataset_type=args.dataset_type,
        target_records_per_chunk=args.target_records_per_chunk,
        samples_per_edge=args.samples_per_edge,
        tile_segments_quadtree=args.tile_segments,
        slim_columns=(
            [c.strip() for c in args.slim_columns.split(",") if c.strip()]
            if args.slim_columns is not None
            else None
        ),
        omit_knn=args.omit_knn,
    )


if __name__ == "__main__":
    main()
