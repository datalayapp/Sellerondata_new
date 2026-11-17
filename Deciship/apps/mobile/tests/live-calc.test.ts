import { describe, expect, it } from 'vitest';
import { computeLive, VOLUMETRIC_DIVISOR } from '../src/lib/liveCalc';

describe('canlı hesap: desi firma böleniyle, ücretli ağırlık 5000 ile (G5, SPEC §3.1 ve §6)', () => {
  it('emülatördeki özet: 200×30×20 cm, 3,25 kg, bölen 3000 → desi 40, hacimsel 24, ücretli 24 kg (hacimsel)', () => {
    expect(computeLive({ l: 200, w: 30, h: 20, kg: 3.25, desiDivisor: 3000 })).toEqual({ desi: 40, volumetric: 24, chargeable: 24, basis: 'VOLUMETRIC' });
  });

  it('firma böleni yalnız desiyi değiştirir; hacimsel ve ücretli ağırlık sabit 5000 ile', () => {
    expect(VOLUMETRIC_DIVISOR).toBe(5000);
    const a = computeLive({ l: 200, w: 30, h: 20, kg: 3.25, desiDivisor: 3000 })!;
    const b = computeLive({ l: 200, w: 30, h: 20, kg: 3.25, desiDivisor: 5000 })!;
    expect(b.desi).toBe(24);
    expect([b.volumetric, b.chargeable, b.basis]).toEqual([a.volumetric, a.chargeable, a.basis]);
  });

  it('SPEC örneği (#5305): 40×30×25, 4 kg → hacimsel 6, ücretli 6; bölen 3000 → 10 desi', () => {
    expect(computeLive({ l: 40, w: 30, h: 25, kg: 4, desiDivisor: 3000 })).toEqual({ desi: 10, volumetric: 6, chargeable: 6, basis: 'VOLUMETRIC' });
  });

  it('gerçek ağırlık büyükse o esas alınır; ölçü eksikse hesap yok', () => {
    expect(computeLive({ l: 40, w: 30, h: 20, kg: 9.5, desiDivisor: 3000 })).toMatchObject({ chargeable: 9.5, basis: 'ACTUAL' });
    expect(computeLive({ l: 40, w: null, h: 20, kg: 9.5, desiDivisor: 3000 })).toBeNull();
  });
});
