#!/usr/bin/env python3
"""
Add an `action` column to a chess CSV by inferring the SAN move
between consecutive positions within each `line` (trajectory).

Usage:
  python add_action_moves.py IN_CSV OUT_CSV

Dependencies:
  pip install pandas python-chess
"""

import sys
import re
import argparse
import pandas as pd
from typing import Dict, Optional, Tuple, List

try:
    import chess
except Exception:
    print("This script requires 'python-chess'. Install:\n  pip install python-chess", file=sys.stderr)
    raise

# Squares in file-major order per rank: a8..h8, a7..h7, ..., a1..h1
FILES = "abcdefgh"
RANKS = "87654321"
SQUARES = [f"{f}{r}" for r in RANKS for f in FILES]

LETTER_TO_TYPE = {
    "p": chess.PAWN,
    "n": chess.KNIGHT,
    "b": chess.BISHOP,
    "r": chess.ROOK,
    "q": chess.QUEEN,
    "k": chess.KING,
}
TYPE_TO_LETTER = {v: k for k, v in LETTER_TO_TYPE.items()}


def norm_code(val) -> str:
    if pd.isna(val):
        return ""
    s = str(val).strip().lower()
    return "" if s in {"", "none", "nan"} else s


def row_to_map(row: pd.Series) -> Dict[str, str]:
    return {sq: norm_code(row.get(sq, "")) for sq in SQUARES}


def board_from_map(board_map: Dict[str, str], turn_color: bool) -> "chess.Board":
    try:
        board = chess.Board.empty()  # type: ignore[attr-defined]
    except Exception:
        board = chess.Board(None)
    board.clear_stack()
    board.turn = turn_color
    try:
        board.clear_castling_rights()
    except Exception:
        board.castling_rights = chess.BB_EMPTY
    board.ep_square = None
    board.halfmove_clock = 0
    board.fullmove_number = 1

    for sq, code in board_map.items():
        if not code:
            continue
        color = chess.WHITE if code[0] == "w" else chess.BLACK
        ptype = LETTER_TO_TYPE.get(code[1])
        if ptype is None:
            continue
        board.set_piece_at(chess.parse_square(sq), chess.Piece(ptype, color))
    return board


def board_to_map(board: "chess.Board") -> Dict[str, str]:
    out: Dict[str, str] = {}
    for sq_name in SQUARES:
        sq = chess.parse_square(sq_name)
        p = board.piece_at(sq)
        if p is None:
            out[sq_name] = ""
        else:
            out[sq_name] = ("w" if p.color == chess.WHITE else "b") + TYPE_TO_LETTER[p.piece_type]
    return out


def maps_equal(a: Dict[str, str], b: Dict[str, str]) -> bool:
    for sq in SQUARES:
        if a.get(sq, "") != b.get(sq, ""):
            return False
    return True


def find_diff_squares(a: Dict[str, str], b: Dict[str, str]) -> List[str]:
    return [sq for sq in SQUARES if a.get(sq, "") != b.get(sq, "")]


def detect_castling_san(cur_map: Dict[str, str], nxt_map: Dict[str, str]) -> Optional[str]:
    def king_sq(m: Dict[str, str], color: str) -> Optional[str]:
        target = f"{color}k"
        for sq in SQUARES:
            if m[sq] == target:
                return sq
        return None

    wk_from, wk_to = king_sq(cur_map, "w"), king_sq(nxt_map, "w")
    bk_from, bk_to = king_sq(cur_map, "b"), king_sq(nxt_map, "b")

    if wk_from == "e1" and wk_to == "g1" and cur_map.get("h1") == "wr" and nxt_map.get("f1") == "wr" and nxt_map.get("h1") == "":
        return "O-O"
    if wk_from == "e1" and wk_to == "c1" and cur_map.get("a1") == "wr" and nxt_map.get("d1") == "wr" and nxt_map.get("a1") == "":
        return "O-O-O"
    if bk_from == "e8" and bk_to == "g8" and cur_map.get("h8") == "br" and nxt_map.get("f8") == "br" and nxt_map.get("h8") == "":
        return "O-O"
    if bk_from == "e8" and bk_to == "c8" and cur_map.get("a8") == "br" and nxt_map.get("d8") == "br" and nxt_map.get("a8") == "":
        return "O-O-O"
    return None


def sq_file_rank(sq: str) -> Tuple[int, int]:
    return ord(sq[0]) - ord("a"), int(sq[1]) - 1


def algebraic(f: int, r: int) -> str:
    return f"{chr(ord('a') + f)}{r + 1}"


def detect_en_passant_san(cur_map: Dict[str, str], nxt_map: Dict[str, str]) -> Optional[str]:
    diffs = find_diff_squares(cur_map, nxt_map)
    # Typical EP: exactly three changed squares (from, to, captured pawn square)
    if len(diffs) < 3 or len(diffs) > 4:
        return None

    # Candidate destination where a pawn appears
    to_sq = next((sq for sq in diffs if nxt_map[sq] in {"wp", "bp"} and cur_map[sq] == ""), None)
    if not to_sq:
        return None
    mover = nxt_map[to_sq]
    color = mover[0]

    # From-square where same-color pawn disappeared
    from_sq = next((sq for sq in diffs if cur_map[sq] == mover and nxt_map[sq] == ""), None)
    if not from_sq:
        return None

    f_from, r_from = sq_file_rank(from_sq)
    f_to, r_to = sq_file_rank(to_sq)

    # Diagonal single-step and destination was empty before
    if abs(f_from - f_to) != 1 or cur_map[to_sq] != "":
        return None
    if color == "w" and r_to - r_from != 1:
        return None
    if color == "b" and r_from - r_to != 1:
        return None

    # Captured pawn should be behind the destination on same file
    cap_sq = algebraic(f_to, r_to - 1) if color == "w" else algebraic(f_to, r_to + 1)
    if cur_map.get(cap_sq) != ("bp" if color == "w" else "wp"):
        return None
    if nxt_map.get(cap_sq) != "":
        return None

    return f"{from_sq[0]}x{to_sq}"


def simple_san_from_diff(cur_map: Dict[str, str], nxt_map: Dict[str, str]) -> Optional[str]:
    diffs = find_diff_squares(cur_map, nxt_map)
    from_sq, to_sq, mover = None, None, None
    for sq in diffs:
        a, b = cur_map[sq], nxt_map[sq]
        if a and not b and from_sq is None:
            from_sq, mover = sq, a
        if b and a != b:
            to_sq = sq
    if not from_sq or not to_sq or not mover:
        return None

    moved_letter = mover[1]
    capture = cur_map[to_sq] != ""

    # Promotion detection
    promo = ""
    if moved_letter == "p":
        dest_code = nxt_map[to_sq]
        if dest_code and dest_code[0] == mover[0] and dest_code[1] != "p":
            promo = "=" + dest_code[1].upper()

    if moved_letter == "p":
        return (f"{from_sq[0]}x{to_sq}" if capture else f"{to_sq}") + promo
    else:
        return f"{moved_letter.upper()}{'x' if capture else ''}{to_sq}"


def infer_san(cur_map: Dict[str, str], nxt_map: Dict[str, str]) -> str:
    # 1) Try full rules with python-chess for either side to move
    for turn in (chess.WHITE, chess.BLACK):
        board = board_from_map(cur_map, turn)
        for mv in list(board.legal_moves):
            test_board = board.copy(stack=False)
            test_board.push(mv)
            if maps_equal(board_to_map(test_board), nxt_map):
                try:
                    return board.san(mv)
                except Exception:
                    pass

    # 2) Explicit castling
    castle = detect_castling_san(cur_map, nxt_map)
    if castle:
        return castle

    # 3) Explicit en passant
    ep = detect_en_passant_san(cur_map, nxt_map)
    if ep:
        return ep

    # 4) Fallback diff-based SAN
    simple = simple_san_from_diff(cur_map, nxt_map)
    return simple or ""


def process(df: pd.DataFrame) -> pd.DataFrame:
    if "line" not in df.columns:
        raise ValueError("CSV must contain a 'line' column to identify trajectories.")
    actions: Dict[int, str] = {}

    for _, g in df.groupby("line", sort=False):
        idxs = list(g.index)
        for i in range(len(idxs) - 1):
            idx_cur, idx_nxt = idxs[i], idxs[i + 1]
            cur_map = row_to_map(df.loc[idx_cur])
            nxt_map = row_to_map(df.loc[idx_nxt])
            actions[idx_cur] = infer_san(cur_map, nxt_map)
        if idxs:
            actions[idxs[-1]] = ""

    out = df.copy()
    out["action"] = pd.Series(actions)
    return out


def drop_spurious_index_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Drop CSV-index artifacts like 'Unnamed: 0' **only** if they look like a saved
    positional index (0..n-1). If values are non-sequential or meaningful, keep them.
    """
    candidates = [c for c in df.columns if re.match(r"^Unnamed:\s*\d+$", str(c)) or c == ""]
    if not candidates:
        return df

    n = len(df)
    expected = pd.RangeIndex(start=0, stop=n, step=1)
    to_drop: List[str] = []
    for c in candidates:
        s = pd.to_numeric(df[c], errors="coerce")
        # Accept strings like "0","1",... and ints; require exact match with 0..n-1
        if s.notna().all() and (s.astype("Int64").tolist() == list(expected)):
            to_drop.append(c)

    if to_drop:
        print(f"Dropping spurious index column(s): {to_drop}", file=sys.stderr)
        df = df.drop(columns=to_drop)
    return df


def main():
    ap = argparse.ArgumentParser(description="Add SAN `action` column to chess CSV (grouped by `line`).")
    ap.add_argument("in_csv")
    ap.add_argument("out_csv")
    args = ap.parse_args()

    # Read everything as strings to preserve piece codes exactly.
    df = pd.read_csv(args.in_csv, dtype=str, keep_default_na=True)
    df = drop_spurious_index_columns(df)

    out = process(df)
    # Never write a DataFrame index as a column
    out.to_csv(args.out_csv, index=False)
    print(f"Wrote: {args.out_csv}")


if __name__ == "__main__":
    main()
