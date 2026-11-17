import UIKit
import ARKit
import SceneKit

/// AR köşe işaretleme (LiDAR gerekmez): yatay düzlem → 3 taban köşesi → yükseklik.
final class ARCornerMeasureViewController: BaseMeasureViewController, ARSessionDelegate {

  private var state = CornerMeasureState()
  private var aim: SIMD3<Float>?
  private var lastPlaneY: Float?
  private var tapDistances: [Float] = []

  private let undoButton = MeasureStyle.button("Geri al", primary: false)
  private let resetButton = MeasureStyle.button("Baştan başla", primary: false)
  private let cancelButton = MeasureStyle.button("Vazgeç", primary: false)
  private let saveButton = MeasureStyle.button("Kaydet", primary: true)

  override func viewDidLoad() {
    super.viewDidLoad()
    addButtonRow([undoButton, resetButton])
    addButtonRow([cancelButton, saveButton])
    undoButton.addTarget(self, action: #selector(undoTapped), for: .touchUpInside)
    resetButton.addTarget(self, action: #selector(resetTapped), for: .touchUpInside)
    cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    saveButton.addTarget(self, action: #selector(saveTapped), for: .touchUpInside)

    let tap = UITapGestureRecognizer(target: self, action: #selector(screenTapped))
    sceneView.addGestureRecognizer(tap)
    sceneView.session.delegate = self
    setInstruction(state.instruction)
    refreshButtons()
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    let config = ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal]
    config.worldAlignment = .gravity
    sceneView.session.run(config, options: [.resetTracking, .removeExistingAnchors])
  }

  // MARK: ARSessionDelegate (ana kuyrukta çağrılır: delegateQueue = nil)

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
      aim = nil
      overlay.segments = []; overlay.labels = []; overlay.dots = []
      overlay.reticleActive = false
      overlay.setNeedsDisplay()
      return
    }
    if state.phase == .scan {
      let found = frame.anchors.contains { ($0 as? ARPlaneAnchor)?.alignment == .horizontal }
      if found { state.onPlaneDetected() }
    }
    let ray = centerRay()
    aim = computeAim(rayOrigin: ray.origin, rayDir: ray.dir)
    state.updateHeight(rayOrigin: ray.origin, rayDir: ray.dir)
    redraw()
  }

  /// İlk köşe: algılanan yatay düzleme raycast. Sonrakiler: ışının A yüksekliğindeki sonsuz düzlemle kesişimi.
  private func computeAim(rayOrigin: SIMD3<Float>, rayDir: SIMD3<Float>) -> SIMD3<Float>? {
    if state.phase == .scan { return nil }
    var planeY: Float?
    if let first = state.points.first {
      planeY = first.y
    } else {
      let center = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
      if let query = sceneView.raycastQuery(from: center, allowing: .existingPlaneGeometry, alignment: .horizontal),
         let hit = sceneView.session.raycast(query).first {
        let y = hit.worldTransform.columns.3.y
        lastPlaneY = y
        planeY = y
      } else {
        planeY = lastPlaneY
      }
    }
    guard let py = planeY, rayDir.y < -1e-3 else { return nil }
    let t = (py - rayOrigin.y) / rayDir.y
    if t <= 0 || t > 5 { return nil }
    return rayOrigin + rayDir * t
  }

  private func redraw() {
    var segs: [MeasureOverlayView.Segment] = []
    var labels: [MeasureOverlayView.Label] = []
    var dots: [MeasureOverlayView.Dot] = []
    let pts = state.points
    let phase = state.phase

    func seg(_ a: SIMD3<Float>, _ b: SIMD3<Float>, accent: Bool, dashed: Bool = false) {
      guard let pa = project(a), let pb = project(b) else { return }
      segs.append(.init(a: pa, b: pb, accent: accent, dashed: dashed))
    }
    func label(_ a: SIMD3<Float>, _ b: SIMD3<Float>, _ prefix: String) {
      guard let p = project((a + b) * 0.5) else { return }
      labels.append(.init(p: p, text: "\(prefix) \(MeasureStyle.cm(simd_distance(a, b))) cm"))
    }

    if let box = state.boxCorners(), phase == .height || phase == .done {
      for (i, j) in MeasureGeometry.boxEdges {
        let isBase = i < 4 && j < 4
        let measured = (i == 0 && j == 1) || (i == 1 && j == 2) || (i == 2 && j == 6)
        seg(box[i], box[j], accent: measured || isBase, dashed: !measured && !isBase)
      }
      label(box[0], box[1], "U")
      label(box[1], box[2], "G")
      label(box[2], box[6], "Y")
    } else {
      if pts.count >= 2 {
        for k in 0..<(pts.count - 1) {
          seg(pts[k], pts[k + 1], accent: true)
          label(pts[k], pts[k + 1], k == 0 ? "U" : "G")
        }
      }
      if let a = aim, let last = pts.last, pts.count < 3 {
        seg(last, a, accent: false, dashed: true)
        label(last, a, pts.count == 1 ? "U" : "G")
      }
    }
    for (k, p) in pts.enumerated() {
      if let sp = project(p) { dots.append(.init(p: sp, text: "\(k + 1)")) }
    }

    overlay.segments = segs
    overlay.labels = labels
    overlay.dots = dots
    overlay.showReticle = phase != .done
    overlay.reticleActive = phase == .height || aim != nil
    overlay.setNeedsDisplay()

    setInstruction(state.instruction)
    var l = state.length
    var w = state.width
    if pts.count == 1, let a = aim { l = simd_distance(pts[0], a) }
    if pts.count == 2, let a = aim { w = simd_distance(pts[1], a) }
    valuesLabel.text = MeasureStyle.valuesLine(length: l, width: w, height: state.height)
    refreshButtons()
  }

  private func refreshButtons() {
    let hasPoints = !state.points.isEmpty
    MeasureStyle.setEnabled(undoButton, hasPoints)
    MeasureStyle.setEnabled(resetButton, hasPoints)
    MeasureStyle.setEnabled(saveButton, state.phase == .done)
  }

  // MARK: Eylemler

  @objc private func screenTapped() {
    let before = state.points.count
    if state.tap(aim: aim) {
      if state.points.count > before, let p = state.points.last, let cam = sceneView.session.currentFrame?.camera {
        let c = cam.transform.columns.3
        tapDistances.append(simd_distance(SIMD3<Float>(c.x, c.y, c.z), p))
      }
      UIImpactFeedbackGenerator(style: .medium).impactOccurred()
    }
    redraw()
  }

  @objc private func undoTapped() {
    state.undo()
    while tapDistances.count > state.points.count { tapDistances.removeLast() }
    redraw()
  }

  @objc private func resetTapped() {
    state.reset()
    tapDistances.removeAll()
    redraw()
  }

  @objc private func saveTapped() {
    guard state.phase == .done, let l = state.length, let w = state.width, let h = state.height else { return }
    overlay.showReticle = false
    overlay.setNeedsDisplay()
    overlay.layer.displayIfNeeded()
    let uri = MeasureStyle.saveSnapshot(sceneView: sceneView, overlay: overlay)
    let avg = tapDistances.isEmpty ? 1 : tapDistances.reduce(0, +) / Float(tapDistances.count)
    let confidence = min(max(0.85 - 0.15 * max(avg - 0.5, 0), 0.5), 0.85)
    finish(.result(MeasureStyle.resultDict(length: l, width: w, height: h, confidence: confidence, snapshotUri: uri)))
  }
}
