import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { listReloadNeeded } from '../src/lib/listReload';

/** Gezide: kuyruk boşalıp "Tümü gönderildi" yazınca Bugün ekranındaki "Liste yüklenemedi" kutusu kalıyordu. */
describe('Bugün listesi kuyruk ve bağlantı değişince bir kez yeniden istenir', () => {
  const s = (waiting: number, online = true) => ({ waiting, online });

  it('kuyruk boşaldı, liste yüklenememişti: yeniden istenir', () => {
    expect(listReloadNeeded(s(2), s(0), true)).toBe(true);
  });

  it('kuyruk boşaldı, liste zaten yüklü: istenmez (gönderilen kayıt yerelden görünür)', () => {
    expect(listReloadNeeded(s(1), s(0), false)).toBe(false);
  });

  it('kuyruk azaldı ama boşalmadı: istenmez', () => {
    expect(listReloadNeeded(s(3), s(1), true)).toBe(false);
  });

  it('bağlantı geri geldi: liste yüklü olsa da yeniden istenir', () => {
    expect(listReloadNeeded(s(0, false), s(0, true), false)).toBe(true);
    expect(listReloadNeeded(s(2, false), s(2, true), true)).toBe(true);
  });

  it('bağlantı yokken kuyruk boşaldı (kayıt silindi): istenmez', () => {
    expect(listReloadNeeded(s(1, false), s(0, false), true)).toBe(false);
  });

  it('değişiklik yok: istenmez (yeniden çizim döngüye girmez)', () => {
    expect(listReloadNeeded(s(0), s(0), true)).toBe(false);
    expect(listReloadNeeded(s(2), s(2), true)).toBe(false);
    expect(listReloadNeeded(s(0, false), s(0, false), true)).toBe(false);
  });

  it('Bugün ekranı kuralı kullanıyor', () => {
    const src = readFileSync('app/(tabs)/deciship/today.tsx', 'utf8');
    expect(src).toContain('listReloadNeeded(');
  });
});
