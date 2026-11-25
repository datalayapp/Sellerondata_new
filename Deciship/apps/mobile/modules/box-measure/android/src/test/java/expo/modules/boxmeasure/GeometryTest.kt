package expo.modules.boxmeasure

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.PI
import kotlin.random.Random

class GeometryTest {

  @Test
  fun roundCm1_roundsToTenthOfCentimetre() {
    assertEquals(32.4, Geometry.roundCm1(0.32436f), 1e-9)
    assertEquals(32.5, Geometry.roundCm1(0.32451f), 1e-9)
    assertEquals(0.0, Geometry.roundCm1(0f), 1e-9)
  }

  @Test
  fun convexHull_dropsInteriorPoints() {
    val pts = listOf(Vec2(0f, 0f), Vec2(1f, 0f), Vec2(1f, 1f), Vec2(0f, 1f), Vec2(0.5f, 0.5f), Vec2(0.2f, 0.7f))
    val hull = Geometry.convexHull(pts)
    assertEquals(4, hull.size)
    assertFalse(hull.contains(Vec2(0.5f, 0.5f)))
  }

  @Test
  fun minAreaRect_axisAligned() {
    val pts = gridRect(0.40f, 0.30f, angle = 0.0)
    val r = Geometry.minAreaRect(pts)!!
    assertEquals(0.40f, r.length, 1e-4f)
    assertEquals(0.30f, r.width, 1e-4f)
  }

  @Test
  fun minAreaRect_rotatedRectangleRecoversSides() {
    for (deg in listOf(10.0, 33.0, 45.0, 71.0, 120.0)) {
      val pts = gridRect(0.52f, 0.21f, angle = deg * PI / 180.0, cx = 1.3f, cy = -0.7f)
      val r = Geometry.minAreaRect(pts)!!
      assertEquals("açı $deg uzunluk", 0.52f, r.length, 1e-3f)
      assertEquals("açı $deg genişlik", 0.21f, r.width, 1e-3f)
      assertEquals(1.3f, r.center.x, 1e-3f)
      assertEquals(-0.7f, r.center.y, 1e-3f)
    }
  }

  @Test
  fun trimmedRect_ignoresFewOutliers() {
    val rnd = Random(7)
    val pts = ArrayList(gridRect(0.30f, 0.20f, angle = 0.4))
    // 3 uzak gürültü noktası (uçan pikseller)
    pts.add(Vec2(0.6f, 0.6f)); pts.add(Vec2(-0.5f, 0.4f)); pts.add(Vec2(0.1f, -0.55f))
    repeat(50) { pts.add(Vec2(rnd.nextFloat() * 0.01f, rnd.nextFloat() * 0.01f)) }
    val raw = Geometry.minAreaRect(pts)!!
    assertTrue(raw.length > 0.5f)
    val trimmed = Geometry.trimmedRect(pts, Geometry.minAreaRect(gridRect(0.30f, 0.20f, angle = 0.4))!!, 0.01f)
    assertEquals(0.30f, trimmed.length, 0.01f)
    assertEquals(0.20f, trimmed.width, 0.01f)
  }

  @Test
  fun closestHeight_horizontalRayHitsAtSameHeight() {
    // Kamera 1 m uzakta, 0,25 m yükseklikte, dikey çizgiye doğru yatay bakıyor.
    val t = Geometry.closestHeightOnVerticalLine(
      base = Vec3(0f, 0f, 0f), up = Vec3.UP,
      rayOrigin = Vec3(0f, 0.25f, 1f), rayDir = Vec3(0f, 0f, -1f),
    )
    assertEquals(0.25f, t!!, 1e-5f)
  }

  @Test
  fun closestHeight_tiltedRayAimingAtTopCorner() {
    val top = Vec3(0.1f, 0.18f, -0.2f)
    val base = Vec3(0.1f, 0f, -0.2f)
    val origin = Vec3(0.4f, 0.5f, 0.5f)
    val t = Geometry.closestHeightOnVerticalLine(base, Vec3.UP, origin, top - origin)
    assertEquals(0.18f, t!!, 1e-4f)
  }

  @Test
  fun closestHeight_rayMissingLineGivesNearestPoint() {
    // Işın çizginin 5 cm yanından geçiyor; en yakın nokta yine ~0,30 m.
    val t = Geometry.closestHeightOnVerticalLine(
      base = Vec3(0f, 0f, 0f), up = Vec3.UP,
      rayOrigin = Vec3(0.05f, 0.30f, 1f), rayDir = Vec3(0f, 0f, -1f),
    )
    assertEquals(0.30f, t!!, 1e-5f)
  }

  @Test
  fun closestHeight_parallelRayReturnsNull() {
    assertNull(Geometry.closestHeightOnVerticalLine(Vec3(0f, 0f, 0f), Vec3.UP, Vec3(1f, 0f, 0f), Vec3(0f, 1f, 0f)))
  }

  @Test
  fun supportPlane_picksTableNotFloorNorBoxTop() {
    val ys = ArrayList<Float>()
    val rnd = Random(1)
    repeat(2000) { ys.add(0.00f + (rnd.nextFloat() - 0.5f) * 0.006f) } // zemin
    repeat(3000) { ys.add(0.75f + (rnd.nextFloat() - 0.5f) * 0.006f) } // masa
    repeat(2500) { ys.add(0.95f + (rnd.nextFloat() - 0.5f) * 0.006f) } // kutu üstü
    repeat(500) { ys.add(0.75f + rnd.nextFloat() * 0.2f) } // kutu yanları
    val h = Geometry.estimateSupportPlaneHeight(ys.toFloatArray(), topEstimate = 0.95f)
    assertNotNull(h)
    assertEquals(0.75f, h!!, 0.005f)
  }

  @Test
  fun percentile_andMedian() {
    val v = floatArrayOf(5f, 1f, 3f, 2f, 4f)
    assertEquals(3f, Geometry.percentile(v, 0.5f), 1e-6f)
    assertEquals(5f, Geometry.percentile(v, 1f), 1e-6f)
    assertEquals(2.5f, Geometry.median(listOf(1f, 2f, 3f, 4f)), 1e-6f)
  }

  @Test
  fun cornerState_fullFlow() {
    val s = CornerMeasureState()
    assertEquals(CornerMeasureState.Phase.SCAN, s.phase)
    assertFalse(s.tap(Vec3(0f, 0f, 0f)))
    s.onPlaneDetected()
    assertTrue(s.tap(Vec3(0f, 0f, 0f)))
    assertTrue(s.tap(Vec3(0.40f, 0f, 0f)))
    assertTrue(s.tap(Vec3(0.40f, 0f, -0.30f)))
    assertEquals(CornerMeasureState.Phase.HEIGHT, s.phase)
    // Üst köşeye nişan: C + 0,2 m yukarı
    val origin = Vec3(0.9f, 0.6f, 0.4f)
    s.updateHeightFromRay(origin, Vec3(0.40f, 0.20f, -0.30f) - origin)
    assertTrue(s.tap(null))
    assertEquals(CornerMeasureState.Phase.DONE, s.phase)
    assertEquals(40.0, Geometry.roundCm1(s.lengthM!!), 1e-9)
    assertEquals(30.0, Geometry.roundCm1(s.widthM!!), 1e-9)
    assertEquals(20.0, Geometry.roundCm1(s.heightM!!), 1e-9)
    val box = s.boxCorners()!!
    assertEquals(8, box.size)
    assertEquals(0f, box[3].x, 1e-6f) // D = A + C - B
    assertEquals(-0.30f, box[3].z, 1e-6f)

    s.undo()
    assertEquals(CornerMeasureState.Phase.HEIGHT, s.phase)
    s.undo()
    assertEquals(CornerMeasureState.Phase.CORNER3, s.phase)
    s.reset()
    assertEquals(CornerMeasureState.Phase.CORNER1, s.phase)
  }

  @Test
  fun cornerState_rejectsDuplicateTapAndZeroHeight() {
    val s = CornerMeasureState()
    s.onPlaneDetected()
    assertTrue(s.tap(Vec3(0f, 0f, 0f)))
    assertFalse(s.tap(Vec3(0.002f, 0f, 0f)))
    assertTrue(s.tap(Vec3(0.3f, 0f, 0f)))
    assertTrue(s.tap(Vec3(0.3f, 0f, 0.2f)))
    assertFalse(s.tap(null)) // yükseklik 0
  }

  private fun gridRect(l: Float, w: Float, angle: Double, cx: Float = 0f, cy: Float = 0f): List<Vec2> {
    val u = Geometry.dir(angle)
    val n = Vec2(-u.y, u.x)
    val out = ArrayList<Vec2>()
    val steps = 20
    for (i in 0..steps) for (j in 0..steps) {
      val a = -l / 2 + l * i / steps
      val b = -w / 2 + w * j / steps
      out.add(Vec2(cx + u.x * a + n.x * b, cy + u.y * a + n.y * b))
    }
    return out
  }
}
