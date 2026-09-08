import copy
import os
import sys

# preprocess_dataset_generate_knng.py lives in the repo-level data-prep script
# collection (scripts/data-prep/, moved out of packages/app/public/data/ in the
# 2026-08 packages restructure).
sys.path.insert(
    0,
    os.path.abspath(
        os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "data-prep")
    ),
)

from preprocess_dataset_generate_knng import (
    assign_bboxes_recursive,
    assign_bboxes_iterative,
)


def build_simple_tree():
    leaf0 = {
        "id": 0,
        "children": [0],
        "distance": 0,
        "size": 1,
        "stability": 0,
        "birthDistance": 0,
        "leftChild": None,
        "rightChild": None,
    }
    leaf1 = {
        "id": 1,
        "children": [1],
        "distance": 0,
        "size": 1,
        "stability": 0,
        "birthDistance": 0,
        "leftChild": None,
        "rightChild": None,
    }
    leaf2 = {
        "id": 2,
        "children": [2],
        "distance": 0,
        "size": 1,
        "stability": 0,
        "birthDistance": 0,
        "leftChild": None,
        "rightChild": None,
    }
    internal = {
        "id": 3,
        "children": [0, 1],
        "distance": 0,
        "size": 2,
        "stability": 0,
        "birthDistance": 0,
        "leftChild": leaf0,
        "rightChild": leaf1,
    }
    root = {
        "id": 4,
        "children": [0, 1, 2],
        "distance": 0,
        "size": 3,
        "stability": 0,
        "birthDistance": 0,
        "leftChild": internal,
        "rightChild": leaf2,
    }
    return root


def collect_bboxes(node):
    boxes = {}
    stack = [node]
    while stack:
        n = stack.pop()
        boxes[n["id"]] = n.get("bbox")
        if n.get("leftChild"):
            stack.append(n["leftChild"])
        if n.get("rightChild"):
            stack.append(n["rightChild"])
    return boxes


def test_iterative_matches_recursive():
    data_records = [
        {"x": 0.0, "y": 0.0},
        {"x": 1.0, "y": 1.0},
        {"x": 2.0, "y": 0.0},
    ]
    tree_rec = build_simple_tree()
    tree_it = copy.deepcopy(tree_rec)

    assign_bboxes_recursive(tree_rec, data_records)
    assign_bboxes_iterative(tree_it, data_records)

    bboxes_rec = collect_bboxes(tree_rec)
    bboxes_it = collect_bboxes(tree_it)
    assert bboxes_rec == bboxes_it
