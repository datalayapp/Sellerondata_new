/**
 * Yazı boyutu, ekran yoğunluğu veya sistem dili değişince Android etkinliği yeniden yaratır. React kökü yeniden bağlanırken
 * expo-router'ın genel `router` nesnesi bağsız kalır ve sonraki ilk `router.push` uygulamayı düşürür
 * ("The imperative router is unavailable before the first render has finished"). Depoda ayarlardan yazıyı büyütüp dönen
 * çalışan "Yeni ölçüm"e basınca uygulama kapanıyordu. Bu değişiklikler etkinliği yeniden yaratmasın; React Native uygular.
 */
const { AndroidConfig, withAndroidManifest } = require('expo/config-plugins');

const EXTRA = ['fontScale', 'density', 'locale', 'layoutDirection'];

function withExtraConfigChanges(value) {
  const current = String(value ?? '').split('|').filter(Boolean);
  return [...current, ...EXTRA.filter((c) => !current.includes(c))].join('|');
}

module.exports = function withConfigChanges(config) {
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    activity.$['android:configChanges'] = withExtraConfigChanges(activity.$['android:configChanges']);
    return cfg;
  });
};
module.exports.withExtraConfigChanges = withExtraConfigChanges;
