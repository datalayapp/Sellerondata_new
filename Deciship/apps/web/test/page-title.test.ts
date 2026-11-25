// Sekme başlığı: ayrıntı sayfasından (Fatura 123) aynı menü sayfasına (Faturalar) dönünce eski başlık kalmamalı.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

(globalThis as Record<string, unknown>).document = { title: '' };
const { setDetailTitle, setShellTitle } = await import('../src/lib/pageTitle.ts');

describe('sekme başlığı', () => {
  it('ayrıntı başlığı önceliklidir; sayfadan çıkınca Shell adı geri gelir (Shell adı değişmese de)', () => {
    setShellTitle('Faturalar'); // /invoices
    assert.equal(document.title, 'Faturalar · DeciShip');
    setDetailTitle('Fatura 123'); // /invoices/123 — Shell'in adı yine "Faturalar", efekti yeniden çalışmaz
    assert.equal(document.title, 'Fatura 123 · DeciShip');
    setDetailTitle(null); // listeye dönüş: yalnız ayrıntı sayfasının temizliği çalışır
    assert.equal(document.title, 'Faturalar · DeciShip');
  });

  it('ayrıntı sayfası açıkken Shell adı değişse de ayrıntı başlığı kalır; ad yoksa yalnız DeciShip', () => {
    setDetailTitle('Tarife A');
    setShellTitle('Tarifeler');
    assert.equal(document.title, 'Tarife A · DeciShip');
    setDetailTitle(null);
    assert.equal(document.title, 'Tarifeler · DeciShip');
    setShellTitle(null);
    assert.equal(document.title, 'DeciShip');
  });
});
