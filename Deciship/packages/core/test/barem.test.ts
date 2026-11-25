import { describe, expect, it } from 'vitest';
import { baremNote, baremText } from '../src/barem';

const small = { l: 10, w: 10, h: 10 }; // hacimsel 0,2 kg
const note = (dims: { l: number; w: number; h: number }, actualKg: number, steps?: { upto: number | null; step: number }[]) =>
  baremNote({ dims, actualKg, divisor: 5000, steps });

describe('baremNote', () => {
  it('gerçek ağırlık 6,0 kg basamağını 0,2 kg aşıyor', () => {
    const n = note(small, 6.2);
    expect(n).toEqual({ kind: 'OVER', boundaryKg: 6, overKg: 0.2, nextKg: 6.5 });
    expect(baremText(n!)).toBe('Ücretli ağırlık 6,0 kg basamağını 0,2 kg aşıyor.');
  });

  it('gram düzeyinde aşım da yazılır; 0,2 kg üstü aşım yazılmaz', () => {
    expect(baremText(note(small, 6.05)!)).toBe('Ücretli ağırlık 6,0 kg basamağını 0,05 kg aşıyor.');
    expect(note(small, 6.25)).toBeNull();
  });

  it('tam basamakta, ilk basamağın altında ya da ölçü eksikken not yok', () => {
    expect(note(small, 6.5)).toBeNull();
    expect(note({ l: 40, w: 30, h: 25 }, 1)).toBeNull(); // hacimsel tam 6,0
    expect(note(small, 0.1)).toBeNull();
    expect(note({ l: 0, w: 10, h: 10 }, 6.2)).toBeNull();
    expect(note(small, 6.2, [])).toBeNull();
  });

  it('20 kg üstünde 1 kg basamağı kullanılır (varsayılan basamaklar)', () => {
    expect(note(small, 20.1)).toEqual({ kind: 'OVER', boundaryKg: 20, overKg: 0.1, nextKg: 21 });
    expect(note(small, 20.4)).toBeNull();
  });

  it('hacimsel ağırlıkta kenarlar yukarı yuvarlanır', () => {
    // 50×40×27,2 → 50×40×28 = 11,2 kg → 11,0 basamağını 0,2 ile aşar
    expect(note({ l: 50, w: 40, h: 27.2 }, 3)).toEqual({ kind: 'OVER', boundaryKg: 11, overKg: 0.2, nextKg: 11.5 });
  });

  it('kenar notu yok: hacimsel esasta kenarı kısaltmak basamağı düşürse bile not çıkmaz', () => {
    // 59×40×25 = 11,8 kg → 12; yükseklik 24 olsaydı 11,5 — bilerek yazılmaz (ölçüyü kısmaya özendirmesin)
    expect(note({ l: 59, w: 40, h: 25 }, 5)).toBeNull();
    expect(note({ l: 59, w: 40, h: 25 }, 11.8)).toBeNull();
  });

  it('verilen basamak kullanılır', () => {
    expect(note(small, 6.1, [{ upto: null, step: 1 }])).toEqual({ kind: 'OVER', boundaryKg: 6, overKg: 0.1, nextKg: 7 });
  });
});
