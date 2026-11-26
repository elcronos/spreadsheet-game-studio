"""Write planning: dirty mask -> the fewest spreadsheet calls.

Two strategies (references/protocol.md):

* ``values-cf``: GAME cells hold palette indices; one conditional-format rule
  per palette entry colours them. A frame becomes a few bulk value writes over
  rectangular *bands* (``plan_bands``).
* ``interior``: cells get a direct fill colour. Cells of one colour are
  grouped into rectangles (``plan_colour_rects``) and set with one call per
  colour (Calc: XSheetCellRanges; Excel: multi-area Range address strings of
  at most 255 characters, ``chunk_addresses``).

Everything here is pure numpy/Python so it is unit-tested on Linux and shared
by the mock, Calc and Excel sinks.
"""
from __future__ import annotations

from typing import Dict, List, Sequence, Tuple

import numpy as np

from .layout import column_name

Span = Tuple[int, int, int]  # row, x0, x1 (exclusive)
Rect = Tuple[int, int, int, int]  # r0, r1, c0, c1 (r1/c1 exclusive), 0-based frame coords


def row_spans(dirty: np.ndarray) -> List[Span]:
    """Contiguous True spans per row of a (h, w) bool mask, row-major order."""
    if not dirty.any():
        return []
    h, w = dirty.shape
    d = np.zeros((h, w + 2), dtype=np.int8)
    d[:, 1:-1] = dirty
    e = np.diff(d, axis=1)
    sr, sc = np.nonzero(e == 1)
    er, ec = np.nonzero(e == -1)
    # np.nonzero is row-major, so starts and ends pair up in order
    return list(zip(sr.tolist(), sc.tolist(), ec.tolist()))


def merge_gaps(spans: Sequence[Span], gap: int) -> List[Span]:
    """Merge spans on the same row separated by <= gap clean cells."""
    out: List[Span] = []
    for r, a, b in spans:
        if out and out[-1][0] == r and a - out[-1][2] <= gap:
            out[-1] = (r, out[-1][1], b)
        else:
            out.append((r, a, b))
    return out


def plan_bands(spans: Sequence[Span], call_cost: int = 600) -> List[Rect]:
    """Group dirty spans into rectangles for bulk value writes.

    ``call_cost`` is the cost of one extra call expressed in cells: a span is
    merged into an adjacent band when that writes at most ``call_cost``
    redundant (clean) cells. Clean cells are rewritten from the bridge's
    shadow, so over-writing is always safe.
    """
    spans = merge_gaps(spans, call_cost)
    closed: List[Rect] = []
    # open band: [r0, r1, c0, c1, area]
    open_: List[List[int]] = []
    i = 0
    n = len(spans)
    while i < n:
        r = spans[i][0]
        row = []
        while i < n and spans[i][0] == r:
            row.append(spans[i])
            i += 1
        used = set()
        for _, a, b in row:
            best, best_extra = -1, None
            for k, band in enumerate(open_):
                if k in used or band[1] != r:
                    continue
                nc0, nc1 = min(band[2], a), max(band[3], b)
                extra = (r + 1 - band[0]) * (nc1 - nc0) - (band[4] + (b - a))
                if best_extra is None or extra < best_extra:
                    best, best_extra = k, extra
            if best >= 0 and best_extra is not None and best_extra <= call_cost:
                band = open_[best]
                band[2], band[3] = min(band[2], a), max(band[3], b)
                band[1] = r + 1
                band[4] = (band[1] - band[0]) * (band[3] - band[2])
                used.add(best)
            else:
                open_.append([r, r + 1, a, b, b - a])
                used.add(len(open_) - 1)
        still = []
        for band in open_:
            if band[1] == r + 1:
                still.append(band)
            else:
                closed.append((band[0], band[1], band[2], band[3]))
        open_ = still
    closed.extend((b[0], b[1], b[2], b[3]) for b in open_)
    return _merge_bands(closed, call_cost)


def _merge_bands(bands: List[Rect], call_cost: int) -> List[Rect]:
    """Second pass: merge bands (also across clean rows) while each merge wastes <= call_cost
    cells, then fall back to the single bounding rectangle when that is cheaper overall."""
    if len(bands) <= 1:
        return bands
    bands = sorted(bands)
    changed = True
    while changed and len(bands) > 1:
        changed = False
        out: List[Rect] = [bands[0]]
        for b in bands[1:]:
            a = out[-1]
            u = (min(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), max(a[3], b[3]))
            # overlapping bands always merge (writes come from the shadow, so overlap is only waste)
            overlap = a[0] < b[1] and b[0] < a[1] and a[2] < b[3] and b[2] < a[3]
            waste = (u[1] - u[0]) * (u[3] - u[2]) - (a[1] - a[0]) * (a[3] - a[2]) - (b[1] - b[0]) * (b[3] - b[2])
            if overlap or waste <= call_cost:
                out[-1] = u
                changed = True
            else:
                out.append(b)
        bands = out
    cost = len(bands) * call_cost + sum((r1 - r0) * (c1 - c0) for r0, r1, c0, c1 in bands)
    bb = (min(b[0] for b in bands), max(b[1] for b in bands), min(b[2] for b in bands), max(b[3] for b in bands))
    if call_cost + (bb[1] - bb[0]) * (bb[3] - bb[2]) <= cost:
        return [bb]
    return bands


def plan_colour_rects(target: np.ndarray, dirty: np.ndarray) -> Dict[int, List[Rect]]:
    """Dirty cells -> {palette index: [rects]} with same-colour cells grouped.

    Horizontal segments of equal index inside dirty spans are found
    vectorised, then identical segments on consecutive rows are merged into
    taller rectangles.
    """
    if not dirty.any():
        return {}
    h, w = target.shape
    t = target.astype(np.int16)
    left_t = np.full_like(t, -1)
    left_t[:, 1:] = t[:, :-1]
    left_d = np.zeros_like(dirty)
    left_d[:, 1:] = dirty[:, :-1]
    start = dirty & (~left_d | (t != left_t))
    right_t = np.full_like(t, -1)
    right_t[:, :-1] = t[:, 1:]
    right_d = np.zeros_like(dirty)
    right_d[:, :-1] = dirty[:, 1:]
    end = dirty & (~right_d | (t != right_t))
    sr, sc = np.nonzero(start)
    er, ec = np.nonzero(end)
    ec = ec + 1
    col = target[sr, sc].astype(np.int32)
    # vertical merge: sort by (colour, x0, x1, row); consecutive rows with identical (colour, x0, x1) join
    order = np.lexsort((sr, ec, sc, col))
    c_, a_, b_, r_ = col[order], sc[order], ec[order], sr[order]
    same = np.zeros(len(order), dtype=bool)
    if len(order) > 1:
        same[1:] = (c_[1:] == c_[:-1]) & (a_[1:] == a_[:-1]) & (b_[1:] == b_[:-1]) & (r_[1:] == r_[:-1] + 1)
    gid = np.cumsum(~same) - 1
    ng = int(gid[-1]) + 1
    first = np.flatnonzero(~same)
    last = np.empty(ng, dtype=np.int64)
    last[:-1] = first[1:] - 1
    last[-1] = len(order) - 1
    out: Dict[int, List[Rect]] = {}
    for g in range(ng):
        f, l = first[g], last[g]
        out.setdefault(int(c_[f]), []).append((int(r_[f]), int(r_[l]) + 1, int(a_[f]), int(b_[f])))
    return out


def rects_cells(rects: Sequence[Rect]) -> int:
    return sum((r1 - r0) * (c1 - c0) for r0, r1, c0, c1 in rects)


def rect_address(rect: Rect, origin_row0: int, origin_col0: int) -> str:
    """0-based frame rect -> sheet A1 address ('A4:C6' / 'B7')."""
    r0, r1, c0, c1 = rect
    a = f"{column_name(c0 + origin_col0)}{r0 + origin_row0 + 1}"
    if r1 - r0 == 1 and c1 - c0 == 1:
        return a
    return f"{a}:{column_name(c1 - 1 + origin_col0)}{r1 + origin_row0}"


def chunk_addresses(rects: Sequence[Rect], origin_row0: int, origin_col0: int, limit: int = 255) -> List[str]:
    """Join rect addresses with ',' into strings of at most ``limit`` chars (Excel Range() limit)."""
    out: List[str] = []
    cur: List[str] = []
    cur_len = 0
    for rect in rects:
        a = rect_address(rect, origin_row0, origin_col0)
        add = len(a) + (1 if cur else 0)
        if cur and cur_len + add > limit:
            out.append(",".join(cur))
            cur, cur_len = [], 0
            add = len(a)
        cur.append(a)
        cur_len += add
    if cur:
        out.append(",".join(cur))
    return out


def parse_address_list(addr: str) -> List[Tuple[int, int, int, int]]:
    """'A4:B5,C7' -> [(r0, r1, c0, c1)] 1-based inclusive. Used by the mock to verify Excel plans."""
    out = []
    for part in addr.split(","):
        ends = part.split(":")
        cells = []
        for e in ends:
            e = e.replace("$", "")
            i = 0
            while i < len(e) and e[i].isalpha():
                i += 1
            col = 0
            for ch in e[:i].upper():
                col = col * 26 + (ord(ch) - 64)
            cells.append((int(e[i:]), col))
        (ra, ca), (rb, cb) = cells[0], cells[-1]
        out.append((min(ra, rb), max(ra, rb), min(ca, cb), max(ca, cb)))
    return out


def rgb_to_bgr(c: int) -> int:
    """0xRRGGBB -> Excel Interior.Color (R + G*256 + B*65536)."""
    return ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF)


def bgr_to_rgb(c: int) -> int:
    return rgb_to_bgr(c)
