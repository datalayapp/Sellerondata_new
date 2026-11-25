// Sahte Hesap servisinin rol kuralları (mocks/roles.ts) plan ve sözleşmeye uyar: `npm test`'in sahte API denetimi anlamlı kalsın.
// Gerçek `/org/roles` yanıt kaydı henüz yok (Hesap servisi bölüm A); kayıt gelince şekil karşılaştırması buraya eklenir.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSeed } from '@sellerondata/shell/mock-seed';
import { checkAssignment, createRole, deleteRole, patchRole, resetRole, resolveRole, rolesResponse } from '../mocks/roles.ts';

const D = (s) => `deciship.${s}`;
const setup = () => {
  const db = createMockSeed();
  const m = (id) => db.memberships.find((x) => x.id === id);
  return { db, owner: m('m1'), admin: m('m2') };
};
const product = (db, viewer) => rolesResponse(db, viewer, 'tr').products.find((p) => p.key === 'deciship');

describe('GET /org/roles şekli', () => {
  test('sözleşmenin alanları: ürün, küme, izin, rol, gizli hazır roller, üst sınır', () => {
    const { db, owner } = setup();
    const res = rolesResponse(db, owner, 'tr');
    // TagPress `pilot`: taklit her firmaya abonelik verir (gerçek tohumda iki firmada da TagPress aboneliği var), rol düzenleyicide görünür.
    assert.deepEqual(res.products.map((p) => p.key), ['deciship', 'tagpress']);
    const p = res.products[0];
    assert.deepEqual(Object.keys(p).sort(), ['customRoleLimit', 'groups', 'hiddenBuiltins', 'key', 'permissions', 'roles']);
    assert.deepEqual(p.groups.map((g) => g.key), ['web', 'invoices', 'reports', 'tariffs', 'measurements', 'prices', 'settings']);
    assert.deepEqual(Object.keys(p.permissions[0]).sort(), ['group', 'key', 'label', 'ownerOnly', 'requires']);
    assert.deepEqual(p.permissions.find((x) => x.key === D('data.export')).requires, [D('invoices.view'), D('prices.view')]);
    assert.equal(p.permissions.find((x) => x.key === D('settings.manage')).ownerOnly, true);
    const r = p.roles.find((x) => x.key === 'MEASURE');
    assert.deepEqual(Object.keys(r).sort(), ['deletable', 'description', 'editable', 'edited', 'inviteCount', 'key', 'kind', 'memberCount', 'name', 'permissions', 'permissionsLocked', 'version']);
    assert.deepEqual([r.kind, r.name, r.memberCount, r.inviteCount, r.version, r.edited], ['builtin', 'Ölçüm', 3, 1, 0, false]);
    const a = p.roles.find((x) => x.key === 'ADMIN');
    assert.deepEqual([a.permissionsLocked, a.deletable, a.editable], [true, false, true]);
    assert.equal(rolesResponse(db, owner, 'en').products[0].roles[0].name, 'Admin');
  });

  test('firma yöneticisi: sahibe özel izinli rolü ve kendisinin/sahibin taşıdığı rolü yönetemez', () => {
    const { db, admin } = setup();
    const p = product(db, admin);
    assert.equal(p.roles.find((r) => r.key === 'ADMIN').editable, false); // ayar izni + sahibi taşıyor
    assert.equal(p.roles.find((r) => r.key === 'AUDITOR').editable, false); // kendisi taşıyor
    assert.equal(p.roles.find((r) => r.key === 'MEASURE').editable, true);
    assert.equal(p.roles.find((r) => r.key === 'MEASURE').deletable, true);
  });
});

describe('oluşturma', () => {
  test('özel rol custom:<uuid>, katalog sırası, üyeye atanır, /me çözer', () => {
    const { db, owner } = setup();
    const r = createRole(db, owner, 'Selin Aydın', { product: 'deciship', name: ' Depo şefi ', permissions: [D('measurements.manage'), D('measurements.view_all'), D('measurements.capture')], basedOn: 'MEASURE' }, 'tr');
    assert.equal(r.status, 201);
    const created = r.body.role;
    assert.match(created.key, /^custom:[0-9a-f-]{36}$/);
    assert.deepEqual([created.kind, created.name, created.version, created.basedOn], ['custom', 'Depo şefi', 1, 'MEASURE']);
    assert.deepEqual(created.permissions, [D('measurements.capture'), D('measurements.view_all'), D('measurements.manage')]);
    assert.equal(checkAssignment(db, owner, { deciship: created.key }, 'tr'), null);
    assert.deepEqual(resolveRole(db, 'o1', 'deciship', created.key, 'tr').permissions, created.permissions);
    assert.equal(db.audit[0].action, 'role.created');
  });

  test('eksik bağımlılık kendiliğinden eklenmez: 400 INVALID_ROLE_PERMISSIONS', () => {
    const { db, owner } = setup();
    const r = createRole(db, owner, 'x', { product: 'deciship', name: 'Fatura', permissions: [D('invoices.view')] }, 'tr');
    assert.equal(r.status, 400);
    assert.equal(r.error.code, 'INVALID_ROLE_PERMISSIONS');
    assert.deepEqual(r.error.details.missing, [{ perm: D('invoices.view'), requires: [D('prices.view')] }]);
  });

  test('ad çakışması (büyük/küçük harf duyarsız) 409, yönetici sahibe özel izin 403 owner_only, olmayan izin 403 escalation', () => {
    const { db, owner, admin } = setup();
    assert.equal(createRole(db, owner, 'x', { product: 'deciship', name: 'muhasebe', permissions: [] }, 'tr').error.code, 'ROLE_NAME_TAKEN');
    const own = createRole(db, admin, 'x', { product: 'deciship', name: 'Ayarcı', permissions: [D('settings.manage'), D('web.access'), D('prices.view')] }, 'tr');
    assert.deepEqual([own.status, own.error.code, own.error.details.reason], [403, 'ROLE_FORBIDDEN', 'owner_only']);
    const esc = createRole(db, admin, 'x', { product: 'deciship', name: 'İtirazcı', permissions: [D('disputes.manage'), D('invoices.view'), D('prices.view')] }, 'tr');
    assert.deepEqual([esc.error.details.reason, esc.error.details.permissions], ['escalation', [D('disputes.manage')]]);
  });

  test('özel rol sınırı 20: 21. rol 409 ROLE_LIMIT', () => {
    const { db, owner } = setup();
    for (let i = 0; i < 20; i++) assert.equal(createRole(db, owner, 'x', { product: 'deciship', name: `Rol ${i}`, permissions: [] }, 'tr').status, 201);
    assert.equal(createRole(db, owner, 'x', { product: 'deciship', name: 'Rol 21', permissions: [] }, 'tr').error.code, 'ROLE_LIMIT');
  });
});

describe('düzenleme', () => {
  test('hazır rolün ilk düzenlemesi gölge satır açar (sürüm 1, Düzenlendi); eski sürüm 409 ROLE_VERSION', () => {
    const { db, owner } = setup();
    const r = patchRole(db, owner, 'x', { product: 'deciship', key: 'AUDITOR' }, { name: 'Kontrolcü', version: 0 }, 'tr');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.role.key, r.body.role.name, r.body.role.edited, r.body.role.version], ['AUDITOR', 'Kontrolcü', true, 1]);
    assert.equal(patchRole(db, owner, 'x', { product: 'deciship', key: 'AUDITOR' }, { name: 'Yine', version: 0 }, 'tr').error.code, 'ROLE_VERSION');
    // Üyelik göç etmez: anahtar aynı, ad yeni.
    assert.equal(resolveRole(db, 'o1', 'deciship', 'AUDITOR', 'tr').name, 'Kontrolcü');
  });

  test('sahip rolünün izni değişmez (403 ROLE_LOCKED), adı değişir; açıklama null ile silinir', () => {
    const { db, owner } = setup();
    assert.equal(patchRole(db, owner, 'x', { product: 'deciship', key: 'ADMIN' }, { permissions: [D('web.access')], version: 0 }, 'tr').error.code, 'ROLE_LOCKED');
    const r = patchRole(db, owner, 'x', { product: 'deciship', key: 'ADMIN' }, { name: 'Patron', description: null, version: 0 }, 'tr');
    assert.equal(r.body.role.name, 'Patron');
    assert.equal(r.body.role.description, undefined);
    assert.equal(r.body.role.permissions.length, 14);
  });

  test('firma yöneticisi kendisinin taşıdığı rolü düzenleyemez: 403 unmanageable_holder', () => {
    const { db, admin } = setup();
    const r = patchRole(db, admin, 'x', { product: 'deciship', key: 'AUDITOR' }, { name: 'Ben', version: 0 }, 'tr');
    assert.deepEqual([r.status, r.error.details.reason], [403, 'unmanageable_holder']);
  });
});

describe('silme, varsayılana dönüş, atama', () => {
  test('kullanımdaki rol reassignTo olmadan 409 ROLE_IN_USE; taşıyınca kişi ve davet yeni role geçer, hazır rol gizlenir', () => {
    const { db, owner } = setup();
    const target = { product: 'deciship', key: 'MEASURE' };
    const busy = deleteRole(db, owner, 'x', target, null, 'tr');
    assert.deepEqual([busy.status, busy.error.code, busy.error.details], [409, 'ROLE_IN_USE', { members: 3, invites: 1 }]);
    assert.equal(deleteRole(db, owner, 'x', target, 'MEASURE', 'tr').error.code, 'INVALID_PRODUCT_ROLE');
    const ok = deleteRole(db, owner, 'x', target, 'ACCOUNTING', 'tr');
    assert.deepEqual(ok.body, { ok: true, reassigned: { members: 3, invites: 1 } });
    assert.equal(db.memberships.find((m) => m.id === 'm5').productRoles.deciship, 'ACCOUNTING');
    assert.equal(db.invitations.find((i) => i.id === 'i1').productRoles.deciship, 'ACCOUNTING');
    const p = product(db, owner);
    assert.equal(p.roles.some((r) => r.key === 'MEASURE'), false);
    assert.deepEqual(p.hiddenBuiltins, [{ key: 'MEASURE', name: 'Ölçüm' }]);
    // Gizli hazır rol atanamaz.
    assert.equal(checkAssignment(db, owner, { deciship: 'MEASURE' }, 'tr').error.code, 'INVALID_PRODUCT_ROLE');
    // Geri getirme: katalog haline döner.
    const back = resetRole(db, owner, 'x', 'deciship', 'MEASURE', 'tr');
    assert.deepEqual([back.status, back.body.role.edited, back.body.role.version], [200, false, 0]);
    assert.deepEqual(product(db, owner).hiddenBuiltins, []);
    assert.equal(db.audit[0].details.unhidden, true);
  });

  test('sahip rolü silinmez: 403 ROLE_LOCKED; kullanılmayan özel rol doğrudan silinir', () => {
    const { db, owner } = setup();
    assert.equal(deleteRole(db, owner, 'x', { product: 'deciship', key: 'ADMIN' }, 'MEASURE', 'tr').error.code, 'ROLE_LOCKED');
    const c = createRole(db, owner, 'x', { product: 'deciship', name: 'Boş', permissions: [] }, 'tr').body.role;
    const ok = deleteRole(db, owner, 'x', { custom: c.key.slice(7) }, null, 'tr');
    assert.deepEqual(ok.body, { ok: true, reassigned: { members: 0, invites: 0 } });
    assert.equal(resolveRole(db, 'o1', 'deciship', c.key, 'tr'), null);
  });

  test('yöneticiye sahibe özel izinli rol atanamaz, taşıma hedefi de olamaz', () => {
    const { db, admin } = setup();
    assert.equal(checkAssignment(db, admin, { deciship: 'ADMIN' }, 'tr').error.details.reason, 'owner_only');
    assert.equal(checkAssignment(db, admin, { deciship: 'MEASURE' }, 'tr'), null);
    assert.equal(deleteRole(db, admin, 'x', { product: 'deciship', key: 'MEASURE' }, 'ADMIN', 'tr').error.details.reason, 'owner_only');
  });
});
