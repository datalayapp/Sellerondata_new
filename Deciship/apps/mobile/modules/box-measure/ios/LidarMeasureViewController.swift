import UIKit
import ARKit
import SceneKit

/// iPhone Pro LiDAR otomatik ölçüm: kutuyu nişangâha alın, değerler kararlı olunca Kaydet.
final class LidarMeasureViewController: BaseMeasureViewController, ARSessionDelegate {

  private struct Sample { var length: Float; var width: Float; var height: Float; var points: Int }

  private static let historySize = 15
  private static let stableWindow = 8
  private static let stableStd: Float = 0.004   // 4 mm
  private static let jumpReset: Float = 0.05    // 5 cm: başka kutuya geçildi

  private let workQueue = DispatchQueue(label: "deciship.boxmeasure.lidar", qos: .userInitiated)
  private var processing = false
  private var lastProcessed: TimeInterval = 0
  private var history: [Sample] = []
  private var latest: BoxEstimate?
  private var missCount = 0

  private let stabilityLabel = UILabel()
  private let cancelButton = MeasureStyle.button("Vazgeç", primary: false)
  private let saveButton = MeasureStyle.button("Kaydet", primary: true)

  override func viewDidLoad() {
    super.viewDidLoad()
    stabilityLabel.font = UIFont.systemFont(ofSize: 16, weight: .semibold)
    stabilityLabel.textAlignment = .center
    stabilityLabel.textColor = MeasureStyle.ink
    stabilityLabel.text = "Kararlılık: —"
    bottomPanel.addArrangedSubview(stabilityLabel)
    addButtonRow([cancelButton, saveButton])
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    saveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)
    MeasureStyle.setEnabled(saveButton, false)
    sceneView.session.delegate = self
    setInstruction("Kolinin tamamı ve altındaki masa görünecek şekilde telefonu tutun")
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let config = ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal]
    config.worldAlignment = .gravity
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.sceneDepth) {
      config.frameSemantics.insert(.sceneDepth)
    }
    if ARWorldTrackingConfiguration.supportsFrameSemantics(.smoothedSceneDepth) {
      config.frameSemantics.insert(.smoothedSceneDepth)
    }
    sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
  }

  // MARK: ARSessionDelegate (ana kuyruk)

  nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
    MainActor.assumeIsolated {
      self.process(frame: frame)
    }
  }

  nonisolated func session(_ session: ARSession, didFailWithError error: Error) {
    let message = error.localizedDescription
    MainActor.assumeIsolated {
      self.finish(.failed(code: "ERR_AR_SESSION", message: "AR oturumu hata verdi: \(message)"))
    }
  }

  private func process(frame: ARFrame) {
    if let msg = trackingMessage(frame.camera) {
      setInstruction(msg)
      redrawWireframe()
      return
    }
    redrawWireframe()
    // ~15 Hz; önceki kare hâlâ işleniyorsa atla.
    guard !processing, frame.timestamp - lastProcessed >= 0.066 else { return }
    guard let sample = DepthSample.from(frame: frame) else { return }
    processing = true
    lastProcessed = frame.timestamp
    workQueue.async {
      let estimate = LidarBoxEstimator.estimate(sample)
      DispatchQueue.main.async { [weak self] in
        MainActor.assumeIsolated {
          guard let self = self else { return }
          self.processing = false
          self.handle(estimate)
        }
      }
    }
  }

  private func handle(_ estimate: BoxEstimate?) {
    guard let e = estimate else {
      missCount += 1
      if missCount > 10 {
        history.removeAll()
        latest = nil
        setInstruction("Kutu bulunamadı: artı işaretini koliye doğrultun, masa da görünsün")
      }
      refreshUi()
      return
    }
    missCount = 0
    let s = Sample(length: e.rect.length, width: e.rect.width, height: e.height, points: e.pointCount)
    if let m = medians(), abs(m.length - s.length) > Self.jumpReset || abs(m.width - s.width) > Self.jumpReset
        || abs(m.height - s.height) > Self.jumpReset {
      history.removeAll()
    }
    history.append(s)
    if history.count > Self.historySize { history.removeFirst(history.count - Self.historySize) }
    latest = e
    refreshUi()
  }

  private func medians() -> (length: Float, width: Float, height: Float)? {
    if history.isEmpty { return nil }
    return (
      MeasureGeometry.median(history.map { $0.length }),
      MeasureGeometry.median(history.map { $0.width }),
      MeasureGeometry.median(history.map { $0.height })
    )
  }

  /// Son penceredeki en büyük standart sapma (m); pencere dolmadıysa nil.
  private func windowStd() -> Float? {
    guard history.count >= Self.stableWindow else { return nil }
    let w = Array(history.suffix(Self.stableWindow))
    return max(
      MeasureGeometry.stdDev(w.map { $0.length }),
      MeasureGeometry.stdDev(w.map { $0.width }),
      MeasureGeometry.stdDev(w.map { $0.height })
    )
  }

  private var isStable: Bool {
    guard let s = windowStd() else { return false }
    return s <= Self.stableStd
  }

  /// Güven = %70 kare tutarlılığı + %30 nokta yoğunluğu.
  private func confidence() -> Float {
    let std = windowStd() ?? MeasureGeometry.stdDev(history.map { $0.length })
    let consistency = min(max(1 - std / 0.01, 0), 1)
    let avgPoints = history.isEmpty ? 0 : Float(history.map { $0.points }.reduce(0, +)) / Float(history.count)
    let density = min(max(avgPoints / 2000, 0), 1)
    return 0.7 * consistency + 0.3 * density
  }

  private func refreshUi() {
    let m = medians()
    valuesLabel.text = MeasureStyle.valuesLine(length: m?.length, width: m?.width, height: m?.height)
    let stable = isStable
    MeasureStyle.setEnabled(saveButton, stable)
    if m == nil {
      stabilityLabel.text = "Kararlılık: —"
      stabilityLabel.textColor = MeasureStyle.ink
    } else if stable {
      stabilityLabel.text = "● Kararlı — güven %\(Int((confidence() * 100).rounded()))"
      stabilityLabel.textColor = MeasureStyle.green
      setInstruction("Ölçüm kararlı. Kaydet'e basın")
    } else {
      let progress = min(history.count, Self.stableWindow)
      stabilityLabel.text = "○ Sabit tutun… (\(progress)/\(Self.stableWindow))"
      stabilityLabel.textColor = MeasureStyle.blue
      setInstruction("Telefonu sabit tutun")
    }
    redrawWireframe()
  }

  /// Son tahminin konum/yönü + medyan ölçülerle tel kafes ve etiketler.
  private func redrawWireframe() {
    guard let e = latest, let m = medians() else {
      overlay.segments = []; overlay.labels = []; overlay.dots = []
      overlay.reticleActive = false
      overlay.setNeedsDisplay()
      return
    }
    let rect = RotatedRect(center: e.rect.center, axis: e.rect.axis, length: m.length, width: m.width)
    let box = MeasureGeometry.boxCorners(rect: rect, planeY: e.planeY, height: m.height)
    let stable = isStable
    var segs: [MeasureOverlayView.Segment] = []
    for (i, j) in MeasureGeometry.boxEdges {
      guard let a = project(box[i]), let b = project(box[j]) else { continue }
      segs.append(.init(a: a, b: b, accent: stable, dashed: false))
    }
    var labels: [MeasureOverlayView.Label] = []
    func label(_ i: Int, _ j: Int, _ prefix: String, _ value: Float) {
      guard let p = project((box[i] + box[j]) * 0.5) else { return }
      labels.append(.init(p: p, text: "\(prefix) \(MeasureStyle.cm(value)) cm"))
    }
    label(0, 1, "U", m.length)
    label(1, 2, "G", m.width)
    label(1, 5, "Y", m.height)
    overlay.segments = segs
    overlay.labels = labels
    overlay.dots = []
    overlay.reticleActive = true
    overlay.setNeedsDisplay()
  }

  @objc private func saveTapped() {
    guard isStable, let m = medians() else { return }
    overlay.showReticle = false
    overlay.setNeedsDisplay()
    overlay.layer.displayIfNeeded()
    let uri = MeasureStyle.saveSnapshot(sceneView: sceneView, overlay: overlay)
    finish(.result(MeasureStyle.resultDict(
      length: m.length, width: m.width, height: m.height, confidence: confidence(), snapshotUri: uri)))
  }
}
