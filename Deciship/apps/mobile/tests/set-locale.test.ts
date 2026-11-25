import { describe, expect, it, vi } from 'vitest';
vi.mock('expo-constants', () => ({ default: { expoConfig: { version: '1.1.0', android: { versionCode: 2 }, extra: { sod: { appEnv: 'development' } } } } }));
import { i18n, setLocale } from '../src/i18n';

describe('setLocale: aynı dile geçiş olay yaymaz (G4 kökü)', () => {
  it('dil aynıysa languageChanged yok; farklıysa var', async () => {
    await setLocale('tr');
    let events = 0;
    const on = () => (events += 1);
    i18n.on('languageChanged', on);
    await setLocale('tr');
    expect(events).toBe(0);
    await setLocale('en');
    expect(events).toBe(1);
    expect(i18n.language).toBe('en');
    await setLocale('tr');
    i18n.off('languageChanged', on);
  });
});
