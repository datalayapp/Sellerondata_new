"""Measure the free scale reader (app/scale.py) on real photos.

Put the photos in one folder together with `etiketler.csv`:

    dosya,agirlik,birim
    IMG_0001.jpg,4.02,kg
    IMG_0002.jpg,1250,g

(`;` as separator and a decimal comma, as Excel writes it in Turkish, also work; `birim` may be
empty = kg). Then:

    python tools/scale_eval.py <klasor> [--csv sonuc.csv] [--threshold 0.7]

Prints correct / WRONG / unreadable counts at the service threshold, every wrong reading, why the
rest were refused, and a table of what each confidence threshold would give. Photos are decoded
exactly as the service decodes them (same size limits, EXIF rotation).
"""

from __future__ import annotations

import argparse
import csv
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.imageio import ImageDecodeError, load_image  # noqa: E402
from app.scale import ACCEPT_CONFIDENCE, LB_TO_KG, read_scale  # noqa: E402

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff", ".heic"}
TOLERANCE_KG = 0.0005  # half a gram: the reading must equal the display
THRESHOLDS = [0.0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95]


def parse_weight(text: str) -> float:
    t = text.strip().replace(" ", "")
    if "," in t and "." not in t:
        t = t.replace(",", ".")
    return float(t)


def to_kg(value: float, unit: str) -> float:
    unit = (unit or "kg").strip().lower()
    if unit in ("kg", "kilo", ""):
        return value
    if unit in ("g", "gr", "gram"):
        return value / 1000.0
    if unit in ("lb", "lbs"):
        return value * LB_TO_KG
    raise ValueError(f"bilinmeyen birim: {unit}")


def read_labels(path: Path) -> dict[str, float]:
    raw = path.read_text(encoding="utf-8-sig")
    first = raw.splitlines()[0] if raw else ""
    delim = ";" if first.count(";") > first.count(",") else ","
    rows = list(csv.reader(raw.splitlines(), delimiter=delim))
    if rows and not any(ch.isdigit() for ch in (rows[0][1] if len(rows[0]) > 1 else "")):
        rows = rows[1:]  # header
    labels: dict[str, float] = {}
    for i, row in enumerate(rows, start=2):
        if not row or not row[0].strip():
            continue
        try:
            labels[row[0].strip()] = to_kg(parse_weight(row[1]), row[2] if len(row) > 2 else "kg")
        except (IndexError, ValueError) as e:
            print(f"UYARI: etiketler.csv satır {i} okunamadı ({e}): {row}")
    return labels


def pct(k: int, n: int) -> str:
    return f"%{100.0 * k / n:.1f}" if n else "—"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Ücretsiz tartı okumasını gerçek fotoğraflarla ölçer.")
    ap.add_argument("folder", type=Path)
    ap.add_argument("--labels", type=Path, help="varsayılan: <klasor>/etiketler.csv")
    ap.add_argument("--threshold", type=float, default=ACCEPT_CONFIDENCE, help=f"güven eşiği (servis: {ACCEPT_CONFIDENCE})")
    ap.add_argument("--csv", type=Path, help="dosya başına sonuçları bu CSV'ye yaz")
    args = ap.parse_args()

    labels = read_labels(args.labels or args.folder / "etiketler.csv")
    photos = {p.name: p for p in sorted(args.folder.iterdir()) if p.suffix.lower() in IMAGE_EXT}
    for name in sorted(set(photos) - set(labels)):
        print(f"UYARI: etiketi olmayan fotoğraf atlandı: {name}")
    for name in sorted(set(labels) - set(photos)):
        print(f"UYARI: etiketteki dosya klasörde yok: {name}")
    names = [n for n in labels if n in photos]
    if not names:
        print("Ölçülecek fotoğraf yok.")
        return

    results = []  # (name, truth_kg, candidate_kg | None, confidence, text, unit, reason, ms)
    for name in names:
        try:
            loaded = load_image(photos[name].read_bytes())
        except ImageDecodeError as e:
            results.append((name, labels[name], None, 0.0, "", None, f"image:{type(e).__name__}", 0.0))
            continue
        # accept=0: keep every candidate that passed the checks, so the threshold table can be built.
        r = read_scale(loaded.bgr, accept=0.0)
        reason = r.reason if r.candidate_kg is None or r.reason == "multiple_numbers" else None
        cand = r.candidate_kg if reason is None else None
        results.append((name, labels[name], cand, float(r.confidence), r.text, r.unit, reason, r.elapsed_ms))

    def verdict(truth: float, cand: float | None, conf: float, thr: float) -> str:
        if cand is None or conf < thr:
            return "okunamadı"
        return "doğru" if abs(cand - truth) <= TOLERANCE_KG else "YANLIŞ"

    n = len(results)
    v = [verdict(t, c, cf, args.threshold) for _, t, c, cf, *_ in results]
    cnt = Counter(v)
    print(f"\n{n} fotoğraf, güven eşiği {args.threshold}\n")
    print(f"  doğru      : {cnt['doğru']:3d}  {pct(cnt['doğru'], n)}")
    print(f"  YANLIŞ     : {cnt['YANLIŞ']:3d}  {pct(cnt['YANLIŞ'], n)}   <- sıfır olmalı")
    print(f"  okunamadı  : {cnt['okunamadı']:3d}  {pct(cnt['okunamadı'], n)}")
    ms = [r[7] for r in results if r[7] > 0]
    if ms:
        print(f"  süre       : ort. {sum(ms) / len(ms):.0f} ms, en uzun {max(ms):.0f} ms")

    wrong = [(r, x) for r, x in zip(results, v) if x == "YANLIŞ"]
    if wrong:
        print("\nYanlış okunanlar:")
        for (name, truth, cand, conf, text, unit, _, _), _ in wrong:
            print(f"  {name}: doğrusu {truth:g} kg, okunan {text} {unit} = {cand:g} kg, güven {conf:.2f}")

    refused = Counter((r[6] or "low_confidence") for r, x in zip(results, v) if x == "okunamadı")
    if refused:
        print("\nOkunamama nedenleri:")
        for why, k in refused.most_common():
            print(f"  {why}: {k}")

    print("\nGüven eşiğine göre (kabul = ağırlık döndü):\n")
    print("| Eşik | Kabul | Doğru | YANLIŞ | Okunamadı | Kabul edilenlerde doğruluk |")
    print("|---|---|---|---|---|---|")
    for thr in sorted(set(THRESHOLDS + [args.threshold])):
        c = Counter(verdict(t, cd, cf, thr) for _, t, cd, cf, *_ in results)
        acc = c["doğru"] + c["YANLIŞ"]
        print(f"| {thr:.2f} | {acc} | {c['doğru']} | {c['YANLIŞ']} | {c['okunamadı']} | {pct(c['doğru'], acc)} |")

    if args.csv:
        with args.csv.open("w", newline="", encoding="utf-8") as f:
            wr = csv.writer(f)
            wr.writerow(["dosya", "dogru_kg", "okunan_kg", "okunan_metin", "birim", "guven", "neden", "sonuc", "ms"])
            for (name, truth, cand, conf, text, unit, reason, el), x in zip(results, v):
                wr.writerow([name, truth, "" if cand is None else cand, text, unit or "", f"{conf:.3f}", reason or "", x, f"{el:.0f}"])
        print(f"\nDosya başına sonuçlar: {args.csv}")


if __name__ == "__main__":
    main()
