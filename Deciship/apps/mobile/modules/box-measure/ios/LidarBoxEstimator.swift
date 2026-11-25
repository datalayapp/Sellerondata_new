import Foundation
import ARKit
import simd

/// Bir karenin derinlik verisinin kopyası (ARFrame tutulmaz; arka plan kuyruğunda işlenir).
struct DepthSample {
  var depth: [Float]
  /// ARConfidenceLevel ham değerleri (0 düşük, 1 orta, 2 yüksek); yoksa boş.
  var confidence: [UInt8]
  var width: Int
  var height: Int
  /// Yakalanan görüntünün iç parametreleri (görüntü pikseli cinsinden).
  var intrinsics: simd_float3x3
  var imageWidth: Float
  var imageHeight: Float
  var cameraTransform: simd_float4x4
  /// Yatay ARPlaneAnchor'ların dünya Y yükseklikleri.
  var planeHeights: [Float]

  /// ARFrame'den derinlik + güven haritasını kopyalar (ana iş parçacığında, ucuz memcpy).
  static func from(frame: ARFrame) -> DepthSample? {
    guard let data = frame.smoothedSceneDepth ?? frame.sceneDepth else { return nil }
    let dm = data.depthMap
    guard CVPixelBufferGetPixelFormatType(dm) == kCVPixelFormatType_DepthFloat32 else { return nil }
    CVPixelBufferLockBaseAddress(dm, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(dm, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(dm) else { return nil }
    let w = CVPixelBufferGetWidth(dm)
    let h = CVPixelBufferGetHeight(dm)
    let bpr = CVPixelBufferGetBytesPerRow(dm)
    var depth = [Float](repeating: 0, count: w * h)
    for y in 0..<h {
      let row = base.advanced(by: y * bpr).assumingMemoryBound(to: Float32.self)
      for x in 0..<w { depth[y * w + x] = row[x] }
    }

    var conf: [UInt8] = []
    if let cm = data.confidenceMap,
       CVPixelBufferGetWidth(cm) == w, CVPixelBufferGetHeight(cm) == h,
       CVPixelBufferGetPixelFormatType(cm) == kCVPixelFormatType_OneComponent8 {
      CVPixelBufferLockBaseAddress(cm, .readOnly)
      if let cbase = CVPixelBufferGetBaseAddress(cm) {
        let cbpr = CVPixelBufferGetBytesPerRow(cm)
        conf = [UInt8](repeating: 0, count: w * h)
        for y in 0..<h {
          let row = cbase.advanced(by: y * cbpr).assumingMemoryBound(to: UInt8.self)
          for x in 0..<w { conf[y * w + x] = row[x] }
        }
      }
      CVPixelBufferUnlockBaseAddress(cm, .readOnly)
    }

    let planes: [Float] = frame.anchors.compactMap { anchor in
      guard let p = anchor as? ARPlaneAnchor, p.alignment == .horizontal else { return nil }
      return p.transform.columns.3.y
    }

    return DepthSample(
      depth: depth, confidence: conf, width: w, height: h,
      intrinsics: frame.camera.intrinsics,
      imageWidth: Float(frame.camera.imageResolution.width),
      imageHeight: Float(frame.camera.imageResolution.height),
      cameraTransform: frame.camera.transform,
      planeHeights: planes
    )
  }
}

/// Tek karelik kutu tahmini.
struct BoxEstimate {
  var rect: RotatedRect   // XZ düzleminde taban (length ≥ width)
  var planeY: Float
  var height: Float
  var pointCount: Int
}

/// LiDAR derinliğinden kutu ölçümü:
/// 1) derinlik piksellerini dünya noktalarına çevir (güven ≥ orta),
/// 2) destek (masa) düzlemini bul (Y histogramı + ARPlaneAnchor),
/// 3) düzlemin > 1 cm üstündeki, ekran merkezine en yakın bağlı kümeyi seç,
/// 4) XZ izdüşümünde en küçük alanlı dikdörtgen → U/G; Y = yükseklik farklarının %98'i.
enum LidarBoxEstimator {
  static let gridStride = 2
  static let minDepth: Float = 0.15
  static let maxDepth: Float = 2.5
  static let minClusterPoints = 120

  static func estimate(_ s: DepthSample) -> BoxEstimate? {
    let gw = s.width / gridStride
    let gh = s.height / gridStride
    guard gw > 4, gh > 4 else { return nil }
    let n = gw * gh

    let fx = s.intrinsics.columns.0.x
    let fy = s.intrinsics.columns.1.y
    let cx = s.intrinsics.columns.2.x
    let cy = s.intrinsics.columns.2.y
    let sx = s.imageWidth / Float(s.width)
    let sy = s.imageHeight / Float(s.height)
    guard fx > 0, fy > 0 else { return nil }

    // 1) Izgara üzerinde dünya noktaları.
    var world = [SIMD3<Float>](repeating: .zero, count: n)
    var valid = [Bool](repeating: false, count: n)
    var depthAt = [Float](repeating: 0, count: n)
    var allY: [Float] = []
    allY.reserveCapacity(n)
    let hasConf = s.confidence.count == s.depth.count
    for gy in 0..<gh {
      for gx in 0..<gw {
        let u = gx * gridStride
        let v = gy * gridStride
        let idx = v * s.width + u
        let d = s.depth[idx]
        if !(d >= minDepth && d <= maxDepth) { continue }
        if hasConf && s.confidence[idx] < 1 { continue } // ARConfidenceLevel.medium
        let px = (Float(u) + 0.5) * sx
        let py = (Float(v) + 0.5) * sy
        // Kamera uzayı: x sağ, y yukarı, kamera -z'ye bakar.
        let local = SIMD4<Float>((px - cx) * d / fx, -(py - cy) * d / fy, -d, 1)
        let w = s.cameraTransform * local
        let g = gy * gw + gx
        world[g] = SIMD3<Float>(w.x, w.y, w.z)
        valid[g] = true
        depthAt[g] = d
        allY.append(w.y)
      }
    }
    if allY.count < 300 { return nil }

    // 2) Kutu üstü tahmini: merkezdeki küçük pencerenin %90 yüksekliği.
    var centerY: [Float] = []
    let cx0 = gw * 2 / 5, cx1 = gw * 3 / 5, cy0 = gh * 2 / 5, cy1 = gh * 3 / 5
    for gy in cy0..<cy1 { for gx in cx0..<cx1 where valid[gy * gw + gx] { centerY.append(world[gy * gw + gx].y) } }
    if centerY.count < 10 { return nil }
    let topEstimate = MeasureGeometry.percentile(centerY, 0.9)

    var candidates: [Float] = s.planeHeights.filter { $0 < topEstimate - 0.02 }
    if let h = MeasureGeometry.estimateSupportPlaneHeight(allY, topEstimate: topEstimate) {
      candidates.append(h)
    }
    guard let planeY = candidates.max() else { return nil }

    // 3) Düzlem üstü maske + merkeze en yakın bağlı küme (ızgarada 4-komşuluk, derinlik sürekliliği).
    var mask = [Bool](repeating: false, count: n)
    for i in 0..<n where valid[i] {
      let dy = world[i].y - planeY
      mask[i] = dy > 0.01 && dy < 1.5
    }
    let mx = gw / 2, my = gh / 2
    var seed = -1
    var bestD = Int.max
    let searchR = min(gw, gh) / 4
    for gy in max(0, my - searchR)..<min(gh, my + searchR) {
      for gx in max(0, mx - searchR)..<min(gw, mx + searchR) where mask[gy * gw + gx] {
        let dd = (gx - mx) * (gx - mx) + (gy - my) * (gy - my)
        if dd < bestD { bestD = dd; seed = gy * gw + gx }
      }
    }
    if seed < 0 { return nil }

    var visited = [Bool](repeating: false, count: n)
    var queue = [seed]
    visited[seed] = true
    var head = 0
    var cluster: [Int] = []
    while head < queue.count {
      let i = queue[head]; head += 1
      cluster.append(i)
      let x = i % gw, y = i / gw
      let di = depthAt[i]
      let maxJump = 0.03 + 0.02 * di
      for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
        if nx < 0 || ny < 0 || nx >= gw || ny >= gh { continue }
        let j = ny * gw + nx
        if visited[j] || !mask[j] { continue }
        if abs(depthAt[j] - di) > maxJump { continue }
        visited[j] = true
        queue.append(j)
      }
    }
    if cluster.count < minClusterPoints { return nil }

    // 4) Taban dikdörtgeni + yükseklik.
    let pts2 = cluster.map { SIMD2<Float>(world[$0].x, world[$0].z) }
    guard let raw = MeasureGeometry.minAreaRect(pts2) else { return nil }
    let rect = MeasureGeometry.trimmedRect(pts2, rect: raw, trim: 0.01)
    let heights = cluster.map { world[$0].y - planeY }
    let height = MeasureGeometry.percentile(heights, 0.98)
    if rect.length < 0.02 || rect.width < 0.01 || rect.length > 2.0 || height < 0.01 { return nil }
    return BoxEstimate(rect: rect, planeY: planeY, height: height, pointCount: cluster.count)
  }
}
