import UIKit
import ARKit
import SceneKit

/// Ölçüm ekranının sonucu.
enum MeasureOutcome {
  case result([String: Any])
  case cancelled
  case failed(code: String, message: String)
}

enum MeasureStyle {
  static let blue = UIColor(red: 0x0f / 255.0, green: 0x62 / 255.0, blue: 0xfe / 255.0, alpha: 1)
  static let green = UIColor(red: 0x24 / 255.0, green: 0xa1 / 255.0, blue: 0x48 / 255.0, alpha: 1)
  static let ink = UIColor(red: 0x16 / 255.0, green: 0x16 / 255.0, blue: 0x16 / 255.0, alpha: 1)

  /// Carbon tarzı keskin köşeli, ≥ 56 pt yüksek düğme.
  static func button(_ title: String, primary: Bool) -> UIButton {
    let b = UIButton(type: .system)
    b.setTitle(title, for: .normal)
    b.titleLabel?.font = UIFont.systemFont(ofSize: 18, weight: .bold)
    b.backgroundColor = primary ? blue : .white
    b.setTitleColor(primary ? .white : blue, for: .normal)
    b.setTitleColor(primary ? UIColor.white.withAlphaComponent(0.6) : blue.withAlphaComponent(0.4), for: .disabled)
    b.layer.borderColor = blue.cgColor
    b.layer.borderWidth = primary ? 0 : 2
    b.layer.cornerRadius = 0
    b.translatesAutoresizingMaskIntoConstraints = false
    b.heightAnchor.constraint(equalToConstant: 56).isActive = true
    return b
  }

  static func setEnabled(_ b: UIButton, _ enabled: Bool) {
    b.isEnabled = enabled
    b.alpha = enabled ? 1 : 0.4
  }

  private static let formatter: NumberFormatter = {
    let f = NumberFormatter()
    f.locale = Locale(identifier: "tr_TR")
    f.numberStyle = .decimal
    f.minimumFractionDigits = 1
    f.maximumFractionDigits = 1
    return f
  }()

  /// Metre → "32,4" (cm, Türkçe biçim). nil → "—".
  static func cm(_ meters: Float?) -> String {
    guard let m = meters else { return "—" }
    return formatter.string(from: NSNumber(value: MeasureGeometry.roundCm1(m))) ?? "—"
  }

  static func valuesLine(length: Float?, width: Float?, height: Float?) -> String {
    return "U \(cm(length))  ·  G \(cm(width))  ·  Y \(cm(height)) cm"
  }

  static func resultDict(length: Float, width: Float, height: Float, confidence: Float, snapshotUri: String?) -> [String: Any] {
    var r: [String: Any] = [
      "lengthCm": MeasureGeometry.roundCm1(length),
      "widthCm": MeasureGeometry.roundCm1(width),
      "heightCm": MeasureGeometry.roundCm1(height),
      "confidence": (Double(min(max(confidence, 0), 1)) * 100).rounded() / 100,
    ]
    if let uri = snapshotUri { r["snapshotUri"] = uri }
    return r
  }

  /// Kamera görüntüsü + 2B katmanı birleştirip önbelleğe JPEG yazar; file:// URI döner.
  @MainActor
  static func saveSnapshot(sceneView: ARSCNView, overlay: UIView) -> String? {
    let base = sceneView.snapshot()
    let size = sceneView.bounds.size
    guard size.width > 0, size.height > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = min(max(sceneView.traitCollection.displayScale, 1), 2)
    let image = UIGraphicsImageRenderer(size: size, format: format).image { ctx in
      base.draw(in: CGRect(origin: .zero, size: size))
      overlay.layer.render(in: ctx.cgContext)
    }
    guard let data = image.jpegData(compressionQuality: 0.8) else { return nil }
    do {
      let caches = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      let dir = caches.appendingPathComponent("box-measure", isDirectory: true)
      try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
      let file = dir.appendingPathComponent("measure-\(Int(Date().timeIntervalSince1970 * 1000)).jpg")
      try data.write(to: file, options: .atomic)
      return file.absoluteString
    } catch {
      return nil
    }
  }
}

/// Kamera görüntüsü üstünde 2B çizim: nişangâh, köşeler, kenarlar, cm etiketleri.
final class MeasureOverlayView: UIView {
  struct Segment { var a: CGPoint; var b: CGPoint; var accent: Bool; var dashed: Bool }
  struct Dot { var p: CGPoint; var text: String }
  struct Label { var p: CGPoint; var text: String }

  var segments: [Segment] = []
  var dots: [Dot] = []
  var labels: [Label] = []
  var showReticle = true
  var reticleActive = false

  override init(frame: CGRect) {
    super.init(frame: frame)
    isOpaque = false
    backgroundColor = .clear
    isUserInteractionEnabled = false
    contentMode = .redraw
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) kullanılmaz") }

  override func draw(_ rect: CGRect) {
    for s in segments {
      let path = UIBezierPath()
      path.move(to: s.a)
      path.addLine(to: s.b)
      path.lineWidth = 3
      path.lineCapStyle = .round
      if s.dashed { path.setLineDash([10, 8], count: 2, phase: 0) }
      (s.accent ? MeasureStyle.blue : UIColor.white).setStroke()
      path.stroke()
    }
    for d in dots {
      let r: CGFloat = 8
      let circle = UIBezierPath(ovalIn: CGRect(x: d.p.x - r, y: d.p.y - r, width: 2 * r, height: 2 * r))
      MeasureStyle.blue.setFill()
      circle.fill()
      UIColor.white.setStroke()
      circle.lineWidth = 2
      circle.stroke()
      if !d.text.isEmpty { drawLabel(d.text, at: CGPoint(x: d.p.x, y: d.p.y - 22)) }
    }
    for l in labels { drawLabel(l.text, at: l.p) }

    if showReticle {
      let c = CGPoint(x: bounds.midX, y: bounds.midY)
      let r: CGFloat = 18
      let color = reticleActive ? MeasureStyle.green : UIColor.white
      color.setStroke()
      let ring = UIBezierPath(ovalIn: CGRect(x: c.x - r, y: c.y - r, width: 2 * r, height: 2 * r))
      ring.lineWidth = 3
      ring.stroke()
      let cross = UIBezierPath()
      cross.move(to: CGPoint(x: c.x - r * 1.6, y: c.y)); cross.addLine(to: CGPoint(x: c.x - r * 0.5, y: c.y))
      cross.move(to: CGPoint(x: c.x + r * 0.5, y: c.y)); cross.addLine(to: CGPoint(x: c.x + r * 1.6, y: c.y))
      cross.move(to: CGPoint(x: c.x, y: c.y - r * 1.6)); cross.addLine(to: CGPoint(x: c.x, y: c.y - r * 0.5))
      cross.move(to: CGPoint(x: c.x, y: c.y + r * 0.5)); cross.addLine(to: CGPoint(x: c.x, y: c.y + r * 1.6))
      cross.lineWidth = 3
      cross.stroke()
    }
  }

  private func drawLabel(_ text: String, at p: CGPoint) {
    let attrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: 17, weight: .bold),
      .foregroundColor: UIColor.white,
    ]
    let str = NSAttributedString(string: text, attributes: attrs)
    let size = str.size()
    let box = CGRect(x: p.x - size.width / 2 - 8, y: p.y - size.height / 2 - 5, width: size.width + 16, height: size.height + 10)
    MeasureStyle.ink.withAlphaComponent(0.86).setFill()
    UIRectFill(box)
    str.draw(at: CGPoint(x: box.minX + 8, y: box.minY + 5))
  }
}

/// İki ölçüm ekranının ortak iskeleti: ARSCNView + katman + üst talimat + alt panel.
class BaseMeasureViewController: UIViewController {
  let sceneView = ARSCNView(frame: .zero)
  let overlay = MeasureOverlayView(frame: .zero)
  let instructionLabel = UILabel()
  let valuesLabel = UILabel()
  let bottomPanel = UIStackView()

  var onFinish: ((MeasureOutcome) -> Void)?
  private var finished = false

  override var prefersStatusBarHidden: Bool { true }
  override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black

    sceneView.translatesAutoresizingMaskIntoConstraints = false
    sceneView.automaticallyUpdatesLighting = false
    sceneView.rendersCameraGrain = false
    view.addSubview(sceneView)

    overlay.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(overlay)

    instructionLabel.translatesAutoresizingMaskIntoConstraints = false
    instructionLabel.textColor = .white
    instructionLabel.font = UIFont.systemFont(ofSize: 20, weight: .bold)
    instructionLabel.numberOfLines = 0
    instructionLabel.textAlignment = .center
    instructionLabel.backgroundColor = MeasureStyle.ink.withAlphaComponent(0.8)
    view.addSubview(instructionLabel)

    let panel = UIView()
    panel.translatesAutoresizingMaskIntoConstraints = false
    panel.backgroundColor = .white
    view.addSubview(panel)

    valuesLabel.font = UIFont.monospacedDigitSystemFont(ofSize: 22, weight: .bold)
    valuesLabel.textColor = MeasureStyle.ink
    valuesLabel.textAlignment = .center
    valuesLabel.adjustsFontSizeToFitWidth = true
    valuesLabel.minimumScaleFactor = 0.6
    valuesLabel.text = MeasureStyle.valuesLine(length: nil, width: nil, height: nil)

    bottomPanel.axis = .vertical
    bottomPanel.spacing = 8
    bottomPanel.translatesAutoresizingMaskIntoConstraints = false
    bottomPanel.addArrangedSubview(valuesLabel)
    panel.addSubview(bottomPanel)

    NSLayoutConstraint.activate([
      sceneView.topAnchor.constraint(equalTo: view.topAnchor),
      sceneView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      sceneView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      sceneView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      overlay.topAnchor.constraint(equalTo: view.topAnchor),
      overlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      overlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      overlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      instructionLabel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      instructionLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
      instructionLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),
      instructionLabel.heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
      panel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      panel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      panel.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      bottomPanel.topAnchor.constraint(equalTo: panel.topAnchor, constant: 12),
      bottomPanel.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 12),
      bottomPanel.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -12),
      bottomPanel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
    ])
  }

  /// Yan yana eşit genişlikte düğme satırı ekler.
  func addButtonRow(_ buttons: [UIButton]) {
    let row = UIStackView(arrangedSubviews: buttons)
    row.axis = .horizontal
    row.spacing = 8
    row.distribution = .fillEqually
    bottomPanel.addArrangedSubview(row)
  }

  func setInstruction(_ text: String) {
    let padded = "  \(text)  "
    if instructionLabel.text != padded { instructionLabel.text = padded }
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    sceneView.session.pause()
  }

  /// Tek sefer: ekranı kapatır ve sonucu bildirir.
  func finish(_ outcome: MeasureOutcome) {
    guard !finished else { return }
    finished = true
    sceneView.session.pause()
    let callback = onFinish
    onFinish = nil
    dismiss(animated: true) {
      callback?(outcome)
    }
  }

  @objc func cancelTapped() {
    finish(.cancelled)
  }

  /// Dünya noktası → görünüm koordinatı; kameranın arkasındaysa nil.
  func project(_ p: SIMD3<Float>) -> CGPoint? {
    let v = sceneView.projectPoint(SCNVector3(p.x, p.y, p.z))
    if v.z < 0 || v.z > 1 { return nil }
    return CGPoint(x: CGFloat(v.x), y: CGFloat(v.y))
  }

  /// Ekran merkezinden geçen dünya ışını.
  func centerRay() -> (origin: SIMD3<Float>, dir: SIMD3<Float>) {
    let c = CGPoint(x: sceneView.bounds.midX, y: sceneView.bounds.midY)
    let near = sceneView.unprojectPoint(SCNVector3(Float(c.x), Float(c.y), 0))
    let far = sceneView.unprojectPoint(SCNVector3(Float(c.x), Float(c.y), 1))
    let o = SIMD3<Float>(near.x, near.y, near.z)
    let f = SIMD3<Float>(far.x, far.y, far.z)
    return (o, simd_normalize(f - o))
  }

  func trackingMessage(_ camera: ARCamera) -> String? {
    switch camera.trackingState {
    case .normal:
      return nil
    case .notAvailable:
      return "Konum takibi kullanılamıyor"
    case .limited(let reason):
      switch reason {
      case .excessiveMotion: return "Telefonu daha yavaş hareket ettirin"
      case .insufficientFeatures: return "Desenli bir yüzeye doğrultun, yavaşça gezdirin"
      case .initializing, .relocalizing: return "Masayı tarayın: telefonu yavaşça gezdirin"
      @unknown default: return "Masayı tarayın: telefonu yavaşça gezdirin"
      }
    }
  }
}
