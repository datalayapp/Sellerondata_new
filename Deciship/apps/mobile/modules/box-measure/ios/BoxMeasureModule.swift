import ExpoModulesCore
import ARKit
import AVFoundation
import UIKit

/// SPEC §6.1 — getCapabilities / measureWithLidar / measureWithAR.
public class BoxMeasureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BoxMeasure")

    AsyncFunction("getCapabilities") { () -> [String: Any] in
      let ar = ARWorldTrackingConfiguration.isSupported
      let lidar = ar && ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth)
      var result: [String: Any] = ["lidar": lidar, "ar": ar]
      if !ar {
        result["arUnavailableReason"] = "Bu cihaz ARKit desteklemiyor."
      }
      return result
    }

    AsyncFunction("measureWithLidar") { (promise: Promise) in
      guard ARWorldTrackingConfiguration.isSupported,
            ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) else {
        promise.reject("ERR_LIDAR_UNAVAILABLE", "Bu cihazda LiDAR yok. AR ile ölçün.")
        return
      }
      MainActor.assumeIsolated {
        self.present(LidarMeasureViewController(), promise: promise)
      }
    }.runOnQueue(.main)

    AsyncFunction("measureWithAR") { (promise: Promise) in
      guard ARWorldTrackingConfiguration.isSupported else {
        promise.reject("ERR_AR_UNAVAILABLE", "Bu cihaz ARKit desteklemiyor.")
        return
      }
      MainActor.assumeIsolated {
        self.present(ARCornerMeasureViewController(), promise: promise)
      }
    }.runOnQueue(.main)
  }

  /// Ana iş parçacığında: kamera iznini kontrol eder, ekranı tam ekran açar, sonucu Promise'e bağlar.
  @MainActor
  private func present(_ controller: BaseMeasureViewController, promise: Promise) {
    withCameraPermission { granted in
      guard granted else {
        promise.reject("ERR_CAMERA_PERMISSION", "Kamera izni verilmedi. Ayarlar > DeciShip > Kamera iznini açın.")
        return
      }
      guard let presenter = self.appContext?.utilities?.currentViewController() else {
        promise.reject("ERR_NO_VIEW_CONTROLLER", "Ölçüm ekranı açılamadı.")
        return
      }
      controller.modalPresentationStyle = .fullScreen
      controller.onFinish = { outcome in
        switch outcome {
        case .result(let dict):
          promise.resolve(dict as Any?)
        case .cancelled:
          promise.resolve(nil as Any?)
        case .failed(let code, let message):
          promise.reject(code, message)
        }
      }
      presenter.present(controller, animated: true)
    }
  }

  /// Sonuç her zaman ana iş parçacığında döner.
  @MainActor
  private func withCameraPermission(_ completion: @escaping (Bool) -> Void) {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized:
      completion(true)
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .video) { granted in
        DispatchQueue.main.async { completion(granted) }
      }
    default:
      completion(false)
    }
  }
}
