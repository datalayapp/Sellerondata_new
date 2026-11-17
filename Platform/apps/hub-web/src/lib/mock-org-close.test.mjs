// Sahte Hesap servisinde firmayı kapatma ve geri açma (mocks/orgClose.ts) sözleşmeye uyar: yalnız sahip, ad + şifre, kapalı firma
// yalnız sahibin /me listesinde ve etkin olamaz, hatalar koda göre (contracts tokens.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockSeed, MOCK_PASSWORD } from '@sellerondata/shell/mock-seed';
import { closeOrg, firstOpenMembership, isOrgOpen, meOrgs, orgState, reopenOrg } from '../mocks/orgClose.ts';

const NOW = Date.parse('2026-11-13T09:00:00Z');
const DAY = 86_400_000;
const setup = () => {
  const db = createMockSeed();
  const person = (id) => db.persons.find((p) => p.id === id);
  const m = (id) => db.memberships.find((x) => x.id === id);
  // p1 Selin: o1 sahibi (m1), o2 yöneticisi (m9). p2 Elif: o1 yöneticisi (m2). p9: o3 sahibi (m10), başka firması yok.
  return { db, person, m };
};
const code = (r) => r.error?.code;
const close = (db, person, membership, name = 'Örnek Firma', password = MOCK_PASSWORD, now = NOW) => closeOrg(db, person, membership, { confirmName: name, password }, now);

describe('POST /org/close', () => {
  test('yalnız sahip: yönetici 403 FORBIDDEN, firmasız 403 ORG_REQUIRED', () => {
    const { db, person, m } = setup();
    assert.deepEqual([close(db, person('p2'), m('m2')).status, code(close(db, person('p2'), m('m2')))], [403, 'FORBIDDEN']);
    assert.equal(code(close(db, person('p10'), null)), 'ORG_REQUIRED');
    assert.equal(orgState(db.orgs.find((o) => o.id === 'o1'), NOW), 'ACTIVE');
  });

  test('yanlış ad 400 CONFIRM_NAME_MISMATCH, yanlış şifre 401 INVALID_CREDENTIALS, firma açık kalır', () => {
    const { db, person, m } = setup();
    const a = close(db, person('p1'), m('m1'), 'Örnek');
    assert.deepEqual([a.status, code(a)], [400, 'CONFIRM_NAME_MISMATCH']);
    const b = close(db, person('p1'), m('m1'), 'Örnek Firma', 'yanlis');
    assert.deepEqual([b.status, code(b)], [401, 'INVALID_CREDENTIALS']);
    assert.equal(isOrgOpen(db, 'o1', NOW), true);
    assert.equal(db.audit.some((x) => x.action === 'org.closed'), false);
  });

  test('başarı: anlar yazılır, sahip başka açık firmasına geçer, denetim izi, ikinci kapatma 409 ORG_CLOSED', () => {
    const { db, person, m } = setup();
    const r = close(db, person('p1'), m('m1'), '  örnek firma ');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { expiresIn: 600, activeOrgId: 'o2', closedAt: new Date(NOW).toISOString(), purgeAfter: new Date(NOW + 30 * DAY).toISOString() });
    const org = db.orgs.find((o) => o.id === 'o1');
    assert.deepEqual([org.closedAt, org.purgeAfter, org.closedById], [new Date(NOW).toISOString(), new Date(NOW + 30 * DAY).toISOString(), 'p1']);
    assert.equal(db.audit[0].action, 'org.closed');
    assert.deepEqual(db.audit[0].details, { closedAt: org.closedAt, purgeAfter: org.purgeAfter, members: 8 });
    assert.equal(code(close(db, person('p1'), m('m1'))), 'ORG_CLOSED');
  });

  test('tek firmalı sahip firmasız kalır (activeOrgId null)', () => {
    const { db, person, m } = setup();
    const r = close(db, person('p9'), m('m10'), 'Yeni Atölye');
    assert.equal(r.body.activeOrgId, null);
    assert.equal(firstOpenMembership(db, 'p9', undefined, NOW), undefined);
  });
});

describe('/me ve etkin firma', () => {
  test('kapalı firma yalnız sahibin listesinde (orgStatus, closedAt, purgeAfter, timeZone); üyelerde hiç yok; açık firma eski şekliyle (alan yok)', () => {
    const { db, person, m } = setup();
    close(db, person('p1'), m('m1'));
    const owner = meOrgs(db, 'p1', NOW);
    assert.deepEqual(
      owner.map((o) => [o.id, o.orgStatus]),
      [['o1', 'CLOSED'], ['o2', undefined]],
    );
    const c = owner.find((o) => o.id === 'o1');
    assert.deepEqual(Object.keys(c).sort(), ['closedAt', 'id', 'name', 'orgRole', 'orgStatus', 'purgeAfter', 'status', 'timeZone']);
    // Hesap gibi: firmanın kendi saat dilimi, kaydı yoksa varsayılan.
    assert.equal(c.timeZone, 'Europe/Istanbul');
    db.orgs.find((o) => o.id === 'o1').timeZone = 'Europe/London';
    assert.equal(meOrgs(db, 'p1', NOW).find((o) => o.id === 'o1').timeZone, 'Europe/London');
    assert.equal(c.purgeAfter, new Date(NOW + 30 * DAY).toISOString());
    assert.deepEqual(Object.keys(owner.find((o) => o.id === 'o2')).sort(), ['id', 'name', 'orgRole', 'status']);
    assert.deepEqual(meOrgs(db, 'p2', NOW), []);
    assert.deepEqual(meOrgs(db, 'p7', NOW).map((o) => o.id), ['o2']);
  });

  test('kapalı firma etkin olamaz: girişte ve firma seçiminde atlanır', () => {
    const { db, person, m } = setup();
    close(db, person('p1'), m('m1'));
    assert.equal(isOrgOpen(db, 'o1', NOW), false);
    assert.equal(firstOpenMembership(db, 'p1', undefined, NOW).orgId, 'o2');
    assert.equal(firstOpenMembership(db, 'p2', undefined, NOW), undefined);
  });

  test('saklama süresi dolunca kimsenin listesinde yok, durum PURGED', () => {
    const { db, person, m } = setup();
    close(db, person('p1'), m('m1'));
    const later = NOW + 30 * DAY;
    assert.equal(orgState(db.orgs.find((o) => o.id === 'o1'), later), 'PURGED');
    assert.deepEqual(meOrgs(db, 'p1', later).map((o) => o.id), ['o2']);
  });
});

describe('POST /org/reopen', () => {
  const reopen = (db, person, orgId, password = MOCK_PASSWORD, now = NOW + DAY) => reopenOrg(db, person, { orgId, password }, now);

  test('yanlış şifre 401; sahip olmayan ve bilinmeyen firma 404 ORG_NOT_FOUND; açık firma 409 CONFLICT', () => {
    const { db, person, m } = setup();
    close(db, person('p1'), m('m1'));
    assert.deepEqual([reopen(db, person('p1'), 'o1', 'yanlis').status, code(reopen(db, person('p1'), 'o1', 'yanlis'))], [401, 'INVALID_CREDENTIALS']);
    assert.equal(code(reopen(db, person('p2'), 'o1')), 'ORG_NOT_FOUND');
    assert.equal(code(reopen(db, person('p1'), 'yok')), 'ORG_NOT_FOUND');
    const c = reopen(db, person('p1'), 'o2');
    assert.equal(code(c), 'ORG_NOT_FOUND'); // o2'de yönetici, sahip değil
    assert.deepEqual([reopen(db, person('p9'), 'o3').status, code(reopen(db, person('p9'), 'o3'))], [409, 'CONFLICT']);
  });

  test('süre dolmuş 410 ORG_PURGED', () => {
    const { db, person, m } = setup();
    close(db, person('p1'), m('m1'));
    const r = reopen(db, person('p1'), 'o1', MOCK_PASSWORD, NOW + 30 * DAY);
    assert.deepEqual([r.status, code(r)], [410, 'ORG_PURGED']);
  });

  test('başarı: alanlar boşalır, firma etkin olur, üyelerin erişimi aynen döner, denetim izi', () => {
    const { db, person, m } = setup();
    close(db, person('p1'), m('m1'));
    const r = reopen(db, person('p1'), 'o1');
    assert.deepEqual([r.status, r.body], [200, { expiresIn: 600, activeOrgId: 'o1' }]);
    const org = db.orgs.find((o) => o.id === 'o1');
    assert.deepEqual([org.closedAt, org.purgeAfter, org.closedById], [null, null, null]);
    assert.equal(db.audit[0].action, 'org.reopened');
    assert.deepEqual(meOrgs(db, 'p2', NOW + DAY).map((o) => [o.id, o.orgStatus, o.orgRole]), [['o1', undefined, 'ADMIN']]);
    assert.equal(firstOpenMembership(db, 'p2', undefined, NOW + DAY).orgId, 'o1');
  });
});
