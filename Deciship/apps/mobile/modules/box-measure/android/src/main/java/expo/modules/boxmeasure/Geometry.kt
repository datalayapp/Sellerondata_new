package expo.modules.boxmeasure

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * Saf geometri yardımcıları (Android/ARCore'dan bağımsız, birim testli).
 * Aynı algoritmaların Swift karşılıkları ios/MeasureGeometry.swift içindedir.
 * Birimler: metre (dünya koordinatı), sonuçlar cm'ye çevrilirken [roundCm1] kullanılır.
 */
data class Vec3(val x: Float, val y: Float, val z: Float) {
  operator fun plus(o: Vec3) = Vec3(x + o.x, y + o.y, z + o.z)
  operator fun minus(o: Vec3) = Vec3(x - o.x, y - o.y, z - o.z)
  operator fun times(s: Float) = Vec3(x * s, y * s, z * s)
  fun dot(o: Vec3) = x * o.x + y * o.y + z * o.z
  fun length() = sqrt(dot(this))
  fun normalized(): Vec3 {
    val l = length()
    return if (l < 1e-9f) this else this * (1f / l)
  }

  companion object {
    val UP = Vec3(0f, 1f, 0f)
  }
}

data class Vec2(val x: Float, val y: Float) {
  operator fun minus(o: Vec2) = Vec2(x - o.x, y - o.y)
  fun cross(o: Vec2) = x * o.y - y * o.x
  fun dot(o: Vec2) = x * o.x + y * o.y
}

/** Döndürülmüş dikdörtgen: merkez, birim eksen [axis] (uzun kenar yönü), uzun/kısa kenar. */
data class RotatedRect(val center: Vec2, val axis: Vec2, val length: Float, val width: Float) {
  val area: Float get() = length * width

  /** Köşeler (saat yönünün tersine). */
  fun corners(): List<Vec2> {
    val n = Vec2(-axis.y, axis.x)
    val hl = length / 2f
    val hw = width / 2f
    return listOf(
      Vec2(center.x - axis.x * hl - n.x * hw, center.y - axis.y * hl - n.y * hw),
      Vec2(center.x + axis.x * hl - n.x * hw, center.y + axis.y * hl - n.y * hw),
      Vec2(center.x + axis.x * hl + n.x * hw, center.y + axis.y * hl + n.y * hw),
      Vec2(center.x - axis.x * hl + n.x * hw, center.y - axis.y * hl + n.y * hw),
    )
  }
}

object Geometry {

  /** Metreden santimetreye, 0,1 cm'ye yuvarlanmış. */
  fun roundCm1(meters: Float): Double = (meters * 1000.0).roundToInt() / 10.0

  fun distance(a: Vec3, b: Vec3): Float = (a - b).length()

  /**
   * Dikey doğru (taban noktası [base], birim yön [up]) üzerinde, ışına
   * ([rayOrigin], [rayDir]) en yakın noktanın [up] boyunca parametresi (metre).
   * İki doğru arasındaki en kısa mesafe formülü. Işın dikey doğruya paralelse null.
   * Sonuç ışının arkasına düşüyorsa (s < 0) ışın başlangıcı kullanılır.
   */
  fun closestHeightOnVerticalLine(base: Vec3, up: Vec3, rayOrigin: Vec3, rayDir: Vec3): Float? {
    val u = up.normalized()
    val d = rayDir.normalized()
    val w0 = base - rayOrigin
    val b = u.dot(d)
    val denom = 1f - b * b // a = c = 1 (birim vektörler)
    if (denom < 1e-6f) return null
    val dd = u.dot(w0)
    val e = d.dot(w0)
    // Doğru1: base + t*u, Doğru2: rayOrigin + s*d
    var t = (b * e - dd) / denom
    val s = (e - b * dd) / denom
    if (s < 0f) {
      // Işın geriye bakıyor: kamera konumunun dikey doğruya izdüşümü.
      t = -dd
    }
    return t
  }

  /** Andrew monotone chain dışbükey zarf (saat yönünün tersine, tekrar yok). */
  fun convexHull(points: List<Vec2>): List<Vec2> {
    if (points.size < 3) return points.distinct()
    val sorted = points.sortedWith(compareBy<Vec2>({ it.x }, { it.y }))
    val lower = ArrayList<Vec2>()
    for (p in sorted) {
      while (lower.size >= 2 && (lower[lower.size - 1] - lower[lower.size - 2]).cross(p - lower[lower.size - 2]) <= 0f) {
        lower.removeAt(lower.size - 1)
      }
      lower.add(p)
    }
    val upper = ArrayList<Vec2>()
    for (p in sorted.asReversed()) {
      while (upper.size >= 2 && (upper[upper.size - 1] - upper[upper.size - 2]).cross(p - upper[upper.size - 2]) <= 0f) {
        upper.removeAt(upper.size - 1)
      }
      upper.add(p)
    }
    lower.removeAt(lower.size - 1)
    upper.removeAt(upper.size - 1)
    return lower + upper
  }

  /**
   * En küçük alanlı döndürülmüş dikdörtgen (dönen kumpas ilkesi: en iyi dikdörtgenin
   * bir kenarı dışbükey zarfın bir kenarıyla çakışır). Zarf kenarı başına O(n).
   */
  fun minAreaRect(points: List<Vec2>): RotatedRect? {
    val hull = convexHull(points)
    if (hull.isEmpty()) return null
    if (hull.size == 1) return RotatedRect(hull[0], Vec2(1f, 0f), 0f, 0f)
    var best: RotatedRect? = null
    for (i in hull.indices) {
      val p0 = hull[i]
      val p1 = hull[(i + 1) % hull.size]
      val ex = p1.x - p0.x
      val ey = p1.y - p0.y
      val len = sqrt(ex * ex + ey * ey)
      if (len < 1e-9f) continue
      val ux = ex / len
      val uy = ey / len
      var minU = Float.MAX_VALUE; var maxU = -Float.MAX_VALUE
      var minV = Float.MAX_VALUE; var maxV = -Float.MAX_VALUE
      for (q in hull) {
        val pu = q.x * ux + q.y * uy
        val pv = -q.x * uy + q.y * ux
        minU = min(minU, pu); maxU = max(maxU, pu)
        minV = min(minV, pv); maxV = max(maxV, pv)
      }
      val du = maxU - minU
      val dv = maxV - minV
      val area = du * dv
      if (best == null || area < best.area - 1e-12f) {
        val cu = (minU + maxU) / 2f
        val cv = (minV + maxV) / 2f
        val center = Vec2(cu * ux - cv * uy, cu * uy + cv * ux)
        best = if (du >= dv) RotatedRect(center, Vec2(ux, uy), du, dv)
        else RotatedRect(center, Vec2(-uy, ux), dv, du)
      }
    }
    return best
  }

  /**
   * Dikdörtgenin yönünü koruyup kenarları yüzdelik dilimle yeniden hesaplar
   * (uç/gürültülü noktalar dikdörtgeni şişirmesin). [trim] = her uçtan atılan oran.
   */
  fun trimmedRect(points: List<Vec2>, rect: RotatedRect, trim: Float = 0.01f): RotatedRect {
    if (points.size < 10) return rect
    val ux = rect.axis.x; val uy = rect.axis.y
    val us = FloatArray(points.size) { points[it].x * ux + points[it].y * uy }
    val vs = FloatArray(points.size) { -points[it].x * uy + points[it].y * ux }
    us.sort(); vs.sort()
    val lo = percentileSorted(us, trim); val hi = percentileSorted(us, 1f - trim)
    val loV = percentileSorted(vs, trim); val hiV = percentileSorted(vs, 1f - trim)
    val cu = (lo + hi) / 2f; val cv = (loV + hiV) / 2f
    val center = Vec2(cu * ux - cv * uy, cu * uy + cv * ux)
    val du = hi - lo; val dv = hiV - loV
    return if (du >= dv) RotatedRect(center, rect.axis, du, dv)
    else RotatedRect(center, Vec2(-uy, ux), dv, du)
  }

  /** Sıralı dizide doğrusal enterpolasyonlu yüzdelik (q: 0..1). */
  fun percentileSorted(sorted: FloatArray, q: Float): Float {
    if (sorted.isEmpty()) return 0f
    val pos = q.coerceIn(0f, 1f) * (sorted.size - 1)
    val i = pos.toInt()
    val f = pos - i
    return if (i + 1 < sorted.size) sorted[i] * (1 - f) + sorted[i + 1] * f else sorted[i]
  }

  fun percentile(values: FloatArray, q: Float): Float = percentileSorted(values.copyOf().also { it.sort() }, q)

  fun median(values: List<Float>): Float = percentile(values.toFloatArray(), 0.5f)

  fun stdDev(values: List<Float>): Float {
    if (values.size < 2) return 0f
    val m = values.average().toFloat()
    return sqrt(values.sumOf { ((it - m) * (it - m)).toDouble() }.toFloat() / (values.size - 1))
  }

  /**
   * Destek düzlemi yüksekliği (dünya Y'si yukarı): Y değerlerinin 1 cm'lik histogramındaki
   * tepelerden, kutu üst yüzeyi tahmininin ([topEstimate]) en az [minGap] altındaki EN YÜKSEK
   * tepe seçilir (masa, zeminden önce gelir). Yeterli destek yoksa null.
   */
  fun estimateSupportPlaneHeight(
    ys: FloatArray,
    topEstimate: Float,
    minGap: Float = 0.02f,
    binSize: Float = 0.01f,
    minFraction: Float = 0.03f,
    minCount: Int = 50,
  ): Float? {
    if (ys.isEmpty()) return null
    var lo = Float.MAX_VALUE; var hi = -Float.MAX_VALUE
    for (y in ys) { lo = min(lo, y); hi = max(hi, y) }
    val n = ((hi - lo) / binSize).toInt() + 1
    if (n <= 0 || n > 100_000) return null
    val hist = IntArray(n)
    for (y in ys) hist[((y - lo) / binSize).toInt().coerceIn(0, n - 1)]++
    val need = max(minCount, (ys.size * minFraction).toInt())
    var bestBin = -1
    for (i in 0 until n) {
      val c = hist[i]
      val left = if (i > 0) hist[i - 1] else 0
      val right = if (i < n - 1) hist[i + 1] else 0
      val isPeak = c >= left && c >= right
      val center = lo + (i + 0.5f) * binSize
      if (isPeak && c + left + right >= need && center < topEstimate - minGap) bestBin = i
    }
    if (bestBin < 0) return null
    // İnce ayar: tepenin ±1,5 cm çevresindeki noktaların ortalaması.
    val c0 = lo + (bestBin + 0.5f) * binSize
    var sum = 0.0; var cnt = 0
    for (y in ys) if (abs(y - c0) <= 0.015f) { sum += y; cnt++ }
    return if (cnt > 0) (sum / cnt).toFloat() else c0
  }

  /** Taban dikdörtgeni A,B,C (D = A + C - B) ve yükseklikten 8 köşe: 0..3 alt, 4..7 üst. */
  fun boxCorners(a: Vec3, b: Vec3, c: Vec3, up: Vec3, height: Float): List<Vec3> {
    val d = a + (c - b)
    val h = up.normalized() * height
    return listOf(a, b, c, d, a + h, b + h, c + h, d + h)
  }

  /** Kutu tel kafesinin 12 kenarı (köşe indeks çiftleri). */
  val BOX_EDGES: List<Pair<Int, Int>> = listOf(
    0 to 1, 1 to 2, 2 to 3, 3 to 0,
    4 to 5, 5 to 6, 6 to 7, 7 to 4,
    0 to 4, 1 to 5, 2 to 6, 3 to 7,
  )

  /** Açıdan (radyan) birim yön — testler için. */
  fun dir(angle: Double) = Vec2(cos(angle).toFloat(), sin(angle).toFloat())
}
