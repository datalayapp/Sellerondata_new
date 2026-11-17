import { describe, expect, it } from 'vitest';
import { stepDim } from '../src/lib/dimStep';

const O = { step: 1, min: 0.1, max: 400 };

describe('ölçü alanı − / + düğmesi', () => {
  it('bir adım artırır ve azaltır, 0,1 hassasiyetle', () => {
    expect(stepDim(40, 1, O)).toBe(41);
    expect(stepDim(40.25, -1, O)).toBe(39.3);
    expect(stepDim(null, 1, O)).toBe(1);
  });

  it('sınırda kırpar; sınır üstü yazılıysa − sınırdan başlar', () => {
    expect(stepDim(400, 1, O)).toBe(400);
    expect(stepDim(0.5, -1, O)).toBe(0.1);
    expect(stepDim(null, -1, O, true)).toBe(399);
  });

  it('G3: hızlı üç basış, ekran yenilenmeden de üç adım ilerler', () => {
    // DimField son bildirdiği değeri tutar ve basışı ona uygular (ekrandaki bayat değere değil).
    const shown = 40; // yeniden çizilmemiş ekran
    let last: number | null = shown;
    for (let i = 0; i < 3; i++) last = stepDim(last, 1, O);
    expect(last).toBe(43);
    // Eski hesap (her basışta ekrandaki değer) tek adımda kalırdı:
    expect(stepDim(shown, 1, O)).toBe(41);
  });
});
