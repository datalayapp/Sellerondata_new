// Mesaj 12 Tur 0 (G): mobil tema belirteçlerinin BUGÜNKÜ değerleri (src/ui/theme.ts). Güncelleme yalnız orkestratör onayıyla (-u).
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default } }));

describe('mobil tema anlık görüntüsü', () => {
  it('belirteçler', async () => {
    const t = await import('../src/ui/theme');
    const snap = {
      colors: t.colors,
      bands: t.bands,
      radius: t.radius,
      space: t.space,
      touch: t.touch,
      shadow: t.shadow,
      hubColors: t.hubColors,
      nightChip: t.nightChip,
    };
    await expect(JSON.stringify(snap, null, 2) + '\n').toMatchFileSnapshot('./__golden__/theme-baseline.json');
  });
});
