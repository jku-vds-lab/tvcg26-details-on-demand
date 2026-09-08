#!/usr/bin/env python3
"""
Python script for generating toy data with unique, dense clusters.
Cluster labels and actions are namespaced by algorithm and step index to avoid collisions.
UMAP parameters and Gaussian tightness/separation are configurable.
"""

import argparse
import numpy as np
import pandas as pd
from umap import UMAP

def build_cluster_defs(num_algorithms, pipeline, num_features,
                       center_scale=5.0, cov_scale=0.1, random_state=None):
    rng = np.random.RandomState(random_state)
    defs = {}
    for algo in range(num_algorithms):
        defs[algo] = {}
        for step_idx, step in enumerate(pipeline):
            # collect all non-random cluster labels
            if step['type'] == 'independent':
                labels = [lbl for lbl in step['clusters'] if lbl != 'random']
            else:
                labels = [
                    l for lbls, _ in step['transitions'].values()
                    for l in lbls if l != 'random'
                ]
            labels = sorted(set(labels))
            defs[algo][step_idx] = {}
            for lbl in labels:
                # spread cluster centers out by center_scale
                center = rng.randn(num_features) * center_scale
                # tighten clusters by small covariance
                cov = np.eye(num_features) * cov_scale
                defs[algo][step_idx][lbl] = (center, cov)
    return defs

def sample_label(current_label, step, rng):
    if step['type'] == 'independent':
        return rng.choice(step['clusters'], p=step['probs'])
    lbls, probs = step['transitions'].get(
        current_label,
        ([l for lbls, _ in step['transitions'].values() for l in lbls], None)
    )
    return rng.choice(lbls, p=probs) if probs is not None else rng.choice(lbls)

def generate_toy_data(settings):
    rng = np.random.RandomState(settings['random_seed'])
    pipeline = [
        {'type':'independent', 'clusters':['A1','A2'],              'probs':[0.7,0.3]},
        {'type':'conditional','transitions':{
            'A1':(['B1','B2'],[0.5,0.5]),
            'A2':(['B1','B2'],[0.5,0.5])
        }},
        {'type':'independent', 'clusters':['C'],                     'probs':[1.0]},
        {'type':'independent', 'clusters':['D','random'],            'probs':[0.5,0.5]},
    ]
    cluster_defs = build_cluster_defs(
        num_algorithms=settings['num_algorithms'],
        pipeline=pipeline,
        num_features=settings['num_features'],
        center_scale=settings['center_scale'],
        cov_scale=settings['cov_scale'],
        random_state=settings['random_seed']
    )

    records, feats, metas = [], [], []
    traj_id = 0
    last_step = len(pipeline) - 1

    for algo in range(settings['num_algorithms']):
        low_t, high_t = settings['trajectories_per_algo_range']
        for _ in range(rng.randint(low_t, high_t)):
            low_s, high_s = settings['steps_per_trajectory_range']
            n_steps = rng.randint(low_s, high_s)
            current_label = 'start'

            for step_idx in range(n_steps):
                # sample raw state label
                if step_idx < len(pipeline):
                    raw_label = sample_label(current_label, pipeline[step_idx], rng)
                else:
                    raw_label = current_label

                # construct unique label name
                label_name = f"algo{algo}_step{step_idx}_{raw_label}"

                # sample high-dimensional features
                if raw_label == 'random':
                    fv = rng.randn(settings['num_features'])
                else:
                    use_step = step_idx if step_idx <= last_step else last_step
                    center, cov = cluster_defs[algo][use_step][raw_label]
                    fv = rng.multivariate_normal(center, cov)

                # sample metadata
                mv = rng.randn(settings['num_metadata'])

                # determine next action
                if step_idx < n_steps - 1:
                    next_idx = min(step_idx + 1, last_step)
                    raw_next = sample_label(raw_label, pipeline[next_idx], rng)
                    action_name = f"algo{algo}_step{step_idx+1}_to_{raw_next}"
                else:
                    action_name = ''

                records.append({
                    'line':   traj_id,
                    'algo':   algo,
                    'label':  label_name,
                    'action': action_name
                })
                feats.append(fv)
                metas.append(mv)
                current_label = raw_label

            traj_id += 1

    feats_arr = np.vstack(feats)
    metas_arr = np.vstack(metas)

    reducer = UMAP(
        n_components=2,
        n_neighbors=settings['umap_n_neighbors'],
        min_dist=settings['umap_min_dist'],
        random_state=settings['random_seed']
    )
    coords = reducer.fit_transform(feats_arr)
    xs, ys = coords[:,0], coords[:,1]

    df = pd.DataFrame(records)
    df['x'], df['y'] = xs, ys

    # append feature columns
    for i in range(settings['num_features']):
        df[f'feature{i+1}'] = feats_arr[:, i]
    # append metadata columns
    for j in range(settings['num_metadata']):
        df[f'metadata{j+1}'] = metas_arr[:, j]

    cols = ['x','y','line','algo','label','action']
    cols += [f'feature{i+1}' for i in range(settings['num_features'])]
    cols += [f'metadata{j+1}' for j in range(settings['num_metadata'])]
    return df[cols]

def main():
    p = argparse.ArgumentParser("Generate denser, uniquely labeled toy trajectory data")
    p.add_argument('--min_trajectories',   type=int,   default=5)
    p.add_argument('--max_trajectories',   type=int,   default=10)
    p.add_argument('--min_steps',          type=int,   default=3)
    p.add_argument('--max_steps',          type=int,   default=5)
    p.add_argument('--num_algorithms',     type=int,   default=2)
    p.add_argument('--num_features',       type=int,   default=10)
    p.add_argument('--num_metadata',       type=int,   default=2)
    p.add_argument('--center_scale',       type=float, default=5.0,
                   help="separation between cluster centers")
    p.add_argument('--cov_scale',          type=float, default=0.1,
                   help="tightness of each cluster")
    p.add_argument('--umap_n_neighbors',   type=int,   default=15,
                   help="UMAP n_neighbors (smaller for tighter local clusters)")
    p.add_argument('--umap_min_dist',      type=float, default=0.1,
                   help="UMAP min_dist (smaller for denser embedding)")
    p.add_argument('--random_seed',        type=int,   default=42)
    p.add_argument('--start_dist',         choices=['same','random','cluster'], default='same')
    p.add_argument('--end_dist',           choices=['same','random','cluster'], default='same')
    p.add_argument('--output_file',        type=str,   default='toy_data.csv')
    args = p.parse_args()

    settings = {
        'trajectories_per_algo_range': (args.min_trajectories, args.max_trajectories + 1),
        'steps_per_trajectory_range':   (args.min_steps,       args.max_steps       + 1),
        'num_algorithms':               args.num_algorithms,
        'num_features':                 args.num_features,
        'num_metadata':                 args.num_metadata,
        'center_scale':                 args.center_scale,
        'cov_scale':                    args.cov_scale,
        'umap_n_neighbors':             args.umap_n_neighbors,
        'umap_min_dist':                args.umap_min_dist,
        'random_seed':                  args.random_seed,
        'start_distribution':           args.start_dist,
        'end_distribution':             args.end_dist,
    }

    df = generate_toy_data(settings)
    df.to_csv(args.output_file, index=False)
    print(f"Wrote {len(df)} points to {args.output_file}")

if __name__ == '__main__':
    main()
