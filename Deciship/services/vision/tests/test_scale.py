"""Free scale reader (app/scale.py): clean displays read exactly, degraded ones are read or refused,
and a wrong weight stays (near) impossible. Images are synthetic (app/scale_synth.py); real-photo
accuracy is measured separately with tools/scale_eval.py."""

import cv2
import numpy as np
import pytest

from app.main import MSG_BAD_IMAGE, MSG_SCALE_OFF, MSG_SCALE_UNREADABLE, MSG_TOO_LARGE
from app.scale import read_scale
from app.scale_synth import CONDITIONS, NEGATIVES, DisplayStyle, PhotoStyle, make_case, render_scale

from .conftest import encode
from .test_robustness import _png_header_only

CLEAN_KG = ["4.02", "12.345", "0.85", "150.5", "27.40", "3.006", "88.88", "1.111", "70.0", "9.99", "203.7", "0.125"]


def correct(r, truth_kg: float) -> bool:
    return r.ok and abs(r.weight_kg - truth_kg) <= 1e-3


def scale_post(client, data: bytes, name: str = "scale.jpg"):
    return client.post("/scale/read-free", files={"image": (name, data, "application/octet-stream")})


# --- clean displays: every one read exactly -----------------------------------------------------


@pytest.mark.parametrize("kind", ["lcd", "led"])
@pytest.mark.parametrize("text", CLEAN_KG)
def test_clean_kg_display_read_exactly(kind, text):
    sc = render_scale(text, "kg", DisplayStyle(kind=kind, n_cells=5), PhotoStyle(), seed=len(text) * 7 + (kind == "led"))
    r = read_scale(sc.image)
    assert correct(r, float(text)), (text, kind, r.text, r.reason, r.rows[:2])
    assert r.unit == "kg" and not r.unit_assumed
    assert r.text == text


@pytest.mark.parametrize("kind", ["lcd", "led"])
def test_grams_and_pounds(kind):
    g = read_scale(render_scale("2450", "g", DisplayStyle(kind=kind, unit="g"), seed=3).image)
    assert correct(g, 2.45) and g.unit == "g", (g.text, g.reason)
    lb = read_scale(render_scale("12.5", "lb", DisplayStyle(kind=kind, unit="lb"), seed=4).image)
    assert correct(lb, 12.5 * 0.45359237) and lb.unit == "lb", (lb.text, lb.reason)


def test_no_unit_legend_with_decimals_assumes_kg():
    r = read_scale(render_scale("6.25", "kg", DisplayStyle(unit=None), seed=5).image)
    assert correct(r, 6.25) and r.unit == "kg" and r.unit_assumed


def test_integer_without_unit_is_refused():
    # "625" could be grams or kilograms: never guessed.
    r = read_scale(render_scale("625", "g", DisplayStyle(unit=None), seed=6).image)
    assert not r.ok and r.weight_kg is None


def test_italic_rotated_and_perspective_display():
    style = DisplayStyle(kind="lcd", shear=0.2, n_cells=5)
    r = read_scale(render_scale("18.75", "kg", style, PhotoStyle(rotation=-9, perspective=0.03), seed=8).image)
    assert correct(r, 18.75), (r.text, r.reason)


def test_grey_input_and_blank_photo():
    sc = render_scale("5.50", "kg", DisplayStyle(), seed=9)
    assert correct(read_scale(cv2.cvtColor(sc.image, cv2.COLOR_BGR2GRAY)), 5.5)
    blank = read_scale(np.full((600, 800, 3), 128, np.uint8))
    assert not blank.ok and blank.reason == "no_digits" and blank.candidate_kg is None


# --- degraded photos: read or refused, (almost) never wrong ----------------------------------------


def test_synthetic_conditions_wrong_rate():
    n = 8
    wrong, read, total = [], 0, 0
    per = {}
    for ci, name in enumerate(CONDITIONS):
        ok_here = 0
        for i in range(n):
            sc = make_case(name, 10_000 * (ci + 1) + i)
            r = read_scale(sc.image)
            total += 1
            if r.ok:
                if abs(r.weight_kg - sc.weight_kg) <= 1e-3:
                    read += 1
                    ok_here += 1
                else:
                    wrong.append((name, i, sc.text, sc.unit, r.text, r.unit, r.confidence))
        per[name] = ok_here
    # Target: wrong < 1 %. Refusing is allowed; returning a wrong weight is not.
    assert len(wrong) <= total // 100, wrong
    # Regression guard on usefulness (not a promise for real photos).
    assert per["temiz"] >= n - 1, per
    assert read >= 0.6 * total, (read, total, per)


@pytest.mark.parametrize("name", list(NEGATIVES))
def test_scenes_without_a_weight_are_refused(name):
    for seed in range(4):
        r = read_scale(NEGATIVES[name](700 + seed).image)
        assert not r.ok and r.weight_kg is None, (name, seed, r.text, r.unit)


def test_zero_and_negative_reasons():
    assert read_scale(render_scale("0.000", "kg", seed=1).image).reason == "zero"
    assert read_scale(render_scale("-1.25", "kg", seed=1).image).reason == "negative"


def test_two_different_numbers_refused():
    # Two displays of equal size side by side (e.g. weight and price): which one is the weight?
    a = render_scale("4.02", "kg", DisplayStyle(), PhotoStyle(size=(640, 960), display_frac=0.8), seed=11).image
    b = render_scale("7.35", "kg", DisplayStyle(), PhotoStyle(size=(640, 960), display_frac=0.8), seed=12).image
    r = read_scale(np.hstack([a, b]))
    assert not r.ok and r.weight_kg is None, (r.text, r.reason)


# --- endpoint ------------------------------------------------------------------------------------


def test_endpoint_off_by_default(client, monkeypatch):
    monkeypatch.delenv("SCALE_FREE_READ", raising=False)
    sc = render_scale("4.02", "kg", seed=1)
    r = scale_post(client, encode(sc.image, ".jpg"))
    assert r.status_code == 404
    assert r.json() == {"ok": False, "message": MSG_SCALE_OFF}
    monkeypatch.setenv("SCALE_FREE_READ", "0")
    assert scale_post(client, encode(sc.image, ".jpg")).status_code == 404


def test_endpoint_reads_when_enabled(client, monkeypatch):
    monkeypatch.setenv("SCALE_FREE_READ", "1")
    sc = render_scale("12.345", "kg", DisplayStyle(kind="led"), seed=2)
    r = scale_post(client, encode(sc.image, ".jpg"))
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["ok"] is True and j["weightKg"] == 12.345 and j["unit"] == "kg" and j["rawText"] == "12.345"
    assert 0.7 <= j["confidence"] <= 1.0 and j["reason"] is None


def test_endpoint_unreadable_returns_no_weight(client, monkeypatch):
    monkeypatch.setenv("SCALE_FREE_READ", "1")
    j = scale_post(client, encode(NEGATIVES["ibreli terazi"](1).image, ".jpg")).json()
    assert j["ok"] is False and j["weightKg"] is None and j["rawText"] == "" and j["message"] == MSG_SCALE_UNREADABLE
    assert j["reason"]


def test_endpoint_same_image_limits_as_detect(client, monkeypatch):
    monkeypatch.setenv("SCALE_FREE_READ", "1")
    big = scale_post(client, _png_header_only(8000, 7000), "big.png")
    assert big.status_code == 400 and big.json() == {"ok": False, "message": MSG_TOO_LARGE}
    bad = scale_post(client, b"%PDF-1.7\n" + b"0" * 100, "x.pdf")
    assert bad.status_code == 400 and bad.json() == {"ok": False, "message": MSG_BAD_IMAGE}
