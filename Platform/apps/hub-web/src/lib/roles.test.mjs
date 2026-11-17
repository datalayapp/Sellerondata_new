// Rol düzenleyicinin kuralları (roles.ts): bağımlılığın kendiliğinden işaretlenmesi, sahibe özel izin kilidi, yetki yükseltme,
// sahip rolünün kilidi, silmede taşıma hedefleri, hata türleri ve uç adresleri. Kaynak yanıt sahte API'nin ürettiğidir
// (sözleşme şekli; mocks/roles.ts), yani bu test gerçek kayıt geldiğinde de aynı alanlara bakar.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSeed } from '@sellerondata/shell/mock-seed';
import { rolesResponse } from '../mocks/roles.ts';
import {
  catalogRolesProduct,
  copyName,
  defaultReassign,
  deleteRolePath,
  effectivePermissions,
  isUpgrade,
  permissionBlock,
  permissionRows,
  reassignTargets,
  resetRolePath,
  roleErrorOf,
  roleName,
  roleNameIssue,
  rolePath,
  templatePermissions,
  togglePermission,
} from './roles.ts';

const D = (s) => `deciship.${s}`;
const owner = { isOwner: true, permissions: [] };
/** Firma yöneticisi, DeciShip rolü Denetleyici (ayar ve itiraz izni yok). */
const AUDITOR_PERMS = ['web.access', 'tariffs.view', 'tariffs.edit', 'invoices.upload', 'lines.decide', 'invoices.view', 'reports.view', 'data.export', 'measurements.capture', 'measurements.view_all', 'measurements.manage', 'prices.view'].map(D);
const admin = { isOwner: false, permissions: AUDITOR_PERMS };

function product(viewerId = 'm1') {
  const db = createMockSeed();
  const viewer = db.memberships.find((m) => m.id === viewerId);
  return rolesResponse(db, viewer, 'tr').products.find((p) => p.key === 'deciship');
}
const none = new Set();
const row = (rows, key) => rows.find((r) => r.key === key);

describe('bağımlılık kendiliğinden işaretlenir', () => {
  test('"Faturaları görme" seçilince "Fiyatları görme" de işaretli, soluk ve kaldırılamaz', () => {
    const p = product();
    const chosen = togglePermission(p, owner, [], none, false, D('invoices.view'));
    assert.deepEqual(chosen, [D('invoices.view')]);
    assert.deepEqual(effectivePermissions(p, chosen), [D('invoices.view'), D('prices.view')]);
    const rows = permissionRows(p, owner, chosen, none, false);
    const price = row(rows, D('prices.view'));
    assert.equal(price.checked, true);
    assert.deepEqual(price.neededBy, [D('invoices.view')]);
    assert.equal(price.disabled, true);
    // Soluk satıra tıklamak bir şey değiştirmez.
    assert.deepEqual(togglePermission(p, owner, chosen, none, false, D('prices.view')), chosen);
  });

  test('gerektiren kaldırılınca kendiliğinden eklenen de gider; elle seçilen kalır', () => {
    const p = product();
    let chosen = togglePermission(p, owner, [], none, false, D('lines.decide'));
    assert.deepEqual(effectivePermissions(p, chosen), [D('web.access'), D('lines.decide'), D('invoices.view'), D('prices.view')]);
    chosen = togglePermission(p, owner, chosen, none, false, D('lines.decide'));
    assert.deepEqual(effectivePermissions(p, chosen), []);
    chosen = togglePermission(p, owner, [D('prices.view')], none, false, D('invoices.view'));
    chosen = togglePermission(p, owner, chosen, none, false, D('invoices.view'));
    assert.deepEqual(effectivePermissions(p, chosen), [D('prices.view')]);
  });

  test('geçişli gereklilik: "Tarifeleri düzenleme" → tarife görme → web ve fiyat', () => {
    const p = product();
    const rows = permissionRows(p, owner, [D('tariffs.edit')], none, false);
    for (const k of ['tariffs.view', 'web.access', 'prices.view']) assert.ok(row(rows, D(k)).neededBy.includes(D('tariffs.edit')), k);
    assert.equal(row(rows, D('tariffs.edit')).disabled, false);
  });
});

describe('sahibe özel izin ve yetki yükseltme', () => {
  test('firma yöneticisi için "Ayarları yönetme" kapalı ve nedeni sahibe özel', () => {
    const p = product('m2');
    const rows = permissionRows(p, admin, [], none, false);
    const s = row(rows, D('settings.manage'));
    assert.equal(s.disabled, true);
    assert.deepEqual(s.block, { reason: 'owner_only' });
    assert.deepEqual(togglePermission(p, admin, [], none, false, D('settings.manage')), []);
    // Sahip için açık.
    assert.equal(row(permissionRows(p, owner, [], none, false), D('settings.manage')).disabled, false);
  });

  test('yönetici kendinde olmayan izni ekleyemez; rolde zaten olanı koruyabilir', () => {
    const p = product('m2');
    assert.deepEqual(permissionBlock(p, admin, none, D('disputes.manage'), false), { reason: 'escalation' });
    assert.equal(permissionBlock(p, admin, new Set([D('disputes.manage')]), D('disputes.manage'), false), undefined);
  });

  test('şablondan başlarken yöneticide olmayan ve sahibe özel izin düşer', () => {
    const p = product('m2');
    const fromAdmin = templatePermissions(p, admin, p.roles.find((r) => r.key === 'ADMIN').permissions);
    assert.deepEqual(fromAdmin.dropped, [D('settings.manage'), D('disputes.manage')]);
    assert.ok(!fromAdmin.chosen.includes(D('settings.manage')));
    assert.deepEqual(templatePermissions(p, owner, p.roles.find((r) => r.key === 'ADMIN').permissions).dropped, []);
  });

  test('kilitli rol (sahip rolü): bütün yetkiler kapalı ve dokunulmaz', () => {
    const p = product();
    const r = p.roles.find((x) => x.key === 'ADMIN');
    assert.equal(r.permissionsLocked, true);
    const rows = permissionRows(p, owner, r.permissions, new Set(r.permissions), true);
    assert.ok(rows.every((x) => x.disabled));
    assert.deepEqual(togglePermission(p, owner, r.permissions, new Set(r.permissions), true, D('prices.view')), r.permissions);
  });
});

describe('ad, kopya, yükseltme', () => {
  test('ad boş, uzun ya da çakışan olamaz (büyük/küçük harf fark etmez); kendi adı çakışma sayılmaz', () => {
    const p = product();
    assert.equal(roleNameIssue(p, '  '), 'required');
    assert.equal(roleNameIssue(p, 'x'.repeat(41)), 'tooLong');
    assert.equal(roleNameIssue(p, ' muhasebe '), 'taken');
    assert.equal(roleNameIssue(p, 'Muhasebe', 'ACCOUNTING'), null);
    assert.equal(roleNameIssue(p, 'Depo şefi'), null);
  });

  test('kopya adı sınıra sığar ve çakışınca sayı alır', () => {
    const p = product();
    const pattern = (n) => `${n} kopyası`;
    assert.equal(copyName(p, pattern, 'Ölçüm'), 'Ölçüm kopyası');
    const long = copyName(p, pattern, 'Ç'.repeat(60));
    assert.ok(long.length <= 40 && long.endsWith(' kopyası'));
    const withCopy = { ...p, roles: [...p.roles, { ...p.roles[0], key: 'custom:x', name: 'Ölçüm kopyası' }] };
    assert.equal(copyName(withCopy, pattern, 'Ölçüm'), 'Ölçüm kopyası 2');
  });

  test('rol adı yanıttan; yanıtta yoksa katalog adı (eski ya da gizli rol)', () => {
    const p = { ...product(), roles: product().roles.filter((r) => r.key !== 'MEASURE') };
    assert.equal(roleName(p, 'ACCOUNTING', 'tr'), 'Muhasebe');
    assert.equal(roleName(p, 'MEASURE', 'tr'), 'Ölçüm');
    assert.equal(roleName(p, 'custom:yok', 'tr'), undefined);
    assert.equal(isUpgrade(p, 'ACCOUNTING', 'ADMIN'), true);
    assert.equal(isUpgrade(p, 'ADMIN', 'ACCOUNTING'), false);
  });

  test('katalog yedeği yanıtla aynı şekilde (izinler, gruplar, kilit)', () => {
    const fallback = catalogRolesProduct('deciship', 'tr');
    const real = product();
    assert.deepEqual(fallback.permissions, real.permissions);
    assert.deepEqual(fallback.groups, real.groups);
    assert.deepEqual(
      fallback.roles.map((r) => [r.key, r.name, r.permissionsLocked]),
      real.roles.map((r) => [r.key, r.name, r.permissionsLocked]),
    );
  });
});

describe('silerken taşıma', () => {
  test('hedefler silinen dışındaki görünen roller; yöneticiye sahibe özel izinli rol kapalı', () => {
    const p = product('m2');
    const t = reassignTargets(p, 'AUDITOR', admin);
    assert.deepEqual(t.map((x) => x.key), ['ADMIN', 'ACCOUNTING', 'MEASURE']);
    assert.equal(t.find((x) => x.key === 'ADMIN').disabled, true);
    assert.equal(reassignTargets(p, 'AUDITOR', owner).find((x) => x.key === 'ADMIN').disabled, false);
  });

  test('önseçim davet varsayılanı; o silinen rolse en az yetkili seçilebilir rol (sahip rolü değil)', () => {
    const p = product();
    assert.equal(defaultReassign(p, 'ACCOUNTING', owner), 'MEASURE');
    assert.equal(defaultReassign(p, 'MEASURE', owner), 'ACCOUNTING');
    assert.equal(defaultReassign(p, 'MEASURE', admin), 'ACCOUNTING');
    const only = { ...p, roles: p.roles.filter((r) => r.key === 'ADMIN' || r.key === 'MEASURE') };
    assert.equal(defaultReassign(only, 'MEASURE', admin), null);
    assert.equal(defaultReassign(only, 'MEASURE', owner), 'ADMIN');
  });
});

describe('hata türleri ve adresler', () => {
  test('sözleşmenin hata kodları ayrıntısıyla okunur', () => {
    assert.deepEqual(roleErrorOf({ code: 'ROLE_IN_USE', details: { members: 3, invites: 1 } }), { kind: 'in_use', members: 3, invites: 1 });
    assert.deepEqual(roleErrorOf({ code: 'ROLE_FORBIDDEN', details: { reason: 'owner_only', permissions: [D('settings.manage')] } }), { kind: 'forbidden', reason: 'owner_only', permissions: [D('settings.manage')] });
    assert.deepEqual(roleErrorOf({ code: 'ROLE_FORBIDDEN', details: { reason: 'tuhaf' } }), { kind: 'forbidden', reason: null, permissions: [] });
    // KALANLAR 6.11: engel olan yönetici davetleri adıyla (yoksa iletişimiyle) listelenir.
    assert.deepEqual(
      roleErrorOf({
        code: 'ROLE_FORBIDDEN',
        details: {
          reason: 'pending_admin_invites',
          permissions: [D('settings.manage')],
          invitations: [
            { id: 'i1', name: 'Ayşe Yılmaz', contact: '+905321112233' },
            { id: 'i2', name: null, contact: 'ali@ornek.com' },
            { id: 'i3', name: null, contact: null },
            'bozuk',
          ],
        },
      }),
      { kind: 'forbidden', reason: 'pending_admin_invites', permissions: [D('settings.manage')], invitations: ['Ayşe Yılmaz (+905321112233)', 'ali@ornek.com'] },
    );
    assert.deepEqual(roleErrorOf({ code: 'INVALID_ROLE_PERMISSIONS', details: { missing: [{ perm: D('invoices.view'), requires: [D('prices.view')] }], unknown: [] } }).missing, [{ perm: D('invoices.view'), requires: [D('prices.view')] }]);
    for (const [code, kind] of [['ROLE_VERSION', 'version'], ['ROLE_NAME_TAKEN', 'name_taken'], ['ROLE_LIMIT', 'limit'], ['ROLE_LOCKED', 'locked'], ['VALIDATION', 'other']]) assert.equal(roleErrorOf({ code }).kind, kind);
    assert.equal(roleErrorOf(null).kind, 'other');
  });

  test('özel rol /org/roles/:id, hazır rol /org/roles/builtin/:product/:key', () => {
    const id = '0190a6d2-0000-7000-8000-000000000001';
    assert.equal(rolePath('deciship', `custom:${id}`), `/api/account/org/roles/${id}`);
    assert.equal(rolePath('deciship', 'MEASURE'), '/api/account/org/roles/builtin/deciship/MEASURE');
    assert.equal(deleteRolePath('deciship', 'AUDITOR', `custom:${id}`), `/api/account/org/roles/builtin/deciship/AUDITOR?reassignTo=custom%3A${id}`);
    assert.equal(deleteRolePath('deciship', 'AUDITOR', null), '/api/account/org/roles/builtin/deciship/AUDITOR');
    assert.equal(resetRolePath('deciship', 'AUDITOR'), '/api/account/org/roles/builtin/deciship/AUDITOR/reset');
  });
});
