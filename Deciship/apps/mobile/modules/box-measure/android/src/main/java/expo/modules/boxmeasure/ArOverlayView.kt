package expo.modules.boxmeasure

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View

/** GL iş parçacığında hesaplanan, ekran pikseline izdüşürülmüş çizim modeli. */
internal data class OverlayModel(
  val segments: List<Segment> = emptyList(),
  val dots: List<Dot> = emptyList(),
  val labels: List<Label> = emptyList(),
  val reticleOnPlane: Boolean = false,
  val showReticle: Boolean = true,
) {
  data class Segment(val x1: Float, val y1: Float, val x2: Float, val y2: Float, val accent: Boolean, val dashed: Boolean = false)
  data class Dot(val x: Float, val y: Float, val text: String)
  data class Label(val x: Float, val y: Float, val text: String)
}

/** Kamera görüntüsünün üstüne 2B çizim: nişangâh, köşeler, kenarlar, cm etiketleri. */
internal class ArOverlayView(context: Context) : View(context) {
  var model: OverlayModel = OverlayModel()
    set(value) {
      field = value
      invalidate()
    }

  private val density = resources.displayMetrics.density
  private val blue = Color.rgb(0x0f, 0x62, 0xfe)
  private val green = Color.rgb(0x24, 0xa1, 0x48)

  private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeWidth = 3f * density
    strokeCap = Paint.Cap.ROUND
  }
  private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val dotRing = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeWidth = 2f * density; color = Color.WHITE
  }
  private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE
    textSize = 18f * density
    isFakeBoldText = true
    textAlign = Paint.Align.CENTER
  }
  private val labelBg = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(220, 0x16, 0x16, 0x16) }
  private val reticlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE; strokeWidth = 3f * density
  }
  private val dashEffect = android.graphics.DashPathEffect(floatArrayOf(10f * density, 8f * density), 0f)

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val m = model
    for (s in m.segments) {
      linePaint.color = if (s.accent) blue else Color.WHITE
      linePaint.pathEffect = if (s.dashed) dashEffect else null
      canvas.drawLine(s.x1, s.y1, s.x2, s.y2, linePaint)
    }
    for (d in m.dots) {
      dotPaint.color = blue
      canvas.drawCircle(d.x, d.y, 8f * density, dotPaint)
      canvas.drawCircle(d.x, d.y, 8f * density, dotRing)
      if (d.text.isNotEmpty()) drawLabel(canvas, d.x, d.y - 22f * density, d.text)
    }
    for (l in m.labels) drawLabel(canvas, l.x, l.y, l.text)

    if (m.showReticle) {
      val cx = width / 2f
      val cy = height / 2f
      val r = 18f * density
      reticlePaint.color = if (m.reticleOnPlane) green else Color.WHITE
      canvas.drawCircle(cx, cy, r, reticlePaint)
      canvas.drawLine(cx - r * 1.6f, cy, cx - r * 0.5f, cy, reticlePaint)
      canvas.drawLine(cx + r * 0.5f, cy, cx + r * 1.6f, cy, reticlePaint)
      canvas.drawLine(cx, cy - r * 1.6f, cx, cy - r * 0.5f, reticlePaint)
      canvas.drawLine(cx, cy + r * 0.5f, cx, cy + r * 1.6f, reticlePaint)
      canvas.drawCircle(cx, cy, 2.5f * density, reticlePaint)
    }
  }

  private fun drawLabel(canvas: Canvas, x: Float, y: Float, text: String) {
    val w = textPaint.measureText(text) + 16f * density
    val h = textPaint.textSize + 10f * density
    canvas.drawRect(RectF(x - w / 2, y - h / 2, x + w / 2, y + h / 2), labelBg)
    canvas.drawText(text, x, y + textPaint.textSize / 3f, textPaint)
  }
}
