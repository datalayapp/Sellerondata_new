Pod::Spec.new do |s|
  s.name           = 'BoxMeasure'
  s.version        = '1.0.0'
  s.summary        = 'DeciShip koli ölçümü (LiDAR otomatik + AR köşe işaretleme)'
  s.description    = 'ARKit tabanlı koli ölçüm modülü (Expo Modules API).'
  s.author         = 'DeciShip'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.license        = 'UNLICENSED'
  s.platforms      = {
    :ios => '16.4'
  }
  # Swift 5 dil kipi: ARKit temsilci uyumlarında Swift 6 katı eşzamanlılık hatalarını önler.
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'ARKit', 'SceneKit', 'AVFoundation', 'UIKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
