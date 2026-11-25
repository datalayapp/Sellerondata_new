import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PRODUCT_KEYS,
  PRODUCTS,
  DECISHIP_PERMISSIONS,
  PERMISSION_LABEL,
  permissionsOf,
  can,
  isValidProductRole,
  type Permission,
  type ProductKey,
} from '../src/index.ts';

const ALL_PERMISSIONS = Object.keys(PERMISSION_LABEL) as Permission[];

test('urun anahtarlari tekil, DeciShip var ve kayitla ayni sirada', () => {
  assert.ok(PRODUCT_KEYS.includes('deciship'));
  assert.deepEqual([...PRODUCT_KEYS], Object.keys(PRODUCTS));
  assert.equal(new Set(PRODUCT_KEYS).size, PRODUCT_KEYS.length);
  for (const k of PRODUCT_KEYS) {
    assert.equal(PRODUCTS[k].key, k);
    assert.equal(PRODUCTS[k].basePath, `/${k}`);
  }
});

test('her rolun izinleri urunun izin listesinin alt kumesi ve onek urun anahtari', () => {
  for (const key of PRODUCT_KEYS) {
    const def = PRODUCTS[key];
    const own = Object.keys(def.permissions);
    const roleKeys = def.roles.map((r) => r.key);
    assert.equal(new Set(roleKeys).size, roleKeys.length, `${key}: rol anahtarlari tekil`);
    for (const role of def.roles) {
      for (const p of role.permissions) {
        assert.ok(own.includes(p), `${key}/${role.key}: ${p} listede`);
        assert.ok(p.startsWith(`${key}.`), `${key}/${role.key}: ${p} oneki`);
      }
    }
  }
});

test('izin listesi tekil ve her iznin etiketi var', () => {
  assert.equal(new Set(ALL_PERMISSIONS).size, ALL_PERMISSIONS.length);
  for (const p of ALL_PERMISSIONS) {
    assert.ok(PERMISSION_LABEL[p].tr.length > 0);
    assert.ok(PERMISSION_LABEL[p].en.length > 0);
  }
  const perProduct = PRODUCT_KEYS.reduce((n, k) => n + Object.keys(PRODUCTS[k].permissions).length, 0);
  assert.equal(ALL_PERMISSIONS.length, perProduct);
});

test('DeciShip izinleri ve rolleri kayda tasinmadan onceki haliyle ayni (sira dahil)', () => {
  const expected = [
    'deciship.web.access',
    'deciship.settings.manage',
    'deciship.tariffs.view',
    'deciship.tariffs.edit',
    'deciship.invoices.upload',
    'deciship.lines.decide',
    'deciship.disputes.manage',
    'deciship.invoices.view',
    'deciship.reports.view',
    'deciship.data.export',
    'deciship.measurements.capture',
    'deciship.measurements.view_all',
    'deciship.measurements.manage',
    'deciship.prices.view',
  ];
  assert.deepEqual(ALL_PERMISSIONS.filter((p) => p.startsWith('deciship.')), expected);
  assert.deepEqual([...permissionsOf('deciship', 'ADMIN')], expected);
  assert.deepEqual(
    PRODUCTS.deciship.roles.map((r) => [r.key, r.permissions.length]),
    [['ADMIN', 14], ['AUDITOR', 12], ['ACCOUNTING', 9], ['MEASURE', 1]],
  );
  assert.deepEqual([...permissionsOf('deciship', 'MEASURE')], ['deciship.measurements.capture']);
  // Y123: Muhasebe fatura yükler (başlık düzeltme ve silme aynı izinle); fark kararı, tarife düzenleme ve ayar yok.
  assert.deepEqual([...permissionsOf('deciship', 'ACCOUNTING')], [
    'deciship.web.access',
    'deciship.tariffs.view',
    'deciship.invoices.upload',
    'deciship.disputes.manage',
    'deciship.invoices.view',
    'deciship.reports.view',
    'deciship.data.export',
    'deciship.measurements.view_all',
    'deciship.prices.view',
  ]);
  assert.equal(PRODUCTS.deciship.ownerRole, 'ADMIN');
  assert.equal(PRODUCTS.deciship.inviteRole, 'MEASURE');
  assert.equal(PRODUCTS.deciship.webAccess, 'deciship.web.access');
  assert.equal(PRODUCTS.deciship.color, '#1d5bd8');
  assert.deepEqual(PRODUCTS.deciship.hub, {
    analytics: 'deciship.reports.view',
    data: 'deciship.invoices.view',
    export: 'deciship.data.export',
    headline: ['overcharge', 'open', 'deadlines'],
  });
  assert.deepEqual(PRODUCTS.deciship.tagline, { tr: 'Kargo faturasındaki fazlayı bulun', en: 'Find overcharges on your carrier invoices' });
});

test('rol izin dizileri donuk', () => {
  for (const key of PRODUCT_KEYS) for (const r of PRODUCTS[key].roles) assert.ok(Object.isFrozen(r.permissions), `${key}/${r.key}`);
  assert.ok(Object.isFrozen(permissionsOf('deciship', null)));
});

test('bilinmeyen, bos ve null rolde permissionsOf bos dizi', () => {
  for (const key of PRODUCT_KEYS) {
    assert.deepEqual(permissionsOf(key, 'yok-boyle-rol'), []);
    assert.deepEqual(permissionsOf(key, null), []);
    assert.deepEqual(permissionsOf(key, undefined), []);
    assert.deepEqual(permissionsOf(key, ''), []);
  }
});

test('can ile permissionsOf tutarli', () => {
  for (const key of PRODUCT_KEYS) {
    const roles: (string | null)[] = [...PRODUCTS[key].roles.map((r) => r.key), 'yok', null];
    for (const role of roles) {
      const granted = permissionsOf(key, role);
      for (const p of ALL_PERMISSIONS) {
        assert.equal(can(key, role, p), granted.includes(p), `${key}/${String(role)}/${p}`);
      }
    }
  }
});

test('isValidProductRole', () => {
  const def = PRODUCTS.deciship;
  assert.ok(def.roles.length > 0);
  for (const r of def.roles) assert.equal(isValidProductRole('deciship', r.key), true);
  assert.equal(isValidProductRole('deciship', 'yok-boyle-rol'), false);
  assert.equal(isValidProductRole('deciship', ''), false);
  const off: ProductKey[] = ['orderloom'];
  for (const k of off) {
    assert.equal(PRODUCTS[k].launch, 'off');
    assert.equal(isValidProductRole(k, 'ADMIN'), false);
  }
  assert.equal(PRODUCTS.tagpress.launch, 'pilot');
  for (const r of ['ADMIN', 'USER']) assert.equal(isValidProductRole('tagpress', r), true);
});

test('ownerRole ve inviteRole gecerli bir rol', () => {
  for (const key of PRODUCT_KEYS) {
    const { ownerRole, inviteRole } = PRODUCTS[key];
    if (ownerRole !== null) assert.equal(isValidProductRole(key, ownerRole), true, key);
    if (inviteRole !== null) assert.equal(isValidProductRole(key, inviteRole), true, key);
  }
});

test('hub izinleri urunun izin listesinde', () => {
  const hub = PRODUCTS.deciship.hub;
  assert.ok(hub);
  for (const p of [hub.analytics, hub.data, hub.export]) {
    assert.ok(p in PRODUCTS.deciship.permissions);
  }
});

// Katalogda "açık mı" alanı yok: kayıtta `launch`, firmada `me.products[].available` (Hesap servisi).
test('katalog girdisinde eski available alani yok', () => {
  for (const key of PRODUCT_KEYS) assert.equal('available' in PRODUCTS[key], false, key);
});

// Eski dışa aktarım Tur 1 okuyanları geçirene kadar aynı anlamla durur; sonra bu test silinir.
test('kaldirilacak eski alan: DECISHIP_PERMISSIONS', () => {
  assert.deepEqual([...DECISHIP_PERMISSIONS], ALL_PERMISSIONS.filter((p) => p.startsWith('deciship.')));
});
