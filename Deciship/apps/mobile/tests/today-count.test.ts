// 11-B13: "Bugün" sayacı sunucu listesinin 200 sınırında takılmasın. Sayı sunucunun bugün sayacından
// (`GET /measurements/stats/today`) gelir; telefonda bekleyen ölçümler eklenir. Sayaç yoksa listeden sayılır.
import { describe, expect, it } from 'vitest';
import { todayCount } from '../src/lib/todayCount';

describe('todayCount', () => {
  it('sunucu sayacı 200 sınırını aşar', () => {
    expect(todayCount({ listCount: 200, serverCount: 260, unsentToday: 0 })).toBe(260);
  });

  it('telefonda bekleyen (gönderilmemiş) ölçümler eklenir', () => {
    expect(todayCount({ listCount: 203, serverCount: 260, unsentToday: 3 })).toBe(263);
  });

  it('sayaç yoksa ya da hata verdiyse listeden sayılır (bugünkü davranış)', () => {
    expect(todayCount({ listCount: 12, serverCount: null, unsentToday: 2 })).toBe(12);
  });

  it('sayaçtan sonra gönderilen ölçüm listede varsa sayı geri düşmez', () => {
    expect(todayCount({ listCount: 8, serverCount: 6, unsentToday: 0 })).toBe(8);
  });

  it('geçersiz sayaç değeri yok sayılır', () => {
    expect(todayCount({ listCount: 5, serverCount: Number.NaN, unsentToday: 0 })).toBe(5);
    expect(todayCount({ listCount: 5, serverCount: -1, unsentToday: 0 })).toBe(5);
  });
});
