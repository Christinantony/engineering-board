#!/usr/bin/env python3
"""
drawing_to_dcl.py - Build a Dimension Checklist (DCL) from a vector CAD drawing PDF.

Requires:  Python 3.14, pymupdf, python-docx and openpyxl
           (py -3.14 -m pip install pymupdf python-docx openpyxl)
For drawings without selectable text also:     py -3.14 -m pip install rapidocr onnxruntime

Usage examples:
    py -3.14 drawing_to_dcl.py drawing.pdf                     # -> drawing.docx
    py -3.14 drawing_to_dcl.py drawing.pdf --format xlsx       # -> drawing.xlsx  (both: .docx and .xlsx)
    py -3.14 drawing_to_dcl.py drawing.pdf -o checklist.xlsx
    py -3.14 drawing_to_dcl.py drawing.pdf --project "ISRO" --weight "1822 ± 10 g"   # project: else from the drawing number
    py -3.14 drawing_to_dcl.py drawing.pdf --part-no "JL 18 T1AZ-01D"
    py -3.14 drawing_to_dcl.py folder_with_pdfs/               # batch convert

Best input is a vector PDF exported from CAD (text selectable). A page without
selectable text - a scan, or a SolidWorks/AutoCAD sheet sent through "Microsoft
Print to PDF", which turns every letter into lines - is read with OCR instead.
The page is turned upright first (sideways sheets are detected; --rotate overrides).
What is read:
  - Title block: title (PART NAME), drawing number, revision, material and the
    general tolerance table (WITHOUT DECIMAL / ONE DECIMAL / TWO DECIMAL / ANGLE).
  - Zone grid: the 8..1 / G..A labels on the border give each dimension its zone (e.g. C5).
  - Dimensions: plain values, Ø (also when Ø is drawn as lines, not text), R, SR,
    angles, chamfers, inline (±0.1, +0.1/-0.2) and stacked tolerances. A leading
    '*' marks a key characteristic. Dimensions without a tolerance get the
    general tolerance for their number of decimals.
  - Hole/thread callouts (TAP, THRU, DEEP, HELICOIL, CB, CSK, M6x1.0 ...) become
    "VERIFY ..." rows, and their diameters and depths get numbered rows too.
Skipped: border, title block, revision table, CL marks, section/view labels,
reference dimensions in brackets, and general notes (listed on screen so you can
check them).
"""

import argparse
import bisect
import re
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path

try:
    import pymupdf
except ImportError:
    sys.exit("Missing dependency 'pymupdf'. Install with:  py -3.14 -m pip install pymupdf")
try:
    from openpyxl import Workbook
    from openpyxl.cell.rich_text import CellRichText, TextBlock
    from openpyxl.cell.text import InlineFont
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("Missing dependency 'openpyxl'. Install with:  py -3.14 -m pip install openpyxl")

COMPANY = "VERDANT TELEMETRY & ANTENNA SYSTEMS Pvt Ltd  COCHIN 682013 INDIA."
FORM_ID = "VT-F-DCL -01  REV.00"
DEFAULT_LOGO = Path(__file__).with_name("verdant_logo.png")
DEFAULT_GENERAL_TOL = {0: "±1", 1: "±0.1", 2: "±0.05", "angle": "±½°"}

DIM_RE = re.compile(r"""^(?P<kc>\*)?\s*
    (?P<qty>\d+\s*[xX](?:\s+|(?=[ØRS])))?
    (?P<pre>SØ|Ø|SR|R)?\s*
    (?P<val>\d+(?:\.\d+)?|\.\d+)
    (?P<deg>°)?
    \s*(?P<tol>±\s*\d*\.?\d+°?|[+-]?\s*\d*\.?\d+\s*/\s*[+-]?\s*\d*\.?\d+|\?)?
    \s*(?P<suf>\(?TYP\.?\)?)?$""", re.X | re.I)
CHAMFER_RE = re.compile(r"^(?P<kc>\*)?\s*(?:C\s*(?P<c>\d+(?:\.\d+)?)|(?P<val>\d+(?:\.\d+)?)\s*[xX]\s*45°)$")
HOLE_RE = re.compile(r"\b(TAP|TAPPED|THRU|DEEP|DP|HELICOIL|C'?BORE|CB|CSK|C'?SINK|DRILL|HOLES?|REAM|UNC|UNF)\b|^\d*\s*[xX]?\s*M\d", re.I)
THREAD_RE = re.compile(r"\bM\d+(?:\.\d+)?(?:\s*x\s*\d+(?:\.\d+)?)?|\b\d+/\d+\s*-\s*\d+|#\d+\s*-\s*\d+", re.I)
CALLOUT_DIA_RE = re.compile(r"(?:\b(C'?BORE|CB|CSK|C'?SINK)\s*)?Ø\s*(\d+(?:\.\d+)?|\.\d+)", re.I)
CALLOUT_DEPTH_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:MM\s*)?(?:DEEP|DP)\b|(?:DEEP|DP|↧)\s*(\d+(?:\.\d+)?)", re.I)
IGNORE_RE = re.compile(r"^(CL|℄|[A-Z]|[A-Z]\s*-\s*[A-Z]|(SECTION|DETAIL|VIEW)\b.*|SCALE\b.*)$", re.I)
STACK_TOL_RE = re.compile(r"^[+\-±]?\s*\d*\.?\d+$")
TITLE_BLOCK_RE = re.compile(r"^(TOLERANCES?|MATERIAL|DRAWN|CHECKED|VERIFIED|APPROVED|SCALE|TITLE|DRAWING\s*NO|"
                            r"NEXT\s*ASSY|SIZE|SHEET|FINISH|(WITHOUT|ONE|TWO|THREE)\s*DECIMAL)\b", re.I)
REV_HEADER_RE = re.compile(r"^REVISION\b|^REV\.?\s*NO", re.I)
OCR_DPI = 300
OCR_MIN_SCORE = 0.75
TOL_ZOOM = 3   # stacked tolerances are re-rendered this many times finer than the OCR pass
OCR_CHARS = set(map(chr, range(32, 127))) | set("Ø°±½¼¾×–—µ")


@dataclass
class Piece:
    """One run of text on the page."""
    text: str
    rect: pymupdf.Rect
    size: float
    horizontal: bool
    page: int


@dataclass
class Item:
    """One row of the checklist."""
    kind: str        # "dim" or "note"
    text: str
    tol: str
    zone: str
    rect: pymupdf.Rect
    page: int
    order: tuple
    label: str = ""


def normalize(text: str) -> str:
    text = re.sub("[⌀∅ø]", "Ø", text).replace("×", "x").replace("−", "-").replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def ycenter(r: pymupdf.Rect) -> float:
    return (r.y0 + r.y1) / 2


# ---------------------------------------------------------------- reading the page

def read_pieces(page: pymupdf.Page, pno: int) -> list[Piece]:
    spans = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            horizontal = abs(line["dir"][1]) < 0.01 and line["dir"][0] > 0
            for s in line["spans"]:
                if s["text"].strip():
                    spans.append(Piece(normalize(s["text"]), pymupdf.Rect(s["bbox"]), s["size"], horizontal, pno))
    return merge_spans(spans)


def merge_spans(spans: list[Piece], ocr: bool = False) -> list[Piece]:
    """Join spans that sit next to each other on one baseline (CAD often splits '110.0', 'M6x1' etc.).
    OCR already returns whole lines, so its boxes are only joined when they touch or overlap."""
    chains: list[list[Piece]] = []
    for p in sorted(spans, key=lambda s: s.rect.x0):
        if p.horizontal:
            for chain in chains:
                last = chain[-1]
                size = max(last.size, p.size)
                same_size = abs(last.size - p.size) <= (0.35 if ocr else 0.15) * size or last.text == "*"
                gap = p.rect.x0 - last.rect.x1
                lo, hi = (-0.5 * size, 0.15 * size) if ocr else (-1, 0.8 * size)
                two_dims = ocr and " " in last.text and re.match(r"[ØR]?\d", p.text) and re.search(r"[\d?]$", last.text)
                if (last.horizontal and same_size and lo <= gap <= hi and not two_dims
                        and abs(ycenter(last.rect) - ycenter(p.rect)) < 0.35 * min(last.rect.height, p.rect.height)):
                    chain.append(p)
                    break
            else:
                chains.append([p])
        else:
            chains.append([p])
    merged = []
    for chain in chains:
        text, rect = chain[0].text, pymupdf.Rect(chain[0].rect)
        for prev, p in zip(chain, chain[1:]):
            text += (" " if ocr or p.rect.x0 - prev.rect.x1 > 0.25 * p.size else "") + p.text
            rect |= p.rect
        merged.append(Piece(text, rect, max(p.size for p in chain), chain[0].horizontal, chain[0].page))
    return merged


# ---------------------------------------------------------------- OCR (pages without selectable text)

_ocr_engine = None


def has_text(page: pymupdf.Page) -> bool:
    return len(re.sub(r"\s", "", page.get_text())) >= 20


def ocr_engine():
    global _ocr_engine
    if _ocr_engine is None:
        try:
            from rapidocr import RapidOCR
        except ImportError:
            sys.exit("This drawing has no selectable text and must be read with OCR. Install it with:\n"
                     "    py -3.14 -m pip install rapidocr onnxruntime")
        _ocr_engine = RapidOCR(params={"Global.log_level": "error"})
    return _ocr_engine


def turned(page: pymupdf.Page, rot: int) -> pymupdf.Document:
    """One-page document showing the page turned by rot degrees, so its lines (get_drawings)
    and its rendered image share one upright coordinate frame."""
    r = page.rect
    w, h = (r.height, r.width) if rot in (90, 270) else (r.width, r.height)
    doc = pymupdf.open()
    doc.new_page(width=w, height=h).show_pdf_page(pymupdf.Rect(0, 0, w, h), page.parent, page.number, rotate=rot)
    return doc


def ocr_image(page: pymupdf.Page, dpi: int):
    import numpy as np
    pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
    gray = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w)
    return np.stack([gray] * 3, axis=-1)


def ocr_lines(img, use_cls: bool = True) -> list[tuple]:
    """(4-corner box in pixels, text, score) per text line found."""
    res = ocr_engine()(img, use_cls=use_cls)
    return list(zip(res.boxes, res.txts, res.scores)) if res.txts else []


def detect_rotation(page: pymupdf.Page) -> int:
    """The turn (0/90/180/270) under which most text reads left to right. OCR runs without its
    upside-down classifier here, so text at the wrong angle reads as junk and scores low."""
    import numpy as np

    def score(rot):
        lines = ocr_lines(ocr_image(turned(page, rot)[0], 100), use_cls=False)
        return sum(s * len(t) for q, t, s in lines if s > 0.8 and np.ptp(q[:, 0]) > np.ptp(q[:, 1]))
    return max((0, 90, 180, 270), key=score)


def ocr_fix(text: str) -> str:
    text = normalize(re.sub("[Φφ]", "Ø", text))
    text = re.sub(r"(?<=[\dØ])[Oo]|(?<![A-Za-z])[Oo](?=\.?\d)", "0", text)   # letter O read inside a number
    return re.sub(r"\b(HOLES?)\s+(?=\d)", r"\1 Ø", text)                      # Ø lost in '4 HOLES Ø4.5'


NUM_TOKEN_RE = re.compile(r"[ØR]?\d+(?:\.\d+)?°?")
TOL_VALUE_RE = re.compile(r"[+\-±]?\d*\.?\d+")


def ocr_crop(gray, up: int) -> str:
    """OCR one small grayscale crop, enlarged and padded - tiny tolerance digits need it."""
    import cv2
    import numpy as np
    g = cv2.copyMakeBorder(cv2.resize(gray, None, fx=up, fy=up, interpolation=cv2.INTER_CUBIC), 12, 12, 12, 12,
                           cv2.BORDER_CONSTANT, value=255)
    res = ocr_engine()(np.stack([g] * 3, axis=-1), use_cls=False)
    return " ".join(res.txts) if res.txts else ""


def lone_zero(gray) -> bool:
    """A single glyph that is a round ring with a centred hole: the '0' of a '+1 / 0' tolerance,
    which OCR cannot read on its own."""
    import cv2
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    cnts, hier = cv2.findContours(bw, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_SIMPLE)
    outer = [i for i, h in enumerate(hier[0]) if h[3] < 0 and cv2.contourArea(cnts[i]) >= 3] if hier is not None else []
    if len(outer) != 1:
        return False
    x, y, w, h = cv2.boundingRect(cnts[outer[0]])
    holes = [cnts[i] for i, hh in enumerate(hier[0]) if hh[3] == outer[0]]
    if len(holes) != 1 or not 0.4 <= w / h <= 0.9:
        return False
    hx, hy, hw, hh_ = cv2.boundingRect(holes[0])
    return abs(hx + hw / 2 - (x + w / 2)) < 0.15 * w and abs(hy + hh_ / 2 - (y + h / 2)) < 0.15 * h


def read_tolerance_row(row, first: bool, max_dec: int = 9) -> str | None:
    """One line of a stacked tolerance ('+0.5', '-0.2', '0.0', '0'), read several ways and voted on."""
    import cv2
    import numpy as np
    from collections import Counter
    votes = Counter()
    for up, erode in ((4, 0), (6, 0), (8, 0), (4, 1), (6, 1), (8, 1), (5, 0), (5, 1), (10, 0), (10, 2), (12, 2)):
        g = cv2.erode(row, np.ones((2, 2), np.uint8)) if erode == 1 else row
        if erode == 2:   # soften the jagged edges of a very small crop
            g = cv2.GaussianBlur(row, (3, 3), 0)
        t = ocr_crop(g, up).replace(" ", "").replace(",", ".").replace("−", "-").replace("—", "-").replace("–", "-")
        t = re.sub(r"(?<![A-Za-z])[Oo]", "0", t)
        if TOL_VALUE_RE.fullmatch(t) and len(t.partition(".")[2]) <= max_dec:   # a tolerance is never finer than its value
            if re.fullmatch(r"[+\-]?0\d", t):   # '-02' - the decimal point is too small to survive
                t = re.sub(r"(?<=0)(?=\d$)", ".", t)
            votes[t] += 1
    if votes:
        t = votes.most_common(1)[0][0]
    elif lone_zero(row):
        t = "0"
    else:
        return None
    if t[0] not in "+-±" and float(t) != 0:
        t = ("+" if first else "-") + t
    elif t[0] not in "+-±" and first:
        t = "+" + t
    return t


def split_stacked(gray, hires=None) -> tuple[str, str] | None:
    """A dimension printed as '4.0' with a small stacked tolerance ('+0.0' over '-0.2') to its right.
    OCR glues the tiny tolerance digits onto the value ('4.0.02', '3.505'), so the line is cut into
    big glyphs (the value) and small glyphs after them (the tolerance) and each part is read alone.
    hires(x0, y0, x1, y1) re-renders a box (given in gray's pixels) from the PDF at several times the
    resolution, so the tolerance digits are read from a sharp picture rather than an enlarged blur.
    Returns (value, tolerance) - tolerance '?' when it could not be read - or None if not stacked."""
    import cv2
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    n, _, st, _ = cv2.connectedComponentsWithStats(bw, 8)
    comps = [tuple(int(v) for v in st[i][:4]) for i in range(1, n) if st[i][4] >= 3]
    if len(comps) < 4:
        return None
    big = max(c[3] for c in comps)
    tall = [c for c in comps if c[3] >= 0.8 * big]
    edge = max(c[0] + c[2] for c in tall)
    small = [c for c in comps if c[0] >= edge - 1 and c[3] < 0.75 * big]
    if len(small) < 2:
        return None
    value = re.sub(r"[^0-9.ØRSx°]", "", ocr_crop(gray[:, :edge + 1], 3).replace(" ", ""))
    value = re.sub(r"^[^0-9ØR]+|[.]+$", "", value)
    if not NUM_TOKEN_RE.fullmatch(value):
        return None
    mid = (min(c[1] for c in small) + max(c[1] + c[3] for c in small)) / 2
    two_rows = (max(c[1] + c[3] for c in small) - min(c[1] for c in small)) > 1.4 * statistics.median(c[3] for c in small)
    rows = [[c for c in small if c[1] + c[3] / 2 < mid], [c for c in small if c[1] + c[3] / 2 >= mid]] if two_rows else [small]
    dec = len(value.partition(".")[2])
    parts = []
    for k, cs in enumerate(r for r in rows if r):
        x0, x1 = min(c[0] for c in cs) - 2, max(c[0] + c[2] for c in cs) + 2
        y0, y1 = min(c[1] for c in cs) - 2, max(c[1] + c[3] for c in cs) + 2
        x0, y0 = max(x0, 0), max(y0, 0)
        row = hires(x0, y0, x1, y1) if hires else None
        part = read_tolerance_row(row, k == 0, dec) if row is not None else None
        parts.append(part or read_tolerance_row(gray[y0:y1, x0:x1], k == 0, dec))
    if None in parts:
        return value, "?"
    return value, "/".join(parts)


def ocr_pieces(page: pymupdf.Page, pno: int) -> list[Piece]:
    """Text lines read by OCR from an upright page. A second pass on the image turned a quarter
    reads vertical dimensions left to right; where both passes found the same text, the better
    reading (score x length) is kept."""
    import numpy as np
    img = ocr_image(page, OCR_DPI)
    z, h = 72 / OCR_DPI, img.shape[0]
    found = [(q * z, t, s, True, q) for q, t, s in ocr_lines(img)]
    for q, t, s in ocr_lines(np.ascontiguousarray(np.rot90(img, -1))):
        if len(t.strip()) >= 2 and np.ptp(q[:, 0]) > 1.2 * np.ptp(q[:, 1]):   # a line along the page's vertical
            found.append((np.column_stack([q[:, 1], h - 1 - q[:, 0]]) * z, t, s, False, None))

    cands = []
    for q, t, s, first, px in found:
        t = ocr_fix(t)
        if first and s >= 0.4 and re.fullmatch(r"[\W_]*[ØR]?[\d.\s%+\-/]+[\W_]*", t):
            x0, y0, x1, y1 = (int(v) for v in (px[:, 0].min() - 2, px[:, 1].min() - 6, px[:, 0].max() + 2, px[:, 1].max() + 6))
            ox, oy = max(x0, 0), max(y0, 0)
            def hires(a, b, c, d, ox=ox, oy=oy):   # box in the crop's pixels -> sharp render, TOL_ZOOM x finer
                f = 72 / OCR_DPI
                clip = pymupdf.Rect((ox + a) * f, (oy + b) * f, (ox + c) * f, (oy + d) * f)
                pix = page.get_pixmap(dpi=OCR_DPI * TOL_ZOOM, clip=clip, colorspace=pymupdf.csGRAY)
                return np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w).copy()
            stacked = split_stacked(img[oy:y1, ox:x1, 0], hires)
            if stacked:   # '4.0.02' / '3.505' -> '4.0 +0.0/-0.2' / '3.5 +0.5/0.0'
                t, s = f"{stacked[0]} {stacked[1]}", max(s, 0.9)
        if s < OCR_MIN_SCORE or not re.search(r"[A-Za-z0-9]", t) or not set(t) <= OCR_CHARS:
            continue   # hole dots, crosshairs and other symbols read as letters
        rect = pymupdf.Rect(q[:, 0].min(), q[:, 1].min(), q[:, 0].max(), q[:, 1].max())
        dx, dy = q[1] - q[0]
        horizontal = bool(first and dx > 0 and abs(dy) < 0.1 * dx and (rect.width >= rect.height or len(t) < 3))
        side = min(np.hypot(*(q[1] - q[0])), np.hypot(*(q[3] - q[0])))
        size = float(rect.height if first and len(t) < 3 else side)
        words = t.split()
        if horizontal and len(words) > 1 and all(re.fullmatch(r"\d+(?:\.\d+)?", w) for w in words):
            x = rect.x0   # '2.0 2.0': two dimensions on one line - cut the box in proportion to their lengths
            for w in words:
                w_rect = pymupdf.Rect(x, rect.y0, x + rect.width * len(w) / (len(t) - len(words) + 1), rect.y1)
                x = w_rect.x1 + rect.width / (len(t) - len(words) + 1)
                cands.append((s * len(w), not first, Piece(w, w_rect, size, True, pno)))
            continue
        cands.append((s * len(t), not first, Piece(t, rect, size, horizontal, pno)))

    pieces: list[Piece] = []
    for _, _, p in sorted(cands, key=lambda c: (-c[0], c[1])):
        if all((p.rect & k.rect).get_area() <= 0.5 * min(p.rect.get_area(), k.rect.get_area()) for k in pieces):
            pieces.append(p)
    return merge_spans(pieces, ocr=True)


def diameter_marks(drawings: list[dict]) -> list[pymupdf.Rect]:
    """Small round outlines - CAD exports often draw the Ø symbol as lines instead of a font glyph."""
    marks = []
    for d in drawings:
        r = d["rect"]
        round_path = any(it[0] == "c" for it in d["items"]) or len(d["items"]) >= 6
        if round_path and 1.5 <= r.width <= 10 and abs(r.width - r.height) < 1.5:
            marks.append(r)
    return marks


def zone_ticks(drawings: list[dict], row_strips: list[tuple], col_strips: list[tuple],
               labels: list[pymupdf.Rect]) -> tuple[list[float], list[float]]:
    """x of the column-boundary ticks and y of the row-boundary ticks: short lines lying in the
    margin strips that hold the zone labels (left/right strips for rows, top/bottom for columns).
    Lines inside a label are its own strokes (text printed as lines), not ticks."""
    xs, ys = [], []
    boxes = [r + (-1, -1, 1, 1) for r in labels]
    for d in drawings:
        for it in d["items"]:
            if it[0] != "l":
                continue
            a, b = it[1], it[2]
            if any(r.contains((a + b) / 2) for r in boxes):
                continue
            if abs(a.y - b.y) < 0.5 and 2 < abs(a.x - b.x) < 40 and any(lo <= (a.x + b.x) / 2 <= hi for lo, hi in row_strips):
                ys.append(a.y)
            elif abs(a.x - b.x) < 0.5 and 2 < abs(a.y - b.y) < 40 and any(lo <= (a.y + b.y) / 2 <= hi for lo, hi in col_strips):
                xs.append(a.x)

    def dedupe(values):
        out = []
        for v in sorted(values):
            if not out or v - out[-1] > 1:
                out.append(v)
        return out
    return dedupe(xs), dedupe(ys)


def horizontal_lines(drawings: list[dict]) -> list[tuple[float, float, float]]:
    """(y, x_left, x_right) of every horizontal line, used to find the revision table rows."""
    lines = []
    for d in drawings:
        for it in d["items"]:
            if it[0] == "l" and abs(it[1].y - it[2].y) < 0.5:
                lines.append((it[1].y, min(it[1].x, it[2].x), max(it[1].x, it[2].x)))
            elif it[0] == "re":
                r = it[1]
                lines += [(r.y0, r.x0, r.x1), (r.y1, r.x0, r.x1)]
    return lines


# ---------------------------------------------------------------- sheet layout

class Sheet:
    """Zone grid, drawing frame, title block and revision table of one page."""

    def __init__(self, page: pymupdf.Page, pieces: list[Piece], drawings: list[dict]):
        W, H = page.rect.width, page.rect.height
        self.drawings = drawings
        top = [p for p in pieces if re.fullmatch(r"\d{1,2}", p.text) and p.rect.y1 < 0.1 * H]
        bottom = [p for p in pieces if re.fullmatch(r"\d{1,2}", p.text) and p.rect.y0 > 0.9 * H]
        left = [p for p in pieces if re.fullmatch(r"[A-Z]", p.text) and p.rect.x1 < 0.1 * W]
        right = [p for p in pieces if re.fullmatch(r"[A-Z]", p.text) and p.rect.x0 > 0.9 * W]
        self.cols = self._centers(top + bottom, lambda r: (r.x0 + r.x1) / 2)
        self.rows = self._centers(left + right, ycenter)
        # zone boundaries: the tick marks on the border, else halfway between the labels
        def strip(labels, lo, hi):
            m = 0.3 * statistics.median(p.rect.height for p in labels) if labels else 0
            return [(min(lo(p.rect) for p in labels) - m, max(hi(p.rect) for p in labels) + m)] if labels else []
        xs, ys = zone_ticks(drawings,
                            strip(left, lambda r: r.x0, lambda r: r.x1) + strip(right, lambda r: r.x0, lambda r: r.x1),
                            strip(top, lambda r: r.y0, lambda r: r.y1) + strip(bottom, lambda r: r.y0, lambda r: r.y1),
                            [p.rect for p in top + bottom + left + right])
        self.col_bounds = xs if len(xs) == len(self.cols) - 1 else [(a[0] + b[0]) / 2 for a, b in zip(self.cols, self.cols[1:])]
        self.row_bounds = ys if len(ys) == len(self.rows) - 1 else [(a[0] + b[0]) / 2 for a, b in zip(self.rows, self.rows[1:])]
        self.frame = pymupdf.Rect(
            max((p.rect.x1 for p in left), default=0), max((p.rect.y1 for p in top), default=0),
            min((p.rect.x0 for p in right), default=W), min((p.rect.y0 for p in bottom), default=H))

        inside = [p for p in pieces if self.frame.contains(pymupdf.Point(p.rect.x0 + 1, ycenter(p.rect)))]
        tb = [p for p in inside if TITLE_BLOCK_RE.match(p.text)]
        self.title_block = (pymupdf.Rect(min(p.rect.x0 for p in tb) - 4, min(p.rect.y0 for p in tb) - 4,
                                         self.frame.x1, self.frame.y1) if len(tb) >= 3 else pymupdf.Rect())
        self.rev_table = self._revision_table(inside)
        self.drawing_area = [p for p in inside if not self._excluded(p.rect)]
        self.title_pieces = [p for p in inside if self.title_block.contains(p.rect)]

    @staticmethod
    def _centers(labels, center):
        groups: dict[str, list[float]] = {}
        for p in labels:
            groups.setdefault(p.text, []).append(center(p.rect))
        return sorted((statistics.mean(v), k) for k, v in groups.items()) if len(groups) >= 2 else []

    def _revision_table(self, pieces) -> pymupdf.Rect:
        heads = [p for p in pieces if REV_HEADER_RE.match(p.text)]
        if not heads:
            return pymupdf.Rect()
        h = heads[0].rect
        row = [p for p in pieces if h.y0 - 2 <= ycenter(p.rect) <= h.y1 + 2]
        x0 = min(p.rect.x0 for p in row) - 6
        bottom, lines = max(p.rect.y1 for p in row), horizontal_lines(self.drawings)
        while True:   # follow the table's row lines downwards
            nxt = [y for y, a, b in lines if a <= x0 + 10 and b >= self.frame.x1 - 10 and bottom + 0.5 < y <= bottom + 25]
            if not nxt:
                break
            bottom = min(nxt)
        return pymupdf.Rect(x0, self.frame.y0, self.frame.x1, bottom + 1)

    def _excluded(self, r: pymupdf.Rect) -> bool:
        c = pymupdf.Point((r.x0 + r.x1) / 2, ycenter(r))
        return self.title_block.contains(c) or self.rev_table.contains(c)

    def _cell(self, r: pymupdf.Rect) -> tuple[int, int]:
        """(column index, row index) of the zone that holds the centre of r."""
        return bisect.bisect(self.col_bounds, (r.x0 + r.x1) / 2), bisect.bisect(self.row_bounds, ycenter(r))

    def zone(self, r: pymupdf.Rect) -> str:
        if not (self.cols and self.rows):
            return ""
        ci, ri = self._cell(r)
        return f"{self.rows[ri][1]}{self.cols[ci][1]}"

    def order(self, r: pymupdf.Rect) -> tuple:
        """Sort key: zone column left to right, then zone row top to bottom, then position."""
        return *self._cell(r), round(ycenter(r)), round((r.x0 + r.x1) / 2)


# ---------------------------------------------------------------- title block

def tb_value(pieces: list[Piece], label: str) -> str:
    """Text after a title-block label, either in the same text run or the nearest run to its right
    (level with the label or a little lower, as in a cell whose label sits top-left)."""
    for p in pieces:
        m = re.match(label, p.text, re.I)
        if not m:
            continue
        rest = p.text[m.end():].strip(" :.-")
        if rest:
            return rest
        right = [q for q in pieces if q is not p and q.rect.x0 >= p.rect.x1 - 1 and not TITLE_BLOCK_RE.match(q.text)
                 and p.rect.y0 <= ycenter(q.rect) <= p.rect.y1 + 0.6 * p.rect.height]
        if right:
            return min(right, key=lambda q: q.rect.x0).text
    return ""


def general_tolerances(pieces: list[Piece]) -> dict:
    tol = dict(DEFAULT_GENERAL_TOL)
    labels = {r"WITHOUT\s*DECIMAL": 0, r"ONE\s*DECIMAL": 1, r"TWO\s*DECIMAL": 2, r"THREE\s*DECIMAL": 3, r"ANGLE": "angle"}
    for pattern, key in labels.items():
        for p in pieces:
            if not re.search(pattern, p.text, re.I):
                continue
            row = sorted((q for q in pieces if q.rect.x0 >= p.rect.x0 - 1 and q.rect.x0 < p.rect.x1 + 40
                          and p.rect.y0 <= ycenter(q.rect) <= p.rect.y1), key=lambda q: q.rect.x0)
            m = re.search(r"±\s*[\d.½¼]+\s*°?", " ".join(q.text for q in row))
            if m:
                tol[key] = m.group(0).replace(" ", "")
            break
    return tol


def general_tol_for(val: str, angle: bool, tol: dict) -> str:
    if angle:
        return tol["angle"]
    decimals = len(val.split(".")[1]) if "." in val else 0
    keys = sorted(k for k in tol if k != "angle")
    return tol[min(decimals, keys[-1])] if decimals not in tol else tol[decimals]


def zero(t: str) -> str:
    return ("+0" if t.startswith("+") else "0") if re.fullmatch(r"[+\-]?0*\.?0*", t) else t


# ---------------------------------------------------------------- extraction

def extract(pdf: Path, force_ocr: bool = False, rotate: int | None = None) -> tuple[dict, list[Item], list[tuple[str, str]]]:
    doc = pymupdf.open(pdf)
    info, items, skipped = {}, [], []
    multi = len(doc) > 1
    for pno, page in enumerate(doc):
        ocr = force_ocr or not has_text(page)
        if ocr:
            rot = detect_rotation(page) if rotate is None else rotate
            print(f"  page {pno + 1}: no selectable text - reading it with OCR"
                  + (f" (sheet turned {rot}° to stand upright)" if rot else ""))
            upright = turned(page, rot)   # keeps the turned page alive for this loop pass
            page = upright[0]
            pieces = ocr_pieces(page, pno)
        else:
            pieces = read_pieces(page, pno)
        drawings = page.get_drawings()
        sheet = Sheet(page, pieces, drawings)
        if not info and sheet.title_pieces:
            tp = sheet.title_pieces
            rev = next((p.text for p in tp if re.fullmatch(r"REV\.?\s*\d+", p.text, re.I)), "")
            info = {"title": tb_value(tp, r"TITLE\s*:?"), "drawing_no": tb_value(tp, r"DRAWING\s*NO\.?\s*:?"),
                    "rev": rev.replace(" ", ""), "material": tb_value(tp, r"MATERIAL\s*:?"), "tol": general_tolerances(tp)}
        tol = info.get("tol", DEFAULT_GENERAL_TOL)
        marks = [] if ocr else diameter_marks(drawings)   # OCR reads Ø itself; letters drawn as lines look like marks
        area = sheet.drawing_area
        main_size = statistics.median([p.size for p in area if DIM_RE.match(p.text)] or [10])

        def zone(r):
            z = sheet.zone(r)
            return f"{pno + 1}/{z}" if multi and z else z

        # stacked tolerances: small numbers just right of a dimension, one above the other
        stacked, used = {}, set()
        for i, p in enumerate(area):
            if not (DIM_RE.match(p.text) and p.size >= 0.85 * main_size):
                continue
            near = [j for j, q in enumerate(area) if j != i and q.size < 0.85 * p.size and STACK_TOL_RE.match(q.text)
                    and p.rect.x1 - 1 <= q.rect.x0 <= p.rect.x1 + 1.2 * p.size
                    and p.rect.y0 - 0.4 * p.rect.height <= ycenter(q.rect) <= p.rect.y1 + 0.4 * p.rect.height]
            if near:
                near.sort(key=lambda j: area[j].rect.y0)
                texts = [area[j].text.replace(" ", "") for j in near]
                stacked[i] = f"{zero(texts[0])}/{zero(texts[-1])}" if len(texts) > 1 else texts[0]
                used.update(near)

        for i, p in enumerate(area):
            if i in used:
                continue
            text, rect = p.text, pymupdf.Rect(p.rect)
            if IGNORE_RE.match(text):
                continue
            if re.fullmatch(r"\(.*\)", text):
                skipped.append((zone(rect), f"{text}  (reference dimension)"))
                continue
            m = DIM_RE.match(text)
            if m and p.horizontal and not m["pre"]:
                mark = next((r for r in marks if p.rect.x0 - 1.2 * p.size <= r.x1 <= p.rect.x0 + 0.5
                             and p.rect.y0 <= ycenter(r) <= p.rect.y1), None)
                if mark:   # Ø drawn as a little circle-with-slash in front of the number
                    text, rect = ("*Ø" + text[1:]) if m["kc"] else "Ø" + text, rect | mark
                    m = DIM_RE.match(text)
            if m:
                shown = "".join(filter(None, [m["kc"], m["qty"] and m["qty"].upper().replace(" ", "") + " ",
                                              m["pre"] and m["pre"].upper(), m["val"], m["deg"], m["suf"] and " TYP"]))
                if m["tol"]:
                    t = m["tol"].replace(" ", "")
                    tol_text = "/".join(zero(x) for x in t.split("/")) if "/" in t else t
                    if t == "?":
                        tol_text = "CHECK TOL"   # stacked tolerance found but unreadable - measure against the drawing
                else:
                    tol_text = stacked.get(i) or general_tol_for(m["val"], bool(m["deg"]), tol)
                items.append(Item("dim", shown, tol_text, zone(rect), rect, pno, (pno, *sheet.order(rect))))
            elif c := CHAMFER_RE.match(text):
                val = c["c"] or c["val"]
                items.append(Item("dim", text.upper(), general_tol_for(val, False, tol), zone(rect), rect, pno,
                                  (pno, *sheet.order(rect))))
            elif HOLE_RE.search(text) and re.search(r"\d", text):
                note = re.sub(r"(?<=\d)X(?=\d)", "x", "VERIFY " + text.upper())   # keep M6x1.0 as written
                items.append(Item("note", note, "", zone(rect), rect, pno, (pno, *sheet.order(rect))))
                for shown, val in callout_dims(text):   # the callout's own sizes as measurable rows
                    items.append(Item("dim", shown, general_tol_for(val, False, tol), zone(rect), rect, pno,
                                      (pno, *sheet.order(rect))))
            elif text != "*":
                skipped.append((zone(rect), text))

    if not items:
        print(f"  warning: no dimensions found in {pdf.name} - try --ocr, or --rotate if the sheet is sideways")
    dims = sorted((it for it in items if it.kind == "dim"), key=lambda it: it.order)
    notes = sorted((it for it in items if it.kind == "note"), key=lambda it: it.order)
    for n, it in enumerate(dims):
        it.label = row_label(n)
    return info or {"tol": DEFAULT_GENERAL_TOL}, dims + notes, skipped


def callout_dims(text: str) -> list[tuple[str, str]]:
    """Diameters and depths inside a hole/thread callout, e.g. 'M6x1.0 - 16 mm deep' -> ('16 DEEP (M6x1.0)', '16').
    Thread sizes themselves (M6x1.0, 1/4-28, #8-32) are checked by the VERIFY row, not measured."""
    thread = THREAD_RE.search(text)
    rest = THREAD_RE.sub(" ", text)
    out = [(f"{m[1].upper().replace(chr(39), '')} Ø{m[2]}" if m[1] else f"Ø{m[2]}", m[2])
           for m in CALLOUT_DIA_RE.finditer(rest)]
    for m in CALLOUT_DEPTH_RE.finditer(CALLOUT_DIA_RE.sub(" ", rest)):
        val = m[1] or m[2]
        out.append((f"{val} DEEP" + (f" ({thread[0].replace(' ', '')})" if thread else ""), val))
    return out


def row_label(n: int) -> str:
    """a, b, ... z, aa, ab, ..."""
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(97 + r) + s
    return s


# ---------------------------------------------------------------- outputs

THIN = Side(style="thin", color="000000")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
GREY = PatternFill("solid", fgColor="D9D9D9")


def project_from(drawing_no: str) -> str:
    """The project code inside a drawing number: what is left once the 'VT-' prefix and the last
    '-' part (the drawing's own number) are taken off, e.g. 'VT-JS 4A 70-012' -> 'JS 4A 70'."""
    code = re.sub(r"^VT-", "", drawing_no.strip())
    return code.rsplit("-", 1)[0].strip() if "-" in code else code


def dcl_fields(info: dict, args) -> tuple[str, str, str, str, str]:
    """(part name, drawing no, rev, part no, project) for the header and footer."""
    drawing_no = info.get("drawing_no", "")
    return ((info.get("title") or "").upper(), drawing_no, info.get("rev") or "REV.00",
            args.part_no or re.sub(r"^VT-", "", drawing_no), args.project or project_from(drawing_no) or "N/A")


def write_xlsx(out: Path, info: dict, items: list[Item], args) -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "DCL"
    n = 4 + args.samples
    last, mid = n, 4 + args.samples // 2
    part_name, drawing_no, rev, part_no, project = dcl_fields(info, args)

    def put(row, c1, c2, value, *, label=False, bold=False, italic=False, size=9, align="left", wrap=False, border=True,
            shrink=False):
        if c2 > c1:
            ws.merge_cells(start_row=row, start_column=c1, end_row=row, end_column=c2)
        cell = ws.cell(row, c1, value)
        if not isinstance(value, CellRichText):
            cell.font = Font(name="Arial", size=size, bold=bold, italic=italic)
        cell.alignment = Alignment(horizontal=align, vertical="center", wrap_text=wrap, shrink_to_fit=shrink or label)
        for c in range(c1, c2 + 1):
            if border:
                ws.cell(row, c).border = BOX
            if label:
                ws.cell(row, c).fill = GREY
        return cell

    def sample_boxes(row):
        for c in range(5, n + 1):
            ws.cell(row, c).border = BOX

    widths = [6, 13, 18, 11] + [11] * args.samples
    for c, w in enumerate(widths, 1):
        ws.column_dimensions[get_column_letter(c)].width = w

    # header
    ws.merge_cells(start_row=1, start_column=1, end_row=4, end_column=1)
    dcl = ws.cell(1, 1, "DCL")
    dcl.font = Font(name="Arial", size=14, bold=True)
    dcl.alignment = Alignment(horizontal="center", vertical="center")
    for r in range(1, 5):
        ws.cell(r, 1).border = BOX
        ws.cell(r, 1).fill = GREY
    put(1, 2, n, "DIMENSION CHECKLIST", label=True, bold=True, size=12, align="center")
    put(2, 2, 2, "PROJECT", label=True)
    put(2, 3, 3, project, label=True, align="center")
    put(2, 4, 4, "Batch No.", label=True)
    put(2, 5, mid - 1, "")
    put(2, mid, mid, "PART NAME", label=True)
    put(2, mid + 1, last - 3, part_name, label=True, wrap=True)
    put(2, last - 2, last - 2, "PART №", label=True)
    put(2, last - 1, last, part_no, label=True, wrap=True)
    put(3, 2, 2, "WORKORDER №", label=True)
    put(3, 3, mid - 1, "")
    put(3, mid, mid + 1, "DRAWING REF №", label=True)
    put(3, mid + 2, last, f"{drawing_no} {rev}".strip(), label=True)
    put(4, 2, 3, "MEASURING DEVICE USED", label=True)
    put(4, 4, mid + 1, "")
    put(4, mid + 2, mid + 2, "CAL STATUS", label=True)
    put(4, mid + 3, last, "")
    for c, h in enumerate(["Sl No", "ZONE", "DIMENSIONS\n(mm)", "TOLERANCE\n(mm)"] + ["SL №"] * args.samples, 1):
        put(5, c, c, h, label=True, align="center" if c <= 4 else "left", wrap=True)
    ws.row_dimensions[5].height = 26
    ws.row_dimensions[6].height = 8

    # body
    row = 7
    put(row, 1, 4, f"Material: {info.get('material') or ''}".strip())
    sample_boxes(row)
    row += 1
    put(row, 1, 4, "Batch No.:")
    sample_boxes(row)
    for it in items:
        row += 1
        if it.kind == "dim":
            put(row, 1, 1, f"{it.label}.")
            put(row, 2, 2, it.zone)
            put(row, 3, 3, it.text)
            put(row, 4, 4, it.tol)
        else:
            put(row, 1, 4, it.text, wrap=True)
            ws.row_dimensions[row].height = 13 * (1 + len(it.text) // 42)
        sample_boxes(row)
    tail = []
    if args.weight:
        tail.append(f"Weight (g): {args.weight}")
    bold_ = InlineFont(rFont="Arial", sz=9, b=True)
    plain = InlineFont(rFont="Arial", sz=9)
    tail += [CellRichText(TextBlock(bold_, "Prepared by"), TextBlock(plain, " Min. Level Reqd.: Tech. Asst.")),
             CellRichText(TextBlock(bold_, "Verified by"), TextBlock(plain, " Min. Level Reqd.: Tech. Officer"))]
    for t in tail:
        row += 1
        put(row, 1, 4, t)
        sample_boxes(row)
    row += 1
    put(row, 1, 4, "QC Clearance with Sign & Date", bold=True, italic=True)
    sample_boxes(row)
    if any(it.text.startswith("*") for it in items):
        row += 1
        put(row, 1, 4, "* Key Characteristics", bold=True, border=False)

    # footer title block
    row += 2
    f1, f2 = row, row + 1
    for r in (f1, f2):
        ws.row_dimensions[r].height = 22
    ws.merge_cells(start_row=f1, start_column=1, end_row=f2, end_column=3)
    for r in (f1, f2):
        for c in range(1, 4):
            ws.cell(r, c).border = BOX
    if args.logo and Path(args.logo).exists():
        from openpyxl.drawing.image import Image as XLImage
        logo = XLImage(str(args.logo))
        logo.height, logo.width = 52, int(52 * logo.width / logo.height)
        ws.add_image(logo, f"A{f1}")
    put(f1, 4, last - 2, f"TITLE : DIMENSION CHECK LIST FOR {part_name} FOR {project}", wrap=True)
    put(f1, last - 1, last, "SIZE   A4", align="center")
    put(f2, 4, mid - 1, f"RECORD № VT-R-DCL-{part_no}-", shrink=True)
    put(f2, mid, last - 2, f"FORMAT NO: VT-F-DCL-{part_no} {rev}", shrink=True)
    put(f2, last - 1, last, f"FORMAT: {FORM_ID}", size=7, align="center")

    # print setup: A4 landscape, one page wide, header rows repeated, RESTRICTED from page 2
    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth, ws.page_setup.fitToHeight = 1, 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.page_margins.left = ws.page_margins.right = 0.4
    ws.print_title_rows = "1:5"
    ws.print_area = f"A1:{get_column_letter(n)}{f2}"
    ws.freeze_panes = "E7"
    hf = ws.HeaderFooter
    hf.differentFirst = True
    hf.oddHeader.center.text = "&B&\"Arial\"RESTRICTED"
    for footer in (hf.oddFooter, hf.firstFooter):
        footer.center.text = f"Rec № VT-R-DCL-{part_no}-\n{COMPANY}".replace("&", "&&")   # '&' is a code in Excel footers
        footer.center.size = 7
        footer.right.text = "PAGE &P - &N"
        footer.right.size = 7
    wb.save(out)


DOCX_MARGIN_MM = 10


def write_docx(out: Path, info: dict, items: list[Item], args) -> None:
    """The same checklist as a Word file. The DCL title block (with the column headings) is the page
    header and the logo title block is the page footer, so both repeat unchanged on every page."""
    try:
        from docx import Document
        from docx.enum.section import WD_ORIENT
        from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
        from docx.enum.text import WD_ALIGN_PARAGRAPH
        from docx.oxml import OxmlElement
        from docx.oxml.ns import qn
        from docx.shared import Emu, Mm, Pt
    except ImportError:
        sys.exit("Missing dependency 'python-docx'. Install with:  py -3.14 -m pip install python-docx")

    n = 4 + args.samples
    last, mid = n, 4 + args.samples // 2   # 1-based column numbers, as in write_xlsx
    part_name, drawing_no, rev, part_no, project = dcl_fields(info, args)
    align = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER}

    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = "Arial", Pt(8)
    normal.paragraph_format.space_after = Pt(0)
    normal.paragraph_format.line_spacing = 1.0
    sec = doc.sections[0]
    sec.orientation = WD_ORIENT.LANDSCAPE
    sec.page_width, sec.page_height = Mm(297), Mm(210)
    sec.left_margin = sec.right_margin = Mm(DOCX_MARGIN_MM)
    sec.top_margin, sec.bottom_margin = Mm(47), Mm(37)
    sec.header_distance = sec.footer_distance = Mm(7)
    usable = 297 - 2 * DOCX_MARGIN_MM
    weights = [7, 13, 17, 13] + [11] * args.samples
    grid = [Mm(usable * w / sum(weights)) for w in weights]

    def shade(cell):
        shd = OxmlElement("w:shd")
        for k, v in (("w:val", "clear"), ("w:color", "auto"), ("w:fill", "D9D9D9")):
            shd.set(qn(k), v)
        cell._tc.get_or_add_tcPr().append(shd)   # before vAlign is added, to keep the schema order

    def write(cell, text, *, bold=False, italic=False, size=8, align_="left"):
        """text is a string ('\n' = line break) or a list of (text, bold) pieces."""
        p = cell.paragraphs[0]
        p.alignment = align[align_]
        for piece, b in ([(text, bold)] if isinstance(text, str) else text):
            for k, line in enumerate(piece.split("\n")):
                if k:
                    p.add_run().add_break()
                r = p.add_run(line)
                r.font.size, r.bold, r.italic = Pt(size), b, italic
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        return p

    def table(container, rows, widths):
        t = doc.add_table(rows, len(widths)) if container is doc else container.add_table(rows, len(widths), sum(widths))
        t.style = doc.styles["Table Grid"]
        t.autofit = False
        t.alignment = WD_TABLE_ALIGNMENT.CENTER
        mar = OxmlElement("w:tblCellMar")   # narrow cell padding (default 1.9 mm) so short labels fit
        for side in ("left", "right"):
            e = OxmlElement(f"w:{side}")
            e.set(qn("w:w"), "45")
            e.set(qn("w:type"), "dxa")
            mar.append(e)
        look = t._tbl.tblPr.find(qn("w:tblLook"))
        look.addprevious(mar) if look is not None else t._tbl.tblPr.append(mar)
        for col, w in zip(t.columns, widths):
            col.width = w
            for cell in col.cells:
                cell.width = w
        return t

    def put(t, row, c1, c2, value, *, label=False, **fmt):
        cell = t.cell(row, c1 - 1)
        if c2 > c1:
            cell = cell.merge(t.cell(row, c2 - 1))
        if label:
            shade(cell)
        write(cell, value, **fmt)
        return cell

    def height(t, mm):
        for row in t.rows:
            row.height, row.height_rule = Mm(mm), WD_ROW_HEIGHT_RULE.AT_LEAST
            row._tr.get_or_add_trPr().insert(0, OxmlElement("w:cantSplit"))

    def field(p, instr, size):
        for kind in ("begin", "instr", "separate", "text", "end"):
            r = p.add_run("1" if kind == "text" else None)
            r.font.size = Pt(size)
            if kind == "instr":
                el = OxmlElement("w:instrText")
                el.set(qn("xml:space"), "preserve")
                el.text = f" {instr} "
            elif kind != "text":
                el = OxmlElement("w:fldChar")
                el.set(qn("w:fldCharType"), kind)
            else:
                continue
            r._r.append(el)

    # page header: RESTRICTED + title block + column headings, on every page
    hdr = sec.header
    p = hdr.paragraphs[0]
    p.alignment = align["center"]
    r = p.add_run("RESTRICTED")
    r.bold, r.font.size = True, Pt(11)
    t = table(hdr, 5, grid)
    height(t, 5)
    dcl = t.cell(0, 0).merge(t.cell(3, 0))
    shade(dcl)
    write(dcl, "DCL", bold=True, size=14, align_="center")
    put(t, 0, 2, n, "DIMENSION CHECKLIST", label=True, bold=True, size=12, align_="center")
    put(t, 1, 2, 2, "PROJECT", label=True)
    put(t, 1, 3, 3, project, label=True, align_="center")
    put(t, 1, 4, 4, "Batch No.", label=True)
    put(t, 1, 5, mid - 1, "")
    put(t, 1, mid, mid, "PART NAME", label=True)
    put(t, 1, mid + 1, last - 3, part_name, label=True)
    put(t, 1, last - 2, last - 2, "PART №", label=True)
    put(t, 1, last - 1, last, part_no, label=True)
    put(t, 2, 2, 2, "WORKORDER №", label=True)
    put(t, 2, 3, mid - 1, "")
    put(t, 2, mid, mid + 1, "DRAWING REF №", label=True)
    put(t, 2, mid + 2, last, f"{drawing_no} {rev}".strip(), label=True)
    put(t, 3, 2, 3, "MEASURING DEVICE USED", label=True)
    put(t, 3, 4, mid + 1, "")
    put(t, 3, mid + 2, mid + 2, "CAL STATUS", label=True)
    put(t, 3, mid + 3, last, "")
    for c, h in enumerate(["Sl No", "ZONE", "DIMENSIONS\n(mm)", "TOLERANCE\n(mm)"] + ["SL №"] * args.samples, 1):
        put(t, 4, c, c, h, label=True, align_="center" if c <= 4 else "left")
    hdr.add_paragraph().paragraph_format.space_after = Pt(0)   # a header must end with a paragraph

    # page footer: logo title block + company line, on every page
    ftr = sec.footer
    ftr.paragraphs[0]._p.getparent().remove(ftr.paragraphs[0]._p)
    logo_w, side = Mm(62), Mm(25)
    half = Emu((Mm(usable) - logo_w - 2 * side) // 2)
    t = table(ftr, 3, [logo_w, half, half, side, side])
    height(t, 6)
    logo = t.cell(0, 0).merge(t.cell(2, 0))
    logo.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    if args.logo and Path(args.logo).exists():
        p = logo.paragraphs[0]
        p.alignment = align["center"]
        p.add_run().add_picture(str(args.logo), height=Mm(14))
    write(t.cell(0, 1).merge(t.cell(1, 2)), f"TITLE : DIMENSION CHECK LIST FOR {part_name} FOR {project}")
    write(t.cell(0, 3), "SIZE", align_="center")
    write(t.cell(0, 4), "PAGE", align_="center")
    write(t.cell(1, 3), "A4", align_="center")
    p = write(t.cell(1, 4), "", align_="center")
    field(p, "PAGE", 8)
    p.add_run(" - ").font.size = Pt(8)
    field(p, "NUMPAGES", 8)
    write(t.cell(2, 1), f"RECORD № VT-R-DCL-{part_no}-")
    write(t.cell(2, 2), f"FORMAT NO: VT-F-DCL-{part_no} {rev}")
    write(t.cell(2, 3).merge(t.cell(2, 4)), f"FORMAT: {FORM_ID}", size=6.5, align_="center")
    p = ftr.add_paragraph()
    p.alignment = align["center"]
    p.paragraph_format.space_before = Pt(3)
    p.add_run(COMPANY).font.size = Pt(7)

    # body: one row per check, same columns as the header
    tail = ([f"Weight (g): {args.weight}"] if args.weight else []) + [
        [("Prepared by", True), (" Min. Level Reqd.: Tech. Asst.", False)],
        [("Verified by", True), (" Min. Level Reqd.: Tech. Officer", False)]]
    t = table(doc, 3 + len(items) + len(tail), grid)
    height(t, 5.5)
    put(t, 0, 1, 4, f"Material: {info.get('material') or ''}".strip())
    put(t, 1, 1, 4, "Batch No.:")
    row = 1
    for it in items:
        row += 1
        if it.kind == "dim":
            for c, v in enumerate([f"{it.label}.", it.zone, it.text, it.tol], 1):
                put(t, row, c, c, v)
        else:
            put(t, row, 1, 4, it.text)
    for v in tail:
        row += 1
        put(t, row, 1, 4, v)
    put(t, row + 1, 1, 4, "QC Clearance with Sign & Date", bold=True, italic=True)
    if any(it.text.startswith("*") for it in items):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(4)
        r = p.add_run("* Key Characteristics")
        r.bold, r.font.size = True, Pt(9)
    doc.save(out)


WRITERS = {".xlsx": write_xlsx, ".docx": write_docx}


def outputs(base: Path, fmt: str) -> list[Path]:
    """Output files for a drawing: base itself when it already ends in .xlsx/.docx, else base with
    the extension(s) of the chosen format."""
    if base.suffix.lower() in WRITERS:
        return [base]
    return [base.with_suffix(e) for e in {"docx": [".docx"], "xlsx": [".xlsx"], "both": [".docx", ".xlsx"]}[fmt]]


def convert(pdf: Path, base: Path, args) -> None:
    print(f"{pdf.name}")
    info, items, skipped = extract(pdf, args.ocr, args.rotate)
    outs = outputs(base, args.format)
    for out in outs:
        WRITERS[out.suffix.lower()](out, info, items, args)
    print(f"  title: {info.get('title', '?')}   drawing: {info.get('drawing_no', '?')} {info.get('rev', '')}"
          f"   material: {info.get('material', '?')}")
    print("  general tolerances: " + ", ".join(f"{k if k == 'angle' else str(k) + ' dec'} {v}" for k, v in info["tol"].items()))
    for it in items:
        if it.kind == "dim":
            print(f"   {it.label + '.':4} {it.zone:4} {it.text:14} {it.tol}")
        else:
            print(f"   {'':4} {it.zone:4} {it.text}")
    for z, t in skipped:
        print(f"   not used [{z}]: {t}")
    for out in outs:
        print(f"  -> {out}")


def main() -> None:
    ap = argparse.ArgumentParser(description="Build a Dimension Checklist (DCL) Word or Excel file from a vector CAD drawing PDF.")
    ap.add_argument("input", type=Path, help="drawing PDF, or a folder of drawing PDFs")
    ap.add_argument("-o", "--output", type=Path, help="output .docx/.xlsx (or folder, for batch mode)")
    ap.add_argument("--format", choices=("docx", "xlsx", "both"), default="docx",
                    help="Word (default), Excel or both; an -o file name ending in .docx/.xlsx decides by itself")
    ap.add_argument("--project", help="project name for the header (default: from the drawing number, "
                                      "e.g. VT-JS 4A 70-012 -> JS 4A 70; N/A if there is none)")
    ap.add_argument("--part-no", help="part number (default: drawing number without the 'VT-' prefix)")
    ap.add_argument("--weight", help='weight row, e.g. "1822 ± 10 g" (row left out if not given)')
    ap.add_argument("--samples", type=int, default=10, help="number of SL № columns (8-20, default 10)")
    ap.add_argument("--logo", type=Path, default=DEFAULT_LOGO, help="logo image for the footer")
    ap.add_argument("--ocr", action="store_true", help="read every page with OCR, even pages with selectable text")
    ap.add_argument("--rotate", type=int, choices=(0, 90, 180, 270),
                    help="turn OCR pages by this many degrees instead of detecting it (90 = sheet printed sideways)")
    args = ap.parse_args()
    if not 8 <= args.samples <= 20:
        ap.error("--samples must be between 8 and 20")

    if args.input.is_dir():
        pdfs = sorted(args.input.glob("*.pdf"))
        out_dir = args.output or args.input
        out_dir.mkdir(parents=True, exist_ok=True)
        for pdf in pdfs:
            convert(pdf, out_dir / pdf.name, args)
    elif args.input.suffix.lower() == ".pdf" and args.input.exists():
        convert(args.input, args.output or args.input, args)
    else:
        sys.exit(f"Not a PDF file or folder: {args.input}")


if __name__ == "__main__":
    main()
