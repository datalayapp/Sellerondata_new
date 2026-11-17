"""Generate the printable A4 reference card (ArUco DICT_4X4_50 id 7, 100 mm black square).

Usage: python tools/make_reference_card.py [output.pdf]
Default output: <repo>/samples/reference-card.pdf. Requires reportlab (requirements-dev.txt).
"""

from __future__ import annotations

import sys
from pathlib import Path

import cv2
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

MARKER_ID = 7
MARKER_MM = 100.0
CARD_MM = 130.0
REPO = Path(__file__).resolve().parents[3]

FONT_CANDIDATES = [
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/segoeuib.ttf"),
    ("/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf"),
]

INSTRUCTIONS = [
    "Yazdırırken ölçek “Gerçek boyut / %100” olsun; “Sayfaya sığdır” seçeneğini kapatın.",
    "Yazdırdıktan sonra yukarıdaki çizgiyi cetvelle ölçün: tam 100 mm olmalı.",
    "Kartı kesik çizgiden kesin. Katlamayın, buruşturmayın; düz ve mat kalsın.",
    "Kartı masaya, kutunun hemen yanına düz koyun (kutunun altına ya da üstüne değil).",
    "Kutuyu üç yüzü (üst ve iki yan) görünecek şekilde çapraz yukarıdan tek fotoğrafla çekin.",
    "Kartın dört köşesi de fotoğrafta görünsün; üstüne gölge ya da parlama düşmesin.",
]


def register_fonts() -> tuple[str, str]:
    for regular, bold in FONT_CANDIDATES:
        if Path(regular).exists() and Path(bold).exists():
            pdfmetrics.registerFont(TTFont("CardSans", regular))
            pdfmetrics.registerFont(TTFont("CardSans-Bold", bold))
            return "CardSans", "CardSans-Bold"
    raise SystemExit("Türkçe karakter destekli bir TTF yazı tipi bulunamadı (DejaVuSans veya Arial).")


def draw_marker(c: canvas.Canvas, x: float, y: float, size: float) -> None:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    cells = cv2.aruco.generateImageMarker(dictionary, MARKER_ID, 6)
    n = cells.shape[0]
    cell = size / n
    c.setFillColorRGB(0, 0, 0)
    c.rect(x, y, size, size, stroke=0, fill=1)
    c.setFillColorRGB(1, 1, 1)
    for row in range(n):
        for col in range(n):
            if cells[row, col] > 127:
                c.rect(x + col * cell, y + size - (row + 1) * cell, cell, cell, stroke=0, fill=1)


def draw_ruler(c: canvas.Canvas, x: float, y: float, font: str) -> None:
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.6)
    c.line(x, y, x + MARKER_MM * mm, y)
    for i in range(0, int(MARKER_MM) + 1):
        length = 6 if i % 10 == 0 else 4 if i % 5 == 0 else 2.2
        c.setLineWidth(0.5 if i % 10 == 0 else 0.25)
        c.line(x + i * mm, y, x + i * mm, y + length * mm)
    c.setFont(font, 7)
    for i in range(0, int(MARKER_MM) + 1, 10):
        c.drawCentredString(x + i * mm, y + 7.2 * mm, str(i // 10))
    c.drawString(x + MARKER_MM * mm + 2 * mm, y + 7.2 * mm, "cm")


def make(out: Path) -> Path:
    regular, bold = register_fonts()
    page_w, page_h = A4
    c = canvas.Canvas(str(out), pagesize=A4)
    c.setTitle("DeciShip Referans Kartı")
    c.setAuthor("DeciShip")
    c.setSubject("ArUco DICT_4X4_50 id 7, 100 mm")

    c.setFont(bold, 18)
    c.drawString(20 * mm, page_h - 20 * mm, "DeciShip Referans Kartı")
    c.setFont(regular, 9)
    c.drawString(20 * mm, page_h - 26 * mm, "Referans kartı ile kutu ölçümü için. Siyah kare kenarı tam 100 mm.")

    card_x = (page_w - CARD_MM * mm) / 2
    card_y = page_h - 40 * mm - CARD_MM * mm
    c.setStrokeColorRGB(0.35, 0.35, 0.35)
    c.setLineWidth(0.5)
    c.setDash(3, 2)
    c.rect(card_x, card_y, CARD_MM * mm, CARD_MM * mm, stroke=1, fill=0)
    c.setDash()
    right, top = card_x + CARD_MM * mm, card_y + CARD_MM * mm
    for cx, cy in [(card_x, card_y), (right, card_y), (card_x, top), (right, top)]:
        sx = -1 if cx == card_x else 1
        sy = -1 if cy == card_y else 1
        c.line(cx + sx * 3 * mm, cy, cx + sx * 8 * mm, cy)
        c.line(cx, cy + sy * 3 * mm, cx, cy + sy * 8 * mm)
    c.setFont(regular, 7)
    c.setFillColorRGB(0.35, 0.35, 0.35)
    c.drawString(card_x + 10 * mm, card_y + CARD_MM * mm + 2 * mm, "Kesim çizgisi")
    c.drawRightString(card_x + CARD_MM * mm - 10 * mm, card_y - 4 * mm, f"ArUco DICT_4X4_50 · ID {MARKER_ID} · 100 mm")

    offset = (CARD_MM - MARKER_MM) / 2 * mm
    draw_marker(c, card_x + offset, card_y + offset, MARKER_MM * mm)

    c.setFillColorRGB(0, 0, 0)
    ruler_x = (page_w - MARKER_MM * mm) / 2
    ruler_y = card_y - 30 * mm
    c.setFont(bold, 10)
    c.drawCentredString(page_w / 2, ruler_y + 12 * mm, "Ölçek kontrolü: bu çizgi 100 mm olmalı")
    draw_ruler(c, ruler_x, ruler_y, regular)

    c.setFont(bold, 11)
    y = ruler_y - 14 * mm
    c.drawString(20 * mm, y, "Nasıl kullanılır?")
    c.setFont(regular, 9.5)
    for i, line in enumerate(INSTRUCTIONS, start=1):
        y -= 6.5 * mm
        c.drawString(22 * mm, y, f"{i}.  {line}")

    c.setFont(regular, 7)
    c.setFillColorRGB(0.45, 0.45, 0.45)
    c.drawString(20 * mm, 12 * mm, "Kart bozulursa yenisini yazdırın. Yalnızca bu kartla yapılan ölçümler doğru sonuç verir.")
    c.showPage()
    c.save()
    return out


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "samples" / "reference-card.pdf"
    target.parent.mkdir(parents=True, exist_ok=True)
    print(make(target))
