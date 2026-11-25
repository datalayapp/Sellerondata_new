// node --test src/lib/setupLayout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupLayout } from './setupLayout.ts';

const ok = { admin: true, companyConfirmed: true };

test('görünen araç yok, firma onaylı: normal', () => {
  assert.deepEqual(setupLayout({ ...ok, tools: [] }), { view: 'normal' });
});

test('yönetici, firma onaysız: araç beklenmeden başlangıç sayfası', () => {
  assert.deepEqual(setupLayout({ admin: true, companyConfirmed: false, tools: [] }), { view: 'start' });
  assert.deepEqual(setupLayout({ admin: true, companyConfirmed: false, tools: [{ key: 'deciship', setupOpen: false, pending: true }] }), { view: 'start' });
  // Aracın kurulumu bitmiş olsa da Merkez kurulumu eksik.
  assert.deepEqual(setupLayout({ admin: true, companyConfirmed: false, tools: [{ key: 'deciship', setupOpen: false }] }), { view: 'start' });
});

test('yönetici olmayan için firma onayı kural dışı', () => {
  assert.deepEqual(setupLayout({ admin: false, companyConfirmed: false, tools: [{ key: 'deciship', setupOpen: false }] }), { view: 'normal' });
  assert.deepEqual(setupLayout({ admin: false, companyConfirmed: false, tools: [] }), { view: 'normal' });
});

test('overview yükleniyor: karar beklenir', () => {
  assert.deepEqual(setupLayout({ ...ok, tools: [{ key: 'deciship', setupOpen: false, pending: true }] }), { view: 'loading' });
  assert.deepEqual(
    setupLayout({
      admin: false,
      companyConfirmed: true,
      tools: [
        { key: 'deciship', setupOpen: false },
        { key: 'orderloom', setupOpen: false, pending: true },
      ],
    }),
    { view: 'loading' },
  );
});

test('tek araç, kurulum açık: başlangıç sayfası', () => {
  assert.deepEqual(setupLayout({ ...ok, tools: [{ key: 'deciship', setupOpen: true }] }), { view: 'start' });
  assert.deepEqual(setupLayout({ admin: false, companyConfirmed: true, tools: [{ key: 'deciship', setupOpen: true }] }), { view: 'start' });
});

test('tek araç, kurulum bitmiş: Genel Bakış', () => {
  assert.deepEqual(setupLayout({ ...ok, tools: [{ key: 'deciship', setupOpen: false }] }), { view: 'normal' });
});

test('birden çok araç, hepsinin kurulumu açık: başlangıç sayfası', () => {
  const out = setupLayout({
    ...ok,
    tools: [
      { key: 'deciship', setupOpen: true },
      { key: 'tagpress', setupOpen: true },
    ],
  });
  assert.deepEqual(out, { view: 'start' });
});

test('birden çok araç, biri bitmiş: Genel Bakış, kurulumu açık araca ayrı kart yok', () => {
  const out = setupLayout({
    ...ok,
    tools: [
      { key: 'deciship', setupOpen: true },
      { key: 'orderloom', setupOpen: false },
      { key: 'tagpress', setupOpen: true },
    ],
  });
  assert.deepEqual(out, { view: 'normal' });
});

test('birden çok araç, hiçbirinin kurulumu açık değil: Genel Bakış', () => {
  assert.deepEqual(
    setupLayout({
      ...ok,
      tools: [
        { key: 'deciship', setupOpen: false },
        { key: 'orderloom', setupOpen: false },
      ],
    }),
    { view: 'normal' },
  );
});

test('hata veren araç (setupOpen false) başlangıcı tutmaz', () => {
  assert.deepEqual(
    setupLayout({
      ...ok,
      tools: [
        { key: 'deciship', setupOpen: true },
        { key: 'orderloom', setupOpen: false },
      ],
    }),
    { view: 'normal' },
  );
});
