import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIT_ACTION_LABEL,
  CUSTOM_ROLE_LIMIT,
  CUSTOM_ROLE_PREFIX,
  PRODUCT_KEYS,
  PRODUCTS,
  ROLE_FORBIDDEN_REASONS,
  closePermissions,
  customRoleIdOf,
  customRoleKey,
  isCustomRoleKey,
  isRoleDeletable,
  isRolePermissionsLocked,
  orderPermissions,
  pickInviteRole,
  ownerOnlyPermissionsIn,
  permissionGroupOf,
  permissionsOf,
  requiredPermissionsOf,
  validateRolePermissions,
  type Permission,
} from '../src/index.ts';

const D = 'deciship';
const ALL = Object.keys(PRODUCTS.deciship.permissions) as Permission[];

test('ozel rol anahtari: custom: + kucuk harfli uuid', () => {
  const id = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b';
  assert.equal(CUSTOM_ROLE_PREFIX, 'custom:');
  assert.equal(customRoleKey(id), `custom:${id}`);
  assert.equal(isCustomRoleKey(`custom:${id}`), true);
  assert.equal(customRoleIdOf(`custom:${id}`), id);
  for (const v of ['MEASURE', 'ADMIN', 'custom:', `custom:${id.toUpperCase()}`, `custom:${id}x`, `Custom:${id}`, ` custom:${id}`, id, '', null, undefined, 3]) {
    assert.equal(isCustomRoleKey(v), false, String(v));
  }
  assert.equal(customRoleIdOf('MEASURE'), null);
  assert.equal(customRoleIdOf(null), null);
  // Hazır rol anahtarları özel rol biçimine hiç uymaz.
  for (const k of PRODUCT_KEYS) for (const r of PRODUCTS[k].roles) assert.equal(isCustomRoleKey(r.key), false);
  assert.ok(`custom:${id}`.length <= 64, 'productRolesSchema üst sınırı');
  assert.equal(CUSTOM_ROLE_LIMIT, 20);
});

test('DeciShip bagimliliklari plandaki gibi (v1: fatura ve disa aktarma fiyat ister)', () => {
  const req = PRODUCTS.deciship.permissionRequires ?? {};
  assert.deepEqual(req['deciship.invoices.view'], ['deciship.prices.view']);
  assert.deepEqual(req['deciship.data.export'], ['deciship.invoices.view', 'deciship.prices.view']);
  assert.deepEqual(req['deciship.tariffs.edit'], ['deciship.tariffs.view']);
  assert.deepEqual(req['deciship.measurements.manage'], ['deciship.measurements.view_all']);
  for (const free of ['deciship.web.access', 'deciship.reports.view', 'deciship.measurements.capture', 'deciship.measurements.view_all', 'deciship.prices.view'] as const) {
    assert.equal(req[free], undefined, free);
  }
  assert.ok(Object.isFrozen(req));
});

test('closePermissions: gecisli, katalog sirasi, tekil, bilinmeyen duser', () => {
  assert.deepEqual(closePermissions(D, ['deciship.tariffs.edit']), ['deciship.web.access', 'deciship.tariffs.view', 'deciship.tariffs.edit', 'deciship.prices.view']);
  assert.deepEqual(closePermissions(D, ['deciship.disputes.manage']), ['deciship.disputes.manage', 'deciship.invoices.view', 'deciship.prices.view']);
  assert.deepEqual(closePermissions(D, ['deciship.data.export', 'deciship.data.export', 'deciship.yok', 'orderloom.x']), [
    'deciship.invoices.view',
    'deciship.data.export',
    'deciship.prices.view',
  ]);
  assert.deepEqual(closePermissions(D, ['deciship.measurements.capture']), ['deciship.measurements.capture']);
  assert.deepEqual(closePermissions(D, []), []);
  assert.deepEqual(closePermissions(D, ALL), ALL);
  assert.deepEqual(closePermissions('orderloom', ['deciship.web.access']), []);
});

test('requiredPermissionsOf: gecisli gereksinim, kendisi haric', () => {
  assert.deepEqual(requiredPermissionsOf(D, 'deciship.tariffs.edit'), ['deciship.web.access', 'deciship.tariffs.view', 'deciship.prices.view']);
  assert.deepEqual(requiredPermissionsOf(D, 'deciship.lines.decide'), ['deciship.web.access', 'deciship.invoices.view', 'deciship.prices.view']);
  assert.deepEqual(requiredPermissionsOf(D, 'deciship.prices.view'), []);
  assert.deepEqual(requiredPermissionsOf(D, 'deciship.yok'), []);
});

test('validateRolePermissions: eksik (gecisli) ve bilinmeyen raporlanir, bir sey eklenmez', () => {
  assert.deepEqual(validateRolePermissions(D, []), { ok: true });
  assert.deepEqual(validateRolePermissions(D, ['deciship.measurements.capture']), { ok: true });
  assert.deepEqual(validateRolePermissions(D, ['deciship.invoices.view', 'deciship.prices.view']), { ok: true });
  // Bugünkü sızıntılar: fiyatsız fatura görme ve dışa aktarma reddedilir.
  assert.deepEqual(validateRolePermissions(D, ['deciship.invoices.view']), {
    ok: false,
    missing: [{ perm: 'deciship.invoices.view', requires: ['deciship.prices.view'] }],
    unknown: [],
  });
  assert.deepEqual(validateRolePermissions(D, ['deciship.data.export', 'deciship.invoices.view']), {
    ok: false,
    missing: [
      { perm: 'deciship.invoices.view', requires: ['deciship.prices.view'] },
      { perm: 'deciship.data.export', requires: ['deciship.prices.view'] },
    ],
    unknown: [],
  });
  // Geçişli: tariffs.edit tek başına; tariffs.view'un gereksinimleri de söylenir.
  assert.deepEqual(validateRolePermissions(D, ['deciship.tariffs.edit']), {
    ok: false,
    missing: [{ perm: 'deciship.tariffs.edit', requires: ['deciship.web.access', 'deciship.tariffs.view', 'deciship.prices.view'] }],
    unknown: [],
  });
  assert.deepEqual(validateRolePermissions(D, ['deciship.prices.view', 'orderloom.x', 'deciship.yok', 'orderloom.x']), {
    ok: false,
    missing: [],
    unknown: ['orderloom.x', 'deciship.yok'],
  });
  // Kapanmış set her zaman geçer.
  for (const p of ALL) assert.deepEqual(validateRolePermissions(D, closePermissions(D, [p])), { ok: true }, p);
});

test('her hazir rolun izin seti bagimliliklarla kapali', () => {
  for (const k of PRODUCT_KEYS) {
    for (const r of PRODUCTS[k].roles) {
      assert.deepEqual(validateRolePermissions(k, r.permissions), { ok: true }, `${k}/${r.key}`);
      assert.deepEqual(closePermissions(k, r.permissions), [...r.permissions], `${k}/${r.key}`);
    }
  }
});

test('kilitli roller: sahip rolu her zaman, ozel rol hic', () => {
  assert.deepEqual(PRODUCTS.deciship.lockedRoles, ['ADMIN']);
  assert.equal(isRolePermissionsLocked(D, 'ADMIN'), true);
  for (const r of ['AUDITOR', 'ACCOUNTING', 'MEASURE', 'custom:019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b', '']) assert.equal(isRolePermissionsLocked(D, r), false, r);
});

test('silinebilir roller: sahip rolu disinda hepsi; davet onsecimi gizli rolde kalan ilk role duser', () => {
  assert.equal(isRoleDeletable(D, 'ADMIN'), false);
  assert.equal(isRoleDeletable(D, ''), false);
  for (const r of ['AUDITOR', 'ACCOUNTING', 'MEASURE', 'custom:019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b']) assert.equal(isRoleDeletable(D, r), true, r);
  assert.equal(pickInviteRole(D, ['ADMIN', 'AUDITOR', 'ACCOUNTING', 'MEASURE']), 'MEASURE');
  assert.equal(pickInviteRole(D, ['ADMIN', 'ACCOUNTING', 'custom:019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b']), 'ADMIN');
  assert.equal(pickInviteRole(D, ['custom:019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b', 'MEASURE']), 'MEASURE');
  assert.equal(pickInviteRole(D, []), null);
  assert.equal(pickInviteRole('orderloom', ['X']), 'X');
});

test('sahibe ozel izinler: DeciShip ayar izni', () => {
  assert.deepEqual(PRODUCTS.deciship.ownerOnlyPermissions, ['deciship.settings.manage']);
  assert.deepEqual(ownerOnlyPermissionsIn(D, permissionsOf(D, 'ADMIN')), ['deciship.settings.manage']);
  for (const r of ['AUDITOR', 'ACCOUNTING', 'MEASURE']) assert.deepEqual(ownerOnlyPermissionsIn(D, permissionsOf(D, r)), [], r);
  assert.deepEqual(ownerOnlyPermissionsIn('orderloom', ['deciship.settings.manage']), []);
});

test('orderPermissions: katalog sirasi, tekil, bilinmeyen atilir', () => {
  assert.deepEqual(orderPermissions(D, ['deciship.prices.view', 'deciship.web.access', 'deciship.prices.view', 'deciship.yok']), ['deciship.web.access', 'deciship.prices.view']);
  assert.deepEqual(orderPermissions(D, []), []);
});

test('izin kumeleri: DeciShip izinleri tam bir kumede, etiketler dolu', () => {
  const groups = PRODUCTS.deciship.permissionGroups ?? [];
  assert.deepEqual(groups.map((g) => g.key), ['web', 'invoices', 'reports', 'tariffs', 'measurements', 'prices', 'settings']);
  const flat = groups.flatMap((g) => [...g.permissions]);
  assert.deepEqual([...flat].sort(), [...ALL].sort());
  assert.equal(new Set(flat).size, flat.length);
  for (const g of groups) assert.ok(g.label.tr.trim() && g.label.en.trim(), g.key);
  assert.equal(permissionGroupOf(D, 'deciship.prices.view'), 'prices');
  assert.equal(permissionGroupOf(D, 'deciship.data.export'), 'reports');
  assert.equal(permissionGroupOf(D, 'deciship.yok'), undefined);
  assert.equal(permissionGroupOf('orderloom', 'deciship.prices.view'), undefined);
});

test('rol denetim eylemleri ve ROLE_FORBIDDEN nedenleri iki dilde', () => {
  for (const a of ['role.created', 'role.updated', 'role.deleted', 'role.reset']) {
    assert.ok(AUDIT_ACTION_LABEL[a]?.tr.trim() && AUDIT_ACTION_LABEL[a]?.en.trim(), a);
  }
  assert.deepEqual(Object.keys(ROLE_FORBIDDEN_REASONS).sort(), ['escalation', 'owner_only', 'pending_admin_invites', 'unmanageable_holder']);
  for (const [k, t] of Object.entries(ROLE_FORBIDDEN_REASONS)) assert.ok(t.tr.trim() && t.en.trim(), k);
});
