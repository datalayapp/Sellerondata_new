import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(p, 'utf8');

/** Ölçüm akışı ekranlarının bağlantıları (emülatör gezisi bulguları). Saf mantık ayrı testlerde. */
describe('ölçüm akışı bağlantıları', () => {
  it('G3: tuş takımı işlevsel güncelleme alır; ekranlar bayat değer geçirmez', () => {
    expect(src('src/ui/NumPad.tsx')).toContain('onChange(numKeyUpdater(k, { maxDecimals, maxLength }))');
    for (const f of ['app/(tabs)/deciship/weight.tsx', 'app/(tabs)/deciship/measurement/edit.tsx']) {
      const s = src(f);
      expect(s, f).toMatch(/<NumPad onChange=\{set\w+\}/);
      expect(s, f).not.toMatch(/<NumPad[^>]*\bvalue=/);
    }
  });

  it('G4: düzeltme formu kayıt başına bir kez doldurulur', () => {
    const s = src('app/(tabs)/deciship/measurement/edit.tsx');
    expect(s).toContain('if (gate.claim(formKey)) void load();');
    expect(s).not.toMatch(/useEffect\(\(\) => \{\s*load\(\);\s*\}, \[load\]\)/);
  });

  it('G2: barkod ekranı ve fotoğraf penceresi ortak izin istemini kullanır', () => {
    for (const f of ['app/(tabs)/deciship/scan.tsx', 'src/ui/PhotoCapture.tsx']) {
      const s = src(f);
      expect(s, f).toContain('useCameraAccess()');
      expect(s, f).toContain('<CameraPermissionPrompt');
      expect(s, f).not.toContain('useCameraPermissions');
    }
    expect(src('src/ui/CameraPermission.tsx')).toContain('Linking.openSettings()');
    // İzin yokken deklanşör yerine açıklama.
    expect(src('src/ui/PhotoCapture.tsx')).toContain("t('ui.shootNeedsCamera')");
  });

  it('11-B15: ölçüm adımlarında ekran açık kalır; paket expo ile her derlemeye bağlıdır (yeni yerel modül değil)', () => {
    const layout = src('app/(tabs)/deciship/_layout.tsx');
    expect(layout).toContain("useKeepAwake('deciship-capture'");
    expect(layout).toContain('{capturing && !blocked ? <KeepScreenOn /> : null}');
    const expoPkg = JSON.parse(src('node_modules/expo/package.json')) as { dependencies: Record<string, string> };
    expect(expoPkg.dependencies['expo-keep-awake']).toBeTruthy();
    const mod = JSON.parse(src('node_modules/expo-keep-awake/expo-module.config.json')) as { android: { modules: string[] } };
    expect(mod.android.modules).toContain('expo.modules.keepawake.KeepAwakeModule');
  });

  it('G6: düzeltmede tuş takımı açıkken uyarı paneli alt şeritte gösterilmez', () => {
    expect(src('app/(tabs)/deciship/measurement/edit.tsx')).toContain('{!problems.length && !needsNet && !padOpen ? check.banner : null}');
  });
});
