package expo.modules.boxmeasure

import android.content.Context
import android.content.Intent
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.util.Log
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Session
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * SPEC §6.1 — getCapabilities / measureWithLidar / measureWithAR.
 * Android'de LiDAR yok; AR ölçümü tam ekran [ArMeasureActivity] ile yapılır ve
 * sonuç [PendingMeasure] üzerinden Promise'e döner.
 */
class BoxMeasureModule : Module() {

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context yok")

  override fun definition() = ModuleDefinition {
    Name("BoxMeasure")

    AsyncFunction("getCapabilities") {
      val (ar, reason) = arAvailability(context)
      val map = mutableMapOf<String, Any>("lidar" to false, "ar" to ar)
      if (reason != null) map["arUnavailableReason"] = reason
      map
    }

    AsyncFunction("measureWithLidar") { promise: Promise ->
      promise.reject("ERR_LIDAR_UNAVAILABLE", "Bu cihazda LiDAR yok. AR ile ölçün.", null)
    }

    AsyncFunction("measureWithAR") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_NO_ACTIVITY", "Uygulama ön planda değil.", null)
        return@AsyncFunction
      }
      if (!PendingMeasure.begin(promise)) {
        promise.reject("ERR_IN_PROGRESS", "Zaten bir ölçüm açık.", null)
        return@AsyncFunction
      }
      try {
        activity.startActivity(Intent(activity, ArMeasureActivity::class.java))
      } catch (e: Exception) {
        PendingMeasure.reject("ERR_LAUNCH", "Ölçüm ekranı açılamadı: ${e.message}")
      }
    }

    OnDestroy {
      PendingMeasure.reject("ERR_DESTROYED", "Uygulama kapatıldı.")
    }
  }

  companion object {
    /** ARCore uygunluğu; geçici durumda (ağ sorgusu) en fazla ~3 sn bekler. */
    fun arAvailability(context: Context): Pair<Boolean, String?> {
      val apk = ArCoreApk.getInstance()
      var availability = apk.checkAvailability(context)
      var waited = 0
      while (availability.isTransient && waited < 3000) {
        Thread.sleep(200)
        waited += 200
        availability = apk.checkAvailability(context)
      }
      if (!hasBackCamera(context)) {
        return false to "Bu cihazda arka kamera bulunamadı."
      }
      return when (availability) {
        ArCoreApk.Availability.SUPPORTED_INSTALLED -> probeSession(context)
        ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD,
        ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED -> true to null
        ArCoreApk.Availability.UNSUPPORTED_DEVICE_NOT_CAPABLE ->
          false to "Bu cihaz ARCore (Google Play AR hizmetleri) desteklemiyor."
        ArCoreApk.Availability.UNKNOWN_TIMED_OUT,
        ArCoreApk.Availability.UNKNOWN_CHECKING ->
          false to "ARCore desteği kontrol edilemedi. İnternet bağlantısını kontrol edip tekrar deneyin."
        else -> false to "ARCore durumu belirlenemedi."
      }
    }

    private fun hasBackCamera(context: Context): Boolean = try {
      val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      cm.cameraIdList.any {
        cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
      }
    } catch (e: Exception) {
      true // belirlenemedi: ölçüm sırasında yeniden denenir
    }

    @Volatile
    private var probeResult: Pair<Boolean, String?>? = null

    /**
     * ARCore kurulu olsa bile oturum açılamayabilir (ör. ARCore'un beklediği kamera yok).
     * Deneme oturumu açıp hemen kapatır; sonuç süreç boyunca önbelleğe alınır.
     */
    private fun probeSession(context: Context): Pair<Boolean, String?> {
      probeResult?.let { return it }
      val result: Pair<Boolean, String?> = try {
        Session(context).close()
        true to null
      } catch (e: SecurityException) {
        return true to null // kamera izni henüz yok: ölçüm ekranı izni ister
      } catch (e: Throwable) {
        Log.w("BoxMeasure", "ARCore deneme oturumu açılamadı", e)
        false to "AR kamerası başlatılamadı (ARCore oturumu açılamadı). Referans kartı veya manuel ölçüm kullanın."
      }
      probeResult = result
      return result
    }
  }
}

/** Açık ölçümün Promise'i (aynı anda tek ölçüm). */
internal object PendingMeasure {
  private var promise: Promise? = null

  @Synchronized
  fun begin(p: Promise): Boolean {
    if (promise != null) return false
    promise = p
    return true
  }

  @Synchronized
  private fun take(): Promise? = promise.also { promise = null }

  fun resolve(result: Map<String, Any>?) {
    take()?.resolve(result)
  }

  fun reject(code: String, message: String) {
    take()?.reject(code, message, null)
  }
}
