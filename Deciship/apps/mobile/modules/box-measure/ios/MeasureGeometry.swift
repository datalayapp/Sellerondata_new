import Foundation
import simd

/// Saf geometri (ARKit/UIKit'ten bağımsız). Android'deki Geometry.kt ile birebir aynı algoritmalar;
/// birim testler Kotlin tarafında (android/src/test) çalışır.
/// Birimler: metre, dünya Y ekseni yukarı (ARKit yerçekimi hizalı).

struct RotatedRect {
  var center: SIMD2<Float>
  /// Uzun kenar yönünde birim vektör.
  var axis: SIMD2<Float>
  var length: Float
  var width: Float

  var area: Float { length * width }

  /// Köşeler (saat yönünün tersine).
  func corners() -> [SIMD2<Float>] {
    let n = SIMD2<Float>(-axis.y, axis.x)
    let hl = length / 2
    let hw = width / 2
    return [
      center - axis * hl - n * hw,
      center + axis * hl - n * hw,
      center + axis * hl + n * hw,
      center - axis * hl + n * hw,
    ]
  }
}

enum MeasureGeometry {

  /// Metreden santimetreye, 0,1 cm'ye yuvarlanmış.
  static func roundCm1(_ meters: Float) -> Double {
    return (Double(meters) * 1000.0).rounded() / 10.0
  }

  /// Dikey doğru (base + t·up) üzerinde ışına (origin + s·dir) en yakın noktanın t değeri.
  /// Işın doğruya paralelse nil; en yakın nokta ışının arkasındaysa kamera konumunun izdüşümü.
  static func closestHeightOnVerticalLine(
    base: SIMD3<Float>, up: SIMD3<Float>, rayOrigin: SIMD3<Float>, rayDir: SIMD3<Float>
  ) -> Float? {
    let u = simd_normalize(up)
    let d = simd_normalize(rayDir)
    let w0 = base - rayOrigin
    let b = simd_dot(u, d)
    let denom = 1 - b * b
    if denom < 1e-6 { return nil }
    let dd = simd_dot(u, w0)
    let e = simd_dot(d, w0)
    var t = (b * e - dd) / denom
    let s = (e - b * dd) / denom
    if s < 0 { t = -dd }
    return t
  }

  /// Andrew monotone chain dışbükey zarf (saat yönünün tersine).
  static func convexHull(_ points: [SIMD2<Float>]) -> [SIMD2<Float>] {
    if points.count < 3 { return points }
    let sorted = points.sorted { $0.x != $1.x ? $0.x < $1.x : $0.y < $1.y }
    func cross(_ o: SIMD2<Float>, _ a: SIMD2<Float>, _ b: SIMD2<Float>) -> Float {
      return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
    }
    var lower: [SIMD2<Float>] = []
    for p in sorted {
      while lower.count >= 2 && cross(lower[lower.count - 2], lower[lower.count - 1], p) <= 0 {
        lower.removeLast()
      }
      lower.append(p)
    }
    var upper: [SIMD2<Float>] = []
    for p in sorted.reversed() {
      while upper.count >= 2 && cross(upper[upper.count - 2], upper[upper.count - 1], p) <= 0 {
        upper.removeLast()
      }
      upper.append(p)
    }
    lower.removeLast()
    upper.removeLast()
    return lower + upper
  }

  /// En küçük alanlı döndürülmüş dikdörtgen (dönen kumpas: bir kenar zarf kenarıyla çakışır).
  static func minAreaRect(_ points: [SIMD2<Float>]) -> RotatedRect? {
    let hull = convexHull(points)
    if hull.isEmpty { return nil }
    if hull.count == 1 { return RotatedRect(center: hull[0], axis: SIMD2<Float>(1, 0), length: 0, width: 0) }
    var best: RotatedRect?
    for i in 0..<hull.count {
      let e = hull[(i + 1) % hull.count] - hull[i]
      let len = simd_length(e)
      if len < 1e-9 { continue }
      let u = e / len
      var minU = Float.greatestFiniteMagnitude, maxU = -Float.greatestFiniteMagnitude
      var minV = Float.greatestFiniteMagnitude, maxV = -Float.greatestFiniteMagnitude
      for q in hull {
        let pu = q.x * u.x + q.y * u.y
        let pv = -q.x * u.y + q.y * u.x
        minU = min(minU, pu); maxU = max(maxU, pu)
        minV = min(minV, pv); maxV = max(maxV, pv)
      }
      let du = maxU - minU
      let dv = maxV - minV
      if best == nil || du * dv < best!.area - 1e-12 {
        let cu = (minU + maxU) / 2
        let cv = (minV + maxV) / 2
        let center = SIMD2<Float>(cu * u.x - cv * u.y, cu * u.y + cv * u.x)
        best = du >= dv
          ? RotatedRect(center: center, axis: u, length: du, width: dv)
          : RotatedRect(center: center, axis: SIMD2<Float>(-u.y, u.x), length: dv, width: du)
      }
    }
    return best
  }

  /// Yönü koruyarak kenarları yüzdelikle yeniden hesaplar (uç noktalar dikdörtgeni şişirmesin).
  static func trimmedRect(_ points: [SIMD2<Float>], rect: RotatedRect, trim: Float = 0.01) -> RotatedRect {
    if points.count < 10 { return rect }
    let u = rect.axis
    var us = points.map { $0.x * u.x + $0.y * u.y }
    var vs = points.map { -$0.x * u.y + $0.y * u.x }
    us.sort(); vs.sort()
    let lo = percentileSorted(us, trim), hi = percentileSorted(us, 1 - trim)
    let loV = percentileSorted(vs, trim), hiV = percentileSorted(vs, 1 - trim)
    let cu = (lo + hi) / 2, cv = (loV + hiV) / 2
    let center = SIMD2<Float>(cu * u.x - cv * u.y, cu * u.y + cv * u.x)
    let du = hi - lo, dv = hiV - loV
    return du >= dv
      ? RotatedRect(center: center, axis: u, length: du, width: dv)
      : RotatedRect(center: center, axis: SIMD2<Float>(-u.y, u.x), length: dv, width: du)
  }

  static func percentileSorted(_ sorted: [Float], _ q: Float) -> Float {
    if sorted.isEmpty { return 0 }
    let pos = min(max(q, 0), 1) * Float(sorted.count - 1)
    let i = Int(pos)
    let f = pos - Float(i)
    return i + 1 < sorted.count ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i]
  }

  static func percentile(_ values: [Float], _ q: Float) -> Float {
    return percentileSorted(values.sorted(), q)
  }

  static func median(_ values: [Float]) -> Float { percentile(values, 0.5) }

  static func stdDev(_ values: [Float]) -> Float {
    if values.count < 2 { return 0 }
    let m = values.reduce(0, +) / Float(values.count)
    let v = values.reduce(0) { $0 + ($1 - m) * ($1 - m) } / Float(values.count - 1)
    return v.squareRoot()
  }

  /// Destek düzlemi yüksekliği: Y histogramındaki (1 cm) tepelerden, kutu üstü tahmininin
  /// en az `minGap` altındaki EN YÜKSEK tepe (masa, zeminden önce). Yeterli destek yoksa nil.
  static func estimateSupportPlaneHeight(
    _ ys: [Float], topEstimate: Float, minGap: Float = 0.02, binSize: Float = 0.01,
    minFraction: Float = 0.03, minCount: Int = 50
  ) -> Float? {
    guard let lo = ys.min(), let hi = ys.max() else { return nil }
    let n = Int((hi - lo) / binSize) + 1
    if n <= 0 || n > 100_000 { return nil }
    var hist = [Int](repeating: 0, count: n)
    for y in ys {
      let i = min(max(Int((y - lo) / binSize), 0), n - 1)
      hist[i] += 1
    }
    let need = max(minCount, Int(Float(ys.count) * minFraction))
    var bestBin = -1
    for i in 0..<n {
      let c = hist[i]
      let left = i > 0 ? hist[i - 1] : 0
      let right = i < n - 1 ? hist[i + 1] : 0
      let center = lo + (Float(i) + 0.5) * binSize
      if c >= left && c >= right && c + left + right >= need && center < topEstimate - minGap {
        bestBin = i
      }
    }
    if bestBin < 0 { return nil }
    let c0 = lo + (Float(bestBin) + 0.5) * binSize
    var sum: Float = 0
    var cnt = 0
    for y in ys where abs(y - c0) <= 0.015 { sum += y; cnt += 1 }
    return cnt > 0 ? sum / Float(cnt) : c0
  }

  /// Taban A,B,C (D = A + C − B) ve yükseklikten 8 köşe: 0..3 alt, 4..7 üst.
  static func boxCorners(a: SIMD3<Float>, b: SIMD3<Float>, c: SIMD3<Float>, up: SIMD3<Float>, height: Float) -> [SIMD3<Float>] {
    let d = a + (c - b)
    let h = simd_normalize(up) * height
    return [a, b, c, d, a + h, b + h, c + h, d + h]
  }

  /// Taban dikdörtgeninden (XZ düzleminde) ve düzlem/yükseklikten 8 köşe.
  static func boxCorners(rect: RotatedRect, planeY: Float, height: Float) -> [SIMD3<Float>] {
    let base = rect.corners().map { SIMD3<Float>($0.x, planeY, $0.y) }
    let top = base.map { $0 + SIMD3<Float>(0, height, 0) }
    return base + top
  }

  static let boxEdges: [(Int, Int)] = [
    (0, 1), (1, 2), (2, 3), (3, 0),
    (4, 5), (5, 6), (6, 7), (7, 4),
    (0, 4), (1, 5), (2, 6), (3, 7),
  ]
}

/// AR köşe işaretleme durum makinesi (Android CornerMeasureState.kt ile aynı).
struct CornerMeasureState {
  enum Phase { case scan, corner1, corner2, corner3, height, done }

  private(set) var points: [SIMD3<Float>] = []
  private(set) var liveHeight: Float = 0
  private(set) var confirmedHeight: Float?
  private var planeFound = false
  let up = SIMD3<Float>(0, 1, 0)
  static let maxHeight: Float = 3

  var phase: Phase {
    if !planeFound && points.isEmpty { return .scan }
    switch points.count {
    case 0: return .corner1
    case 1: return .corner2
    case 2: return .corner3
    default: return confirmedHeight == nil ? .height : .done
    }
  }

  mutating func onPlaneDetected() { planeFound = true }

  @discardableResult
  mutating func tap(aim: SIMD3<Float>?) -> Bool {
    switch phase {
    case .scan, .done:
      return false
    case .corner1, .corner2, .corner3:
      guard let aim = aim else { return false }
      if let last = points.last, simd_distance(last, aim) < 0.01 { return false }
      points.append(aim)
      if points.count == 3 { liveHeight = 0 }
      return true
    case .height:
      if liveHeight < 0.005 { return false }
      confirmedHeight = liveHeight
      return true
    }
  }

  mutating func updateHeight(rayOrigin: SIMD3<Float>, rayDir: SIMD3<Float>) {
    guard phase == .height else { return }
    guard let t = MeasureGeometry.closestHeightOnVerticalLine(
      base: points[2], up: up, rayOrigin: rayOrigin, rayDir: rayDir) else { return }
    liveHeight = min(max(0, t), CornerMeasureState.maxHeight)
  }

  mutating func undo() {
    if confirmedHeight != nil {
      confirmedHeight = nil
    } else if !points.isEmpty {
      points.removeLast()
    }
  }

  mutating func reset() {
    points.removeAll()
    confirmedHeight = nil
    liveHeight = 0
  }

  var length: Float? { points.count >= 2 ? simd_distance(points[0], points[1]) : nil }
  var width: Float? { points.count >= 3 ? simd_distance(points[1], points[2]) : nil }
  var height: Float? { confirmedHeight ?? (phase == .height ? liveHeight : nil) }

  func boxCorners() -> [SIMD3<Float>]? {
    guard points.count >= 3 else { return nil }
    return MeasureGeometry.boxCorners(a: points[0], b: points[1], c: points[2], up: up, height: height ?? 0)
  }

  var instruction: String {
    switch phase {
    case .scan: return "Masayı tarayın: telefonu yavaşça gezdirin"
    case .corner1: return "Artı işaretini kolinin 1. alt köşesine getirip dokunun"
    case .corner2: return "2. köşeye dokunun (uzunluk)"
    case .corner3: return "3. köşeye dokunun (genişlik)"
    case .height: return "Telefonu yukarı doğrultun, artı işaretini üst köşeye getirip dokunun"
    case .done: return "Ölçüm tamam. Kaydet'e basın"
    }
  }
}
