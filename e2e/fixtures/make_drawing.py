"""A small vector drawing for the drawing-tools tests and screenshots (decision #46):
a zone grid 8..1 / F..A, a title block with the general tolerance table, and dimensions.
Usage: python make_drawing.py out.pdf   (needs pymupdf)"""
import sys

import pymupdf

doc = pymupdf.open()
W, H = 842, 595
p = doc.new_page(width=W, height=H)
p.draw_rect(pymupdf.Rect(20, 20, W - 20, H - 20))
p.draw_rect(pymupdf.Rect(10, 10, W - 10, H - 10))
for i, c in enumerate("87654321"):
    x = 20 + (W - 40) * (i + 0.5) / 8
    p.insert_text((x - 3, 18), c, fontsize=7)
    p.insert_text((x - 3, H - 12), c, fontsize=7)
for j, r in enumerate("FEDCBA"):
    y = 20 + (H - 40) * (j + 0.5) / 6
    p.insert_text((12, y + 3), r, fontsize=7)
    p.insert_text((W - 18, y + 3), r, fontsize=7)
# the part: a plate with a bore and four tapped holes
p.draw_rect(pymupdf.Rect(140, 160, 420, 360))
p.draw_circle((280, 260), 40)
for cx, cy in ((170, 190), (390, 190), (170, 330), (390, 330)):
    p.draw_circle((cx, cy), 6)


def t(x, y, s, fs=9):
    p.insert_text((x, y), s, fontsize=fs)


t(150, 120, "25.0")
t(300, 150, "Ø12.5 ±0.1")
t(400, 200, "R5")
t(200, 250, "*40")
t(500, 260, "4X M6x1.0 THRU")
t(250, 300, "30°")
t(120, 340, "(10)")
t(350, 330, "C1")
t(450, 120, "110.00")
y = 470
for s in ["TITLE: MOUNTING BRACKET", "DRAWING NO: VT-JD 123-01", "REV.02", "MATERIAL: AL 6061-T6", "WITHOUT DECIMAL ±0.5",
          "ONE DECIMAL ±0.1", "TWO DECIMAL ±0.02", "ANGLE ±1°", "DRAWN: CA"]:
    t(560, y, s, 7)
    y += 11
doc.save(sys.argv[1])
