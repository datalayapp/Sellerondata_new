import numpy as np
import pytest

from app.detect import find_marker
from app.geometry import MARKER_OBJECT_POINTS, estimate_intrinsics, focal_from_marker
from app.synth import project_world

from .conftest import BOXES, VIEWS, scene


@pytest.mark.parametrize("focal", [900.0, 1300.0, 1800.0])
@pytest.mark.parametrize("view", VIEWS)
def test_focal_from_exact_marker(view, focal):
    sc = scene(BOXES[0], view, focal=focal)
    f = focal_from_marker(sc.marker_corners, 1600, 1200)
    assert f == pytest.approx(focal, rel=1e-4)


@pytest.mark.parametrize("view", VIEWS)
def test_focal_from_detected_marker(view):
    sc = scene(BOXES[0], view)
    m = find_marker(sc.image)
    intr = estimate_intrinsics(m.corners, 1600, 1200, None)
    assert intr.source == "estimated"
    assert intr.fx == pytest.approx(1300.0, rel=0.06)
    assert (intr.cx, intr.cy) == (800.0, 600.0)


def test_frontal_marker_falls_back_to_default():
    K = np.array([[1200.0, 0, 800], [0, 1200.0, 600], [0, 0, 1]])
    R = np.diag([1.0, -1.0, -1.0])  # camera straight above the table looking down
    t = np.array([0.0, 0.0, 800.0])
    corners = project_world(MARKER_OBJECT_POINTS, K, R, t)
    intr = estimate_intrinsics(corners, 1600, 1200, None)
    assert intr.source == "default"
    assert intr.fx == pytest.approx(0.8 * 1600)


def test_exif_has_priority():
    sc = scene(BOXES[0], VIEWS[0])
    intr = estimate_intrinsics(sc.marker_corners, 4000, 3000, 26.0)
    assert intr.source == "exif"
    assert intr.fx == pytest.approx(26 * 5000 / 43.2666, rel=1e-4)
