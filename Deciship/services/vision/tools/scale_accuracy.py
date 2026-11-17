"""Synthetic accuracy report for the free scale reader (app/scale.py).

Renders random weights on random seven-segment displays (LCD and LED, kg / g / lb) under several
photo conditions, reads them and counts: correct, WRONG (a weight that is not the true one) and
unreadable (the reader said "okunamadı"). Wrong is what matters: it must stay near zero. Then the
scenes that must never give a weight (dot matrix, analog dial, colour screen, no scale, 0.000, -1.25).

Synthetic results do not prove real-world accuracy; measure real photos with tools/scale_eval.py.

Usage: python tools/scale_accuracy.py [--n 50] [--threshold 0.7] [--quick]
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.scale import ACCEPT_CONFIDENCE, read_scale  # noqa: E402
from app.scale_synth import CONDITIONS, NEGATIVES, make_case  # noqa: E402


def pct(k: int, n: int) -> str:
    return f"{100.0 * k / n:.1f}" if n else "—"


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=50, help="images per condition")
    ap.add_argument("--threshold", type=float, default=ACCEPT_CONFIDENCE)
    ap.add_argument("--quick", action="store_true", help="10 images per condition")
    args = ap.parse_args()
    n = 10 if args.quick else args.n

    print(f"{n} görüntü x {len(CONDITIONS)} koşul, güven eşiği {args.threshold}\n")
    print("| Koşul | Doğru % | YANLIŞ % | Okunamadı % | ort. ms |")
    print("|---|---|---|---|---|")
    wrong_list = []
    tot = np.zeros(3, int)
    for ci, name in enumerate(CONDITIONS):
        c = w = u = 0
        ms = []
        for i in range(n):
            seed = 10_000 * (ci + 1) + i
            sc = make_case(name, seed)
            t0 = time.perf_counter()
            r = read_scale(sc.image, accept=args.threshold)
            ms.append((time.perf_counter() - t0) * 1000)
            if not r.ok:
                u += 1
            elif abs(r.weight_kg - sc.weight_kg) <= 1e-3:
                c += 1
            else:
                w += 1
                wrong_list.append((name, seed, f"{sc.text} {sc.unit or '(birim yok)'}", f"{r.text} {r.unit}", r.confidence))
        tot += (c, w, u)
        print(f"| {name} | {pct(c, n)} | {pct(w, n)} | {pct(u, n)} | {np.mean(ms):.0f} |")
    N = int(tot.sum())
    print(f"| **toplam ({N})** | {pct(tot[0], N)} | {pct(tot[1], N)} | {pct(tot[2], N)} |  |")

    print("\nAğırlık OLMAYAN sahneler (hepsi okunamadı olmalı):\n")
    print("| Sahne | Okunamadı % | Ağırlık döndü |")
    print("|---|---|---|")
    for name, fn in NEGATIVES.items():
        refused, got = 0, []
        for i in range(n):
            r = read_scale(fn(500 + i).image, accept=args.threshold)
            if r.ok:
                got.append(f"{r.text}{r.unit}")
            else:
                refused += 1
        print(f"| {name} | {pct(refused, n)} | {', '.join(got[:5]) or '—'} |")

    if wrong_list:
        print("\nYanlış okunanlar (koşul, tohum, doğru, okunan, güven):")
        for row in wrong_list:
            print("  ", row)


if __name__ == "__main__":
    main()
