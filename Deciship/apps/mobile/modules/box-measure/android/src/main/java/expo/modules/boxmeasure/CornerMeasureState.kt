package expo.modules.boxmeasure

import kotlin.math.max

/**
 * AR köşe işaretleme akışının saf durum makinesi (ARCore'dan bağımsız, birim testli).
 * A→B = uzunluk, B→C = genişlik, C'den dikey çizgi = yükseklik.
 */
class CornerMeasureState(private val up: Vec3 = Vec3.UP) {

  enum class Phase { SCAN, CORNER1, CORNER2, CORNER3, HEIGHT, DONE }

  private val corners = ArrayList<Vec3>(3)
  private var planeFound = false

  /** Yükseklik aşamasında canlı değer (m). */
  var liveHeight: Float = 0f
    private set

  /** Onaylanmış yükseklik (m), yoksa null. */
  var confirmedHeight: Float? = null
    private set

  val points: List<Vec3> get() = corners.toList()

  val phase: Phase
    get() = when {
      !planeFound && corners.isEmpty() -> Phase.SCAN
      corners.size == 0 -> Phase.CORNER1
      corners.size == 1 -> Phase.CORNER2
      corners.size == 2 -> Phase.CORNER3
      confirmedHeight == null -> Phase.HEIGHT
      else -> Phase.DONE
    }

  fun onPlaneDetected() {
    planeFound = true
  }

  /**
   * Dokunma. Köşe aşamalarında [aim] (nişangâhın düzlemdeki noktası) gerekir;
   * yükseklik aşamasında o anki canlı yükseklik onaylanır. Kabul edildiyse true.
   */
  fun tap(aim: Vec3?): Boolean {
    return when (phase) {
      Phase.SCAN -> false
      Phase.CORNER1, Phase.CORNER2, Phase.CORNER3 -> {
        if (aim == null) return false
        // Aynı noktaya çift dokunmayı engelle (< 1 cm).
        if (corners.isNotEmpty() && Geometry.distance(corners.last(), aim) < 0.01f) return false
        corners.add(aim)
        if (corners.size == 3) liveHeight = 0f
        true
      }
      Phase.HEIGHT -> {
        if (liveHeight < 0.005f) return false
        confirmedHeight = liveHeight
        true
      }
      Phase.DONE -> false
    }
  }

  /** Yükseklik aşamasında kamera ışınıyla canlı yüksekliği günceller. */
  fun updateHeightFromRay(rayOrigin: Vec3, rayDir: Vec3) {
    if (phase != Phase.HEIGHT) return
    val c = corners[2]
    val t = Geometry.closestHeightOnVerticalLine(c, up, rayOrigin, rayDir) ?: return
    liveHeight = max(0f, t).coerceAtMost(MAX_HEIGHT_M)
  }

  fun undo() {
    when {
      confirmedHeight != null -> confirmedHeight = null
      corners.isNotEmpty() -> corners.removeAt(corners.size - 1)
    }
  }

  fun reset() {
    corners.clear()
    confirmedHeight = null
    liveHeight = 0f
  }

  val lengthM: Float? get() = if (corners.size >= 2) Geometry.distance(corners[0], corners[1]) else null
  val widthM: Float? get() = if (corners.size >= 3) Geometry.distance(corners[1], corners[2]) else null
  val heightM: Float? get() = confirmedHeight ?: if (phase == Phase.HEIGHT) liveHeight else null

  /** Tel kafes köşeleri (yükseklik aşamasından itibaren). */
  fun boxCorners(): List<Vec3>? {
    if (corners.size < 3) return null
    return Geometry.boxCorners(corners[0], corners[1], corners[2], up, heightM ?: 0f)
  }

  fun instruction(): String = when (phase) {
    Phase.SCAN -> "Masayı tarayın: telefonu yavaşça gezdirin"
    Phase.CORNER1 -> "Nişangâhı kolinin 1. alt köşesine getirip dokunun"
    Phase.CORNER2 -> "2. köşeye dokunun (uzunluk)"
    Phase.CORNER3 -> "3. köşeye dokunun (genişlik)"
    Phase.HEIGHT -> "Telefonu yukarı doğrultun, nişangâhı üst köşeye getirip dokunun"
    Phase.DONE -> "Ölçüm tamam. Kaydet'e basın"
  }

  companion object {
    const val MAX_HEIGHT_M = 3f
  }
}
