/**
 * box-measure config plugin.
 *
 * app.json → "plugins": [..., "./modules/box-measure/app.plugin.js"]
 *   veya özel metinle: ["./modules/box-measure/app.plugin.js", { "cameraPermission": "..." }]
 *
 * iOS: NSCameraUsageDescription yoksa ekler (ARKit kamerası için gerekli).
 * Android: CAMERA izni, ARCore "optional" meta-data, uses-feature (camera.ar, zorunlu değil)
 *          ve ölçüm aktivitesi modülün kendi AndroidManifest.xml'inden birleştirilir;
 *          burada yalnızca CAMERA izninin uygulamada da olduğundan emin olunur.
 */
const { AndroidConfig, withInfoPlist, withAndroidManifest, createRunOncePlugin } = require('expo/config-plugins');

const DEFAULT_CAMERA_TEXT = 'Kolinin ölçüsünü kamerayla almak için kamera kullanılır.';

function withBoxMeasure(config, props = {}) {
  const cameraText = (props && props.cameraPermission) || DEFAULT_CAMERA_TEXT;

  config = withInfoPlist(config, (cfg) => {
    if (!cfg.modResults.NSCameraUsageDescription) {
      cfg.modResults.NSCameraUsageDescription = cameraText;
    }
    return cfg;
  });

  config = withAndroidManifest(config, (cfg) => {
    AndroidConfig.Permissions.ensurePermissions(cfg.modResults, ['android.permission.CAMERA']);
    return cfg;
  });

  return config;
}

module.exports = createRunOncePlugin(withBoxMeasure, 'box-measure', '1.0.0');
