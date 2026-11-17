/**
 * IBM Plex Sans / Mono (DESIGN.md tipografisi) — assets/fonts/*.ttf dosyalarını Android'in
 * android/app/src/main/assets/fonts klasörüne kopyalar. React Native Android bu klasördeki
 * dosyaları dosya adıyla (ör. fontFamily: 'IBMPlexSans-SemiBold') yükler; ek paket gerekmez.
 * iOS'ta theme.ts sistem yazı tipine düşer.
 */
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');

module.exports = function withFonts(config) {
  return withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.join(cfg.modRequest.projectRoot, 'assets', 'fonts');
      const dst = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'assets', 'fonts');
      if (!fs.existsSync(src)) return cfg;
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        if (f.endsWith('.ttf')) fs.copyFileSync(path.join(src, f), path.join(dst, f));
      }
      return cfg;
    },
  ]);
};
