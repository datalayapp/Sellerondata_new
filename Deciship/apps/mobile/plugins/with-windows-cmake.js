/**
 * Windows: SDK'daki CMake 3.22.1'in ninja'sı uzun yolları desteklemez; react-native-worklets
 * derlemesi "ninja: error: mkdir(...)" ile düşer. Bu eklenti, SDK'da kurulu en yeni CMake (>= 3.31,
 * ninja >= 1.12) varsa android/local.properties içine cmake.dir yazar.
 * Kurulum: sdkmanager "cmake;3.31.6"
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

function parseVer(v) {
  return v.split('.').map((n) => parseInt(n, 10) || 0);
}
function cmp(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findCmake() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const dir = path.join(sdk, 'cmake');
  if (!fs.existsSync(dir)) return null;
  const best = fs
    .readdirSync(dir)
    .filter((v) => /^\d+\.\d+/.test(v) && cmp(parseVer(v), [3, 31]) >= 0)
    .sort((a, b) => cmp(parseVer(b), parseVer(a)))[0];
  return best ? { sdk, cmake: path.join(dir, best) } : null;
}

const esc = (p) => p.replace(/\\/g, '\\\\').replace(/:/g, '\\:');

module.exports = function withWindowsCmake(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      if (process.platform !== 'win32') return cfg;
      const found = findCmake();
      if (!found) {
        console.warn('[with-windows-cmake] CMake >= 3.31 bulunamadı; `sdkmanager "cmake;3.31.6"` ile kurun.');
        return cfg;
      }
      const file = path.join(cfg.modRequest.platformProjectRoot, 'local.properties');
      let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
      lines = lines.filter((l) => l.trim() && !l.startsWith('cmake.dir='));
      if (!lines.some((l) => l.startsWith('sdk.dir='))) lines.push(`sdk.dir=${esc(found.sdk)}`);
      lines.push(`cmake.dir=${esc(found.cmake)}`);
      fs.writeFileSync(file, lines.join('\n') + '\n');
      return cfg;
    },
  ]);
};
