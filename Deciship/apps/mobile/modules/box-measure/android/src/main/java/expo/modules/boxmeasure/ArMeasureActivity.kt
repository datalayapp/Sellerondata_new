package expo.modules.boxmeasure

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.opengl.Matrix
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.Surface
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Config
import com.google.ar.core.Plane
import com.google.ar.core.Session
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import com.google.ar.core.exceptions.CameraNotAvailableException
import com.google.ar.core.exceptions.UnavailableApkTooOldException
import com.google.ar.core.exceptions.UnavailableArcoreNotInstalledException
import com.google.ar.core.exceptions.UnavailableDeviceNotCompatibleException
import com.google.ar.core.exceptions.UnavailableSdkTooOldException
import com.google.ar.core.exceptions.UnavailableUserDeclinedInstallationException
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Locale
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10
import kotlin.math.abs

/**
 * Tam ekran AR köşe işaretleme ölçümü (ARCore + OpenGL ES 2.0 + 2B Canvas katmanı).
 * Durum ([CornerMeasureState]) yalnızca GL iş parçacığında değiştirilir; UI olayları
 * [GLSurfaceView.queueEvent] ile oraya aktarılır, çizim modeli UI'a [View.post] ile gelir.
 */
class ArMeasureActivity : Activity(), GLSurfaceView.Renderer {

  private lateinit var glView: GLSurfaceView
  private lateinit var overlay: ArOverlayView
  private lateinit var instructionText: TextView
  private lateinit var valuesText: TextView
  private lateinit var undoButton: Button
  private lateinit var resetButton: Button
  private lateinit var saveButton: Button

  private var session: Session? = null
  private var installRequested = false
  private var finished = false

  // --- yalnızca GL iş parçacığı ---
  private val background = CameraBackgroundRenderer()
  private val state = CornerMeasureState()
  private var textureBound = false
  private var viewportW = 0
  private var viewportH = 0
  private var displayChanged = false
  private var lastPlaneY: Float? = null
  private val tapDistances = ArrayList<Float>()
  private var captureRequested = false
  private val viewM = FloatArray(16)
  private val projM = FloatArray(16)
  private val vpM = FloatArray(16)
  private val invVpM = FloatArray(16)

  // ---------------------------------------------------------------- yaşam döngüsü

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    buildUi()
  }

  override fun onResume() {
    super.onResume()
    if (finished) return
    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
      return
    }
    if (session == null && !createSession()) return
    try {
      session?.resume()
    } catch (e: CameraNotAvailableException) {
      fail("ERR_CAMERA", "Kamera açılamadı. Başka bir uygulama kullanıyor olabilir.")
      return
    }
    glView.onResume()
    displayChanged = true
  }

  override fun onPause() {
    super.onPause()
    if (::glView.isInitialized) glView.onPause()
    session?.pause()
  }

  override fun onDestroy() {
    super.onDestroy()
    session?.close()
    session = null
    if (!finished) {
      finished = true
      PendingMeasure.resolve(null)
    }
  }

  @Deprecated("Activity.onBackPressed")
  override fun onBackPressed() {
    cancel()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    if (requestCode != REQ_CAMERA) return
    if (grantResults.isEmpty() || grantResults[0] != PackageManager.PERMISSION_GRANTED) {
      fail("ERR_CAMERA_PERMISSION", "Kamera izni verilmedi. Ayarlar'dan DeciShip için kamera iznini açın.")
    }
    // İzin verildiyse onResume tekrar çağrılır.
  }

  /** ARCore kurulumu + oturum. Kurulum istendiyse false döner (onResume yeniden gelir). */
  private fun createSession(): Boolean {
    try {
      when (ArCoreApk.getInstance().requestInstall(this, !installRequested)) {
        ArCoreApk.InstallStatus.INSTALL_REQUESTED -> {
          installRequested = true
          return false
        }
        ArCoreApk.InstallStatus.INSTALLED -> Unit
      }
      val s = Session(this)
      val config = Config(s).apply {
        planeFindingMode = Config.PlaneFindingMode.HORIZONTAL
        updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
        focusMode = Config.FocusMode.AUTO
        lightEstimationMode = Config.LightEstimationMode.DISABLED
      }
      s.configure(config)
      session = s
      return true
    } catch (e: UnavailableUserDeclinedInstallationException) {
      fail("ERR_AR_NOT_INSTALLED", "Google Play AR hizmetleri kurulmadı. AR ölçümü için kurulum gerekli.")
    } catch (e: UnavailableArcoreNotInstalledException) {
      fail("ERR_AR_NOT_INSTALLED", "Google Play AR hizmetleri kurulu değil.")
    } catch (e: UnavailableApkTooOldException) {
      fail("ERR_AR_OUTDATED", "Google Play AR hizmetlerini güncelleyin.")
    } catch (e: UnavailableSdkTooOldException) {
      fail("ERR_AR_OUTDATED", "Uygulamanın AR bileşeni eski; uygulamayı güncelleyin.")
    } catch (e: UnavailableDeviceNotCompatibleException) {
      fail("ERR_AR_UNSUPPORTED", "Bu cihaz ARCore desteklemiyor.")
    } catch (e: Exception) {
      Log.e(TAG, "ARCore oturumu açılamadı", e)
      fail("ERR_AR_SESSION", "AR kamerası başlatılamadı. Referans kartı veya manuel ölçüm kullanın.")
    }
    return false
  }

  // ---------------------------------------------------------------- arayüz

  private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

  private fun buildUi() {
    val root = FrameLayout(this)
    root.setBackgroundColor(Color.BLACK)

    glView = GLSurfaceView(this).apply {
      preserveEGLContextOnPause = true
      setEGLContextClientVersion(2)
      setEGLConfigChooser(8, 8, 8, 8, 16, 0)
      setRenderer(this@ArMeasureActivity)
      renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
      setWillNotDraw(false)
    }
    root.addView(glView, FrameLayout.LayoutParams(MATCH, MATCH))

    overlay = ArOverlayView(this)
    overlay.setOnTouchListener(TapDetector { glView.queueEvent { onTapGl() } })
    root.addView(overlay, FrameLayout.LayoutParams(MATCH, MATCH))

    instructionText = TextView(this).apply {
      setTextColor(Color.WHITE)
      textSize = 20f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
      setBackgroundColor(Color.argb(200, 0x16, 0x16, 0x16))
      setPadding(dp(16), dp(14), dp(16), dp(14))
      text = getString(R.string.bm_scan)
    }
    root.addView(instructionText, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.TOP).apply { topMargin = dp(32) })

    val bottom = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.WHITE)
      setPadding(dp(12), dp(12), dp(12), dp(20))
    }
    valuesText = TextView(this).apply {
      setTextColor(Color.rgb(0x16, 0x16, 0x16))
      textSize = 22f
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
      setPadding(0, 0, 0, dp(10))
      text = valuesLine(null, null, null)
    }
    bottom.addView(valuesText, LinearLayout.LayoutParams(MATCH, WRAP))

    val row1 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    undoButton = makeButton(getString(R.string.bm_undo), primary = false) { glView.queueEvent { state.undo(); trimTapDistances() } }
    resetButton = makeButton(getString(R.string.bm_reset), primary = false) { glView.queueEvent { state.reset(); tapDistances.clear() } }
    row1.addView(undoButton, LinearLayout.LayoutParams(0, dp(56), 1f).apply { rightMargin = dp(8) })
    row1.addView(resetButton, LinearLayout.LayoutParams(0, dp(56), 1f))
    bottom.addView(row1, LinearLayout.LayoutParams(MATCH, WRAP).apply { bottomMargin = dp(8) })

    val row2 = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    val cancelButton = makeButton(getString(R.string.bm_cancel), primary = false) { cancel() }
    saveButton = makeButton(getString(R.string.bm_save), primary = true) { glView.queueEvent { requestSave() } }
    row2.addView(cancelButton, LinearLayout.LayoutParams(0, dp(56), 1f).apply { rightMargin = dp(8) })
    row2.addView(saveButton, LinearLayout.LayoutParams(0, dp(56), 1f))
    bottom.addView(row2, LinearLayout.LayoutParams(MATCH, WRAP))

    root.addView(bottom, FrameLayout.LayoutParams(MATCH, WRAP, Gravity.BOTTOM))

    // Android 15+ edge-to-edge: the window draws under the status and navigation bars, so push the
    // instruction banner below the status bar and the button panel above the navigation bar.
    root.setOnApplyWindowInsetsListener { _, insets ->
      val topInset: Int
      val bottomInset: Int
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
        topInset = bars.top
        bottomInset = bars.bottom
      } else {
        @Suppress("DEPRECATION")
        topInset = insets.systemWindowInsetTop
        @Suppress("DEPRECATION")
        bottomInset = insets.systemWindowInsetBottom
      }
      bottom.setPadding(dp(12), dp(12), dp(12), dp(16) + bottomInset)
      (instructionText.layoutParams as FrameLayout.LayoutParams).topMargin = dp(16) + topInset
      instructionText.requestLayout()
      insets
    }
    setContentView(root)
    root.requestApplyInsets()
    applyButtonStates(CornerMeasureState.Phase.SCAN, 0)
  }

  private fun makeButton(label: String, primary: Boolean, onClick: () -> Unit): Button =
    Button(this).apply {
      text = label
      isAllCaps = false
      textSize = 18f
      typeface = Typeface.DEFAULT_BOLD
      stateListAnimator = null
      background = GradientDrawable().apply {
        cornerRadius = 0f // Carbon: keskin köşeler
        if (primary) setColor(Color.rgb(0x0f, 0x62, 0xfe)) else {
          setColor(Color.WHITE); setStroke(dp(2), Color.rgb(0x0f, 0x62, 0xfe))
        }
      }
      setTextColor(if (primary) Color.WHITE else Color.rgb(0x0f, 0x62, 0xfe))
      setOnClickListener { onClick() }
    }

  private fun applyButtonStates(phase: CornerMeasureState.Phase, cornerCount: Int) {
    val canUndo = cornerCount > 0
    undoButton.isEnabled = canUndo
    undoButton.alpha = if (canUndo) 1f else 0.4f
    resetButton.isEnabled = canUndo
    resetButton.alpha = if (canUndo) 1f else 0.4f
    val canSave = phase == CornerMeasureState.Phase.DONE
    saveButton.isEnabled = canSave
    saveButton.alpha = if (canSave) 1f else 0.4f
  }

  private fun fmt(m: Float?): String =
    if (m == null) "—" else String.format(TR, "%.1f", Geometry.roundCm1(m))

  private fun valuesLine(l: Float?, w: Float?, h: Float?) =
    "U ${fmt(l)}  ·  G ${fmt(w)}  ·  Y ${fmt(h)} cm"

  // ---------------------------------------------------------------- sonuç

  private fun cancel() {
    if (finished) return
    finished = true
    PendingMeasure.resolve(null)
    finish()
  }

  private fun fail(code: String, message: String) {
    if (finished) return
    finished = true
    PendingMeasure.reject(code, message)
    finish()
  }

  /** GL iş parçacığı: bir sonraki karede görüntü yakalanır ve sonuç döner. */
  private fun requestSave() {
    if (state.phase != CornerMeasureState.Phase.DONE) return
    captureRequested = true
  }

  private fun deliver(bitmap: Bitmap?, l: Float, w: Float, h: Float, confidence: Float) {
    if (finished) return
    var uri: String? = null
    if (bitmap != null) {
      try {
        // Katmanı (çizgiler, etiketler) kamera görüntüsünün üstüne çiz.
        val canvas = Canvas(bitmap)
        overlay.model = overlay.model.copy(showReticle = false)
        overlay.draw(canvas)
        val dir = File(cacheDir, "box-measure").apply { mkdirs() }
        val file = File(dir, "ar-${System.currentTimeMillis()}.jpg")
        FileOutputStream(file).use { bitmap.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        uri = Uri.fromFile(file).toString()
      } catch (e: Exception) {
        Log.w(TAG, "Görüntü kaydedilemedi", e)
      } finally {
        bitmap.recycle()
      }
    }
    val result = mutableMapOf<String, Any>(
      "lengthCm" to Geometry.roundCm1(l),
      "widthCm" to Geometry.roundCm1(w),
      "heightCm" to Geometry.roundCm1(h),
      "confidence" to (Math.round(confidence * 100) / 100.0),
    )
    if (uri != null) result["snapshotUri"] = uri
    finished = true
    PendingMeasure.resolve(result)
    finish()
  }

  // ---------------------------------------------------------------- GL

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    GLES20.glClearColor(0f, 0f, 0f, 1f)
    background.createOnGlThread()
    textureBound = false
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
    viewportW = width
    viewportH = height
    displayChanged = true
  }

  override fun onDrawFrame(gl: GL10?) {
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
    val s = session ?: return
    if (!textureBound) {
      s.setCameraTextureName(background.textureId)
      textureBound = true
    }
    if (displayChanged && viewportW > 0) {
      s.setDisplayGeometry(displayRotation(), viewportW, viewportH)
      displayChanged = false
    }
    val frame = try {
      s.update()
    } catch (e: Exception) {
      Log.w(TAG, "session.update", e)
      return
    }
    background.draw(frame)

    val camera = frame.camera
    if (camera.trackingState != TrackingState.TRACKING) {
      val msg = when (camera.trackingFailureReason) {
        TrackingFailureReason.INSUFFICIENT_LIGHT -> getString(R.string.bm_dark)
        TrackingFailureReason.EXCESSIVE_MOTION -> getString(R.string.bm_slow)
        TrackingFailureReason.INSUFFICIENT_FEATURES -> getString(R.string.bm_features)
        else -> getString(R.string.bm_scan)
      }
      publish(OverlayModel(), msg, state.phase, null)
      return
    }

    camera.getViewMatrix(viewM, 0)
    camera.getProjectionMatrix(projM, 0, 0.05f, 50f)
    Matrix.multiplyMM(vpM, 0, projM, 0, viewM, 0)
    Matrix.invertM(invVpM, 0, vpM, 0)

    if (state.phase == CornerMeasureState.Phase.SCAN) {
      val found = s.getAllTrackables(Plane::class.java).any {
        it.trackingState == TrackingState.TRACKING && it.type == Plane.Type.HORIZONTAL_UPWARD_FACING
      }
      if (found) state.onPlaneDetected()
    }

    val (rayO, rayD) = centerRay()
    val aim = computeAim(frame, rayO, rayD)
    state.updateHeightFromRay(rayO, rayD)
    pendingAim = aim
    pendingCamPos = rayO

    val model = buildModel(aim)

    if (captureRequested) {
      captureRequested = false
      val bmp = readPixels()
      val l = state.lengthM ?: 0f
      val w = state.widthM ?: 0f
      val h = state.heightM ?: 0f
      val conf = confidence()
      runOnUiThread {
        overlay.model = model
        deliver(bmp, l, w, h, conf)
      }
      return
    }
    publish(model, instructionFor(state.phase), state.phase, aim)
  }

  private var pendingAim: Vec3? = null
  private var pendingCamPos: Vec3? = null

  /** GL iş parçacığı: dokunma = nişangâhtaki noktayı ekle / yüksekliği onayla. */
  private fun onTapGl() {
    val before = state.points.size
    if (state.tap(pendingAim)) {
      val cam = pendingCamPos
      val p = pendingAim
      if (state.points.size > before && cam != null && p != null) tapDistances.add(Geometry.distance(cam, p))
    }
  }

  private fun trimTapDistances() {
    while (tapDistances.size > state.points.size) tapDistances.removeAt(tapDistances.size - 1)
  }

  /** Ekran merkezinden geçen dünya ışını (ters görünüm-izdüşüm matrisiyle). */
  private fun centerRay(): Pair<Vec3, Vec3> {
    val near = unproject(0f, 0f, -1f)
    val far = unproject(0f, 0f, 1f)
    return near to (far - near).normalized()
  }

  private fun unproject(x: Float, y: Float, z: Float): Vec3 {
    val inV = floatArrayOf(x, y, z, 1f)
    val out = FloatArray(4)
    Matrix.multiplyMV(out, 0, invVpM, 0, inV, 0)
    val w = if (abs(out[3]) < 1e-9f) 1e-9f else out[3]
    return Vec3(out[0] / w, out[1] / w, out[2] / w)
  }

  /**
   * Nişangâh noktası. İlk köşe: ARCore hitTest ile algılanan yatay düzlem.
   * Sonraki köşeler: ışının A köşesinin yüksekliğindeki sonsuz yatay düzlemle kesişimi
   * (kutunun örttüğü alanlarda da çalışır).
   */
  private fun computeAim(frame: com.google.ar.core.Frame, rayO: Vec3, rayD: Vec3): Vec3? {
    val pts = state.points
    val planeY: Float? = when {
      pts.isNotEmpty() -> pts[0].y
      else -> {
        var y: Float? = null
        if (viewportW > 0) {
          for (hit in frame.hitTest(viewportW / 2f, viewportH / 2f)) {
            val t = hit.trackable
            if (t is Plane && t.type == Plane.Type.HORIZONTAL_UPWARD_FACING &&
              t.trackingState == TrackingState.TRACKING && t.isPoseInPolygon(hit.hitPose)
            ) {
              y = hit.hitPose.ty()
              break
            }
          }
        }
        if (y != null) lastPlaneY = y
        y ?: lastPlaneY
      }
    }
    if (planeY == null || state.phase == CornerMeasureState.Phase.SCAN) return null
    if (rayD.y > -1e-3f) return null // ışın düzleme doğru inmiyor
    val t = (planeY - rayO.y) / rayD.y
    if (t <= 0f || t > 5f) return null
    return rayO + rayD * t
  }

  private fun confidence(): Float {
    // Sabit taban + uzaklık cezası: uzaktan işaretlenen köşeler daha az güvenilir.
    val avg = if (tapDistances.isEmpty()) 1f else tapDistances.average().toFloat()
    return (0.85f - 0.15f * (avg - 0.5f).coerceAtLeast(0f)).coerceIn(0.5f, 0.85f)
  }

  /** GL iş parçacığı: dünya noktalarını ekran pikseline izdüşürüp çizim modelini kurar. */
  private fun buildModel(aim: Vec3?): OverlayModel {
    val segs = ArrayList<OverlayModel.Segment>()
    val dots = ArrayList<OverlayModel.Dot>()
    val labels = ArrayList<OverlayModel.Label>()
    val pts = state.points
    val phase = state.phase

    fun seg(a: Vec3, b: Vec3, accent: Boolean, dashed: Boolean = false) {
      val s = projectSegment(a, b) ?: return
      segs.add(OverlayModel.Segment(s[0], s[1], s[2], s[3], accent, dashed))
    }

    fun label(a: Vec3, b: Vec3, prefix: String) {
      val mid = (a + b) * 0.5f
      val p = project(mid) ?: return
      labels.add(OverlayModel.Label(p[0], p[1], "$prefix ${fmt(Geometry.distance(a, b))} cm"))
    }

    val box = state.boxCorners()
    if (box != null && (phase == CornerMeasureState.Phase.HEIGHT || phase == CornerMeasureState.Phase.DONE)) {
      for ((i, j) in Geometry.BOX_EDGES) {
        val isBase = i < 4 && j < 4
        val measured = (i == 0 && j == 1) || (i == 1 && j == 2) || (i == 2 && j == 6)
        seg(box[i], box[j], accent = measured || isBase, dashed = !measured && !isBase)
      }
      label(box[0], box[1], getString(R.string.bm_len))
      label(box[1], box[2], getString(R.string.bm_wid))
      label(box[2], box[6], getString(R.string.bm_hei))
    } else {
      for (k in 0 until pts.size - 1) {
        seg(pts[k], pts[k + 1], accent = true)
        label(pts[k], pts[k + 1], if (k == 0) getString(R.string.bm_len) else getString(R.string.bm_wid))
      }
      if (aim != null && pts.isNotEmpty() && pts.size < 3) {
        seg(pts.last(), aim, accent = false, dashed = true)
        label(pts.last(), aim, if (pts.size == 1) getString(R.string.bm_len) else getString(R.string.bm_wid))
      }
    }
    val names = listOf("1", "2", "3")
    for ((k, p) in pts.withIndex()) {
      val sp = project(p) ?: continue
      dots.add(OverlayModel.Dot(sp[0], sp[1], names[k]))
    }
    val onPlane = when (phase) {
      CornerMeasureState.Phase.HEIGHT -> true
      CornerMeasureState.Phase.DONE -> false
      else -> aim != null
    }
    return OverlayModel(segs, dots, labels, reticleOnPlane = onPlane, showReticle = phase != CornerMeasureState.Phase.DONE)
  }

  /** Dünya noktası → ekran pikseli (overlay boyutunda). Kameranın arkasındaysa null. */
  private fun project(p: Vec3): FloatArray? {
    val c = clip(p)
    if (c[3] <= NEAR_W) return null
    return toScreen(c)
  }

  private fun clip(p: Vec3): FloatArray {
    val out = FloatArray(4)
    Matrix.multiplyMV(out, 0, vpM, 0, floatArrayOf(p.x, p.y, p.z, 1f), 0)
    return out
  }

  private fun toScreen(c: FloatArray): FloatArray {
    val nx = c[0] / c[3]
    val ny = c[1] / c[3]
    return floatArrayOf((nx + 1f) / 2f * viewportW, (1f - ny) / 2f * viewportH)
  }

  /** Yakın düzleme göre kırpılmış 2B doğru parçası; tamamen arkadaysa null. */
  private fun projectSegment(a: Vec3, b: Vec3): FloatArray? {
    var ca = clip(a)
    var cb = clip(b)
    val aIn = ca[3] > NEAR_W
    val bIn = cb[3] > NEAR_W
    if (!aIn && !bIn) return null
    if (!aIn || !bIn) {
      val t = (NEAR_W - ca[3]) / (cb[3] - ca[3])
      val m = FloatArray(4) { ca[it] + (cb[it] - ca[it]) * t }
      if (!aIn) ca = m else cb = m
    }
    val sa = toScreen(ca)
    val sb = toScreen(cb)
    return floatArrayOf(sa[0], sa[1], sb[0], sb[1])
  }

  /** Aşama yönergesi (cihaz diline göre, strings.xml). */
  private fun instructionFor(p: CornerMeasureState.Phase): String = getString(
    when (p) {
      CornerMeasureState.Phase.SCAN -> R.string.bm_scan
      CornerMeasureState.Phase.CORNER1 -> R.string.bm_corner1
      CornerMeasureState.Phase.CORNER2 -> R.string.bm_corner2
      CornerMeasureState.Phase.CORNER3 -> R.string.bm_corner3
      CornerMeasureState.Phase.HEIGHT -> R.string.bm_height
      CornerMeasureState.Phase.DONE -> R.string.bm_done
    },
  )

  private fun publish(model: OverlayModel, instruction: String, phase: CornerMeasureState.Phase, aim: Vec3?) {
    val pts = state.points
    val l = state.lengthM ?: if (pts.size == 1 && aim != null) Geometry.distance(pts[0], aim) else null
    val w = state.widthM ?: if (pts.size == 2 && aim != null) Geometry.distance(pts[1], aim) else null
    val h = state.heightM
    val count = pts.size
    val line = valuesLine(l, w, h)
    runOnUiThread {
      if (finished) return@runOnUiThread
      overlay.model = model
      if (instructionText.text != instruction) instructionText.text = instruction
      if (valuesText.text != line) valuesText.text = line
      applyButtonStates(phase, count)
    }
  }

  /** GL iş parçacığı: o anki çerçeve tamponunu Bitmap olarak okur. */
  private fun readPixels(): Bitmap? {
    if (viewportW <= 0 || viewportH <= 0) return null
    return try {
      val buf = ByteBuffer.allocateDirect(viewportW * viewportH * 4).order(ByteOrder.nativeOrder())
      GLES20.glReadPixels(0, 0, viewportW, viewportH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf)
      buf.rewind()
      val raw = Bitmap.createBitmap(viewportW, viewportH, Bitmap.Config.ARGB_8888)
      raw.copyPixelsFromBuffer(buf)
      // OpenGL alt-üst ters; dikey çevir.
      val m = android.graphics.Matrix().apply { preScale(1f, -1f) }
      val flipped = Bitmap.createBitmap(raw, 0, 0, viewportW, viewportH, m, false)
      raw.recycle()
      flipped.copy(Bitmap.Config.ARGB_8888, true).also { flipped.recycle() }
    } catch (e: Throwable) {
      Log.w(TAG, "glReadPixels", e)
      null
    }
  }

  @Suppress("DEPRECATION")
  private fun displayRotation(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) display?.rotation ?: Surface.ROTATION_0
    else windowManager.defaultDisplay.rotation

  /** Kısa dokunuşları algılayan basit dinleyici (sürükleme sayılmaz). */
  private class TapDetector(private val onTap: () -> Unit) : View.OnTouchListener {
    private var downX = 0f
    private var downY = 0f
    private var downT = 0L
    override fun onTouch(v: View, e: MotionEvent): Boolean {
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> { downX = e.x; downY = e.y; downT = e.eventTime }
        MotionEvent.ACTION_UP -> {
          val slop = 24f * v.resources.displayMetrics.density
          if (abs(e.x - downX) < slop && abs(e.y - downY) < slop && e.eventTime - downT < 600) {
            v.performClick()
            onTap()
          }
        }
      }
      return true
    }
  }

  private companion object {
    const val TAG = "BoxMeasure"
    const val REQ_CAMERA = 4711
    const val NEAR_W = 0.01f
    const val MATCH = ViewGroup.LayoutParams.MATCH_PARENT
    const val WRAP = ViewGroup.LayoutParams.WRAP_CONTENT
    val TR: Locale = Locale.forLanguageTag("tr-TR")
  }
}
