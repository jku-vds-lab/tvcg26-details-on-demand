#!/usr/bin/env python3
"""
Fix existing dataset files by adding deterministic sequential IDs.

For single-file datasets (.json, .json.gz):
  - Load the data
  - If "data" is a list, add id: 0, 1, 2, ... to each point
  - If full structure (with "data", "knnGraph", etc.), add IDs to data array
  - Write back

For multipart datasets (manifest.json):
  - For each chunk file in data/chunks, add IDs aligned to global index
  - Update chunk metadata if needed
  - Re-gzip chunks

This is a one-time remediation script to ensure all datasets have stable IDs.
"""

import argparse
import gzip
import json
import os
from pathlib import Path
from typing import Any
from tqdm import tqdm


def load_json_gz(path: str) -> Any:
    """Load JSON from .gz file."""
    with gzip.open(path, 'rt', encoding='utf-8') as f:
        return json.load(f)


def save_json_gz(path: str, obj: Any) -> None:
    """Save JSON to .gz file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.open(path, 'wt', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def load_json_plain(path: str) -> Any:
    """Load JSON from plain file."""
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json_plain(path: str, obj: Any) -> None:
    """Save JSON to plain file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)


def ensure_points_have_ids(points: list[dict], start_id: int = 0) -> tuple[list[dict], int]:
    """
    Add sequential IDs to data points if they don't have them.
    Returns: (modified_points, next_id_after_this_batch)
    """
    next_id = start_id
    for point in points:
        if 'id' not in point or point['id'] is None:
            point['id'] = next_id
        next_id = max(next_id, point.get('id', next_id)) + 1
    return points, next_id


def fix_single_file_dataset(file_path: str, skip_if_has_ids: bool = True) -> bool:
    """
    Fix a single-file dataset (.json or .json.gz).
    Returns True if modified, False if skipped.
    """
    print(f"\n  Processing: {os.path.basename(file_path)}")
    
    is_gzip = file_path.endswith('.gz')
    
    try:
        if is_gzip:
            data = load_json_gz(file_path)
        else:
            data = load_json_plain(file_path)
    except Exception as e:
        print(f"    ⚠️  Failed to load: {e}")
        return False
    
    # Case 1: data is a list of points directly
    if isinstance(data, list):
        if skip_if_has_ids and len(data) > 0 and 'id' in data[0]:
            print(f"    ✓ Already has IDs, skipping")
            return False
        
        print(f"    → Adding IDs to {len(data)} points...")
        data, _ = ensure_points_have_ids(data)
        
        if is_gzip:
            save_json_gz(file_path, data)
        else:
            save_json_plain(file_path, data)
        print(f"    ✓ Added IDs and saved")
        return True
    
    # Case 2: data is a dict with "data" key (full dataset structure)
    elif isinstance(data, dict) and 'data' in data:
        data_array = data.get('data', [])
        if not isinstance(data_array, list):
            print(f"    ⚠️  'data' is not a list, skipping")
            return False
        
        if skip_if_has_ids and len(data_array) > 0 and 'id' in data_array[0]:
            print(f"    ✓ Already has IDs, skipping")
            return False
        
        print(f"    → Adding IDs to {len(data_array)} points in 'data' field...")
        data['data'], _ = ensure_points_have_ids(data_array)
        
        if is_gzip:
            save_json_gz(file_path, data)
        else:
            save_json_plain(file_path, data)
        print(f"    ✓ Added IDs and saved")
        return True
    
    else:
        print(f"    ⚠️  Unexpected structure (not list or dict with 'data'), skipping")
        return False


def fix_multipart_dataset(manifest_path: str, skip_if_has_ids: bool = True) -> bool:
    """
    Fix a multipart dataset by adding IDs to each chunk.
    Returns True if any chunk was modified.
    """
    print(f"\n  Processing manifest: {os.path.basename(manifest_path)}")
    
    try:
        manifest = load_json_plain(manifest_path)
    except Exception as e:
        print(f"    ⚠️  Failed to load manifest: {e}")
        return False
    
    if manifest.get('format') != 'multipart-dataset-v1':
        print(f"    ⚠️  Not a multipart-dataset-v1 manifest, skipping")
        return False
    
    base_dir = os.path.dirname(manifest_path)
    modified = False
    current_id = 0
    
    # Process data chunks
    data_chunks = manifest.get('data', {}).get('chunks', [])
    for chunk_meta in tqdm(data_chunks, desc="    Processing data chunks"):
        chunk_file = os.path.join(base_dir, chunk_meta['path'])
        
        try:
            chunk_data = load_json_gz(chunk_file)
        except Exception as e:
            print(f"      ⚠️  Failed to load chunk {chunk_meta['path']}: {e}")
            continue
        
        if not isinstance(chunk_data, list):
            print(f"      ⚠️  Chunk {chunk_meta['path']} is not a list, skipping")
            continue
        
        # Check if already has IDs
        if skip_if_has_ids and len(chunk_data) > 0 and 'id' in chunk_data[0]:
            current_id += len(chunk_data)
            continue
        
        # Add IDs
        chunk_data, current_id = ensure_points_have_ids(chunk_data, start_id=current_id)
        save_json_gz(chunk_file, chunk_data)
        modified = True
    
    if modified:
        print(f"    ✓ Added IDs to all chunks")
    else:
        print(f"    ✓ All chunks already have IDs")
    
    return modified


def main():
    parser = argparse.ArgumentParser(
        description="Add sequential IDs to all existing dataset files that lack them."
    )
    parser.add_argument(
        '--data-dir',
        type=str,
        default='public/data',
        help='Path to data directory (default: public/data)',
    )
    parser.add_argument(
        '--skip-if-has-ids',
        action='store_true',
        default=True,
        help='Skip files that already have IDs (default: True)',
    )
    parser.add_argument(
        '--no-skip-if-has-ids',
        dest='skip_if_has_ids',
        action='store_false',
        help='Force re-processing even if IDs exist',
    )
    
    args = parser.parse_args()
    
    data_dir = args.data_dir
    if not os.path.isdir(data_dir):
        print(f"❌ Data directory not found: {data_dir}")
        return
    
    print(f"🔍 Scanning {data_dir} for datasets...")
    
    single_file_count = 0
    multipart_count = 0
    modified_count = 0
    
    # Process single-file datasets
    print("\n📄 Single-file datasets:")
    for file_path in sorted(Path(data_dir).glob('*.json.gz')):
        if fix_single_file_dataset(str(file_path), skip_if_has_ids=args.skip_if_has_ids):
            modified_count += 1
        single_file_count += 1
    
    # Process multipart datasets
    print("\n📦 Multipart datasets:")
    for manifest_path in sorted(Path(data_dir).rglob('manifest.json')):
        if fix_multipart_dataset(str(manifest_path), skip_if_has_ids=args.skip_if_has_ids):
            modified_count += 1
        multipart_count += 1
    
    print(f"\n✅ Done!")
    print(f"  Single-file datasets: {single_file_count}")
    print(f"  Multipart datasets: {multipart_count}")
    print(f"  Modified: {modified_count}")


if __name__ == '__main__':
    main()
