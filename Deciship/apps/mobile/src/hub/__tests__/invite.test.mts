import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PRODUCTS, type OrgRolesResponse } from '../contracts';
import { defaultInviteRole, initialInviteForm, inviteBody, inviteError, inviteRoleOptions, inviteRoleOptionsFromServer, inviteTools, NAME_MAX_LENGTH, resolveInviteRoles, validateInvite } from '../invite';
import { makeMe } from './fixtures';

test('inviteRoleOptions: katalogdan, yönetici (sahip rolü) yok, en az yetkiliden çoğa', () => {
  assert.deepEqual(
    inviteRoleOptions('deciship', 'tr').map((o) => [o.key, o.label]),
    [
      ['MEASURE', 'Ölçüm'],
      ['ACCOUNTING', 'Muhasebe'],
      ['AUDITOR', 'Denetleyici'],
    ],
  );
  assert.deepEqual(
    inviteRoleOptions('deciship', 'en').map((o) => o.label),
    ['Measurement', 'Accounting', 'Auditor'],
  );
  // Etiket ve açıklama katalogdan gelir, kodda yazılı değil.
  const measure = PRODUCTS.deciship.roles.find((r) => r.key === 'MEASURE')!;
  assert.equal(inviteRoleOptions('deciship', 'tr')[0]!.description, measure.description.tr);
  assert.ok(inviteRoleOptions('deciship', 'tr').every((o) => o.key !== PRODUCTS.deciship.ownerRole));
  // Rolü olmayan araçta seçenek yok.
  assert.deepEqual(inviteRoleOptions('orderloom', 'tr'), []);
});

test('defaultInviteRole: katalogdaki davet rolü (Ölçüm); rol yoksa null', () => {
  assert.equal(defaultInviteRole('deciship'), 'MEASURE');
  assert.equal(defaultInviteRole('orderloom'), null);
});

const roleRow = (key: string, name: string, permissions: string[], extra: Record<string, unknown> = {}) => ({
  key,
  kind: key.startsWith('custom:') ? 'custom' : 'builtin',
  name,
  permissions,
  memberCount: 0,
  inviteCount: 0,
  editable: true,
  permissionsLocked: false,
  deletable: true,
  edited: false,
  version: 0,
  ...extra,
});
const rolesRes = (roles: ReturnType<typeof roleRow>[]) =>
  ({ products: [{ key: 'deciship', groups: [], permissions: [], roles, hiddenBuiltins: [], customRoleLimit: 20 }] }) as unknown as OrgRolesResponse;
const ownerOnlyPerm = PRODUCTS.deciship.ownerOnlyPermissions![0]!;

test('inviteRoleOptionsFromServer: liste yanıttan (özel rol ve yeniden adlandırma dahil), sahip rolü yok, sunucu sırasıyla', () => {
  const res = rolesRes([
    roleRow('ADMIN', 'Yönetici', [ownerOnlyPerm], { permissionsLocked: true }),
    roleRow('MEASURE', 'Ölçümcü', []),
    roleRow('custom:abc', 'Depo', [], { description: 'Depo ekibi' }),
  ]);
  assert.deepEqual(inviteRoleOptionsFromServer(res, 'deciship', 'OWNER'), [
    { key: 'MEASURE', label: 'Ölçümcü', description: '' },
    { key: 'custom:abc', label: 'Depo', description: 'Depo ekibi' },
  ]);
});

test('inviteRoleOptionsFromServer: sahibe özel izinli rol yalnız OWNER için; ADMIN görmez', () => {
  const res = rolesRes([roleRow('MEASURE', 'Ölçüm', []), roleRow('custom:x', 'Ayarcı', [ownerOnlyPerm])]);
  assert.deepEqual(inviteRoleOptionsFromServer(res, 'deciship', 'OWNER')!.map((o) => o.key), ['MEASURE', 'custom:x']);
  assert.deepEqual(inviteRoleOptionsFromServer(res, 'deciship', 'ADMIN')!.map((o) => o.key), ['MEASURE']);
});

test('resolveInviteRoles: yanıt yoksa (404, hata) ya da araç yoksa katalog listesi', () => {
  const catalog = inviteRoleOptions('deciship', 'tr');
  assert.deepEqual(resolveInviteRoles(null, ['deciship'], 'OWNER', 'tr'), { deciship: catalog });
  assert.deepEqual(resolveInviteRoles({ products: [] }, ['deciship'], 'OWNER', 'tr'), { deciship: catalog });
  const res = rolesRes([roleRow('custom:abc', 'Depo', [])]);
  assert.deepEqual(resolveInviteRoles(res, ['deciship'], 'ADMIN', 'tr').deciship!.map((o) => o.key), ['custom:abc']);
});

test('defaultInviteRole: pickInviteRole; Ölçüm gizlenmişse listedeki ilk rol, boşsa null', () => {
  const hidden = resolveInviteRoles(rolesRes([roleRow('custom:abc', 'Depo', []), roleRow('AUDITOR', 'Denetim', [])]), ['deciship'], 'OWNER', 'tr');
  assert.equal(defaultInviteRole('deciship', hidden), 'custom:abc');
  const shown = resolveInviteRoles(rolesRes([roleRow('ACCOUNTING', 'Muhasebe', []), roleRow('MEASURE', 'Ölçüm', [])]), ['deciship'], 'OWNER', 'tr');
  assert.equal(defaultInviteRole('deciship', shown), 'MEASURE');
  assert.equal(defaultInviteRole('deciship', { deciship: [] }), null);
  assert.deepEqual(inviteBody({ ...initialInviteForm(['deciship'], hidden), name: 'A', phone: '1' }, ['deciship'], hidden).productRoles, { deciship: 'custom:abc' });
  assert.deepEqual(inviteBody({ name: 'A', phone: '1', roles: { deciship: 'MEASURE' } }, ['deciship'], hidden).productRoles, { deciship: null });
});

test('inviteTools: yalnız açık, abonelikli ve rol tanımı olan araçlar (web teamProducts)', () => {
  assert.deepEqual(inviteTools(makeMe({ orgRole: 'OWNER' })), ['deciship']);
  assert.deepEqual(inviteTools(makeMe({ orgRole: 'OWNER', subscribed: false })), []);
  assert.deepEqual(inviteTools(null), []);
});

test('validateInvite: ad ve telefon zorunlu; telefon kaba biçim, ad üst sınırı', () => {
  assert.deepEqual(validateInvite({ name: 'Mehmet Kaya', phone: '0532 000 00 00' }), {});
  assert.deepEqual(validateInvite({ name: '  ', phone: '' }), { name: 'required', phone: 'required' });
  assert.deepEqual(validateInvite({ name: 'Mehmet', phone: '12345' }), { phone: 'invalid' });
  assert.deepEqual(validateInvite({ name: 'Mehmet', phone: 'a@b.com' }), { phone: 'invalid' });
  assert.deepEqual(validateInvite({ name: 'x'.repeat(NAME_MAX_LENGTH + 1), phone: '+90 532 000 00 00' }), { name: 'tooLong' });
});

test('inviteBody: telefon + kod, firma rolü hep çalışan, varsayılan Ölçüm; yönetici rolü gönderilmez', () => {
  const tools = inviteTools(makeMe({ orgRole: 'OWNER' }));
  const form = { ...initialInviteForm(tools), name: '  Mehmet Kaya ', phone: ' 0532 000 00 00 ' };
  assert.deepEqual(inviteBody(form, tools), { kind: 'PHONE_CODE', name: 'Mehmet Kaya', phone: '0532 000 00 00', orgRole: 'MEMBER', productRoles: { deciship: 'MEASURE' } });
  assert.deepEqual(inviteBody({ ...form, roles: { deciship: 'AUDITOR' } }, tools).productRoles, { deciship: 'AUDITOR' });
  assert.deepEqual(inviteBody({ ...form, roles: { deciship: 'ADMIN' } }, tools).productRoles, { deciship: null });
  assert.deepEqual(inviteBody({ ...form, roles: {} }, tools).productRoles, { deciship: 'MEASURE' });
  assert.deepEqual(inviteBody({ ...form, roles: { deciship: null } }, tools).productRoles, { deciship: null });
});

test('inviteError: web ile aynı anlam (sınır ve dakika, geçersiz telefon, zaten üye, ağ, yetki, sunucu metni)', () => {
  assert.deepEqual(inviteError({ status: 429, code: 'TOO_MANY_ATTEMPTS', retryAfterMs: 1_800_000 }), { key: 'limitIn', minutes: 30 });
  assert.deepEqual(inviteError({ status: 429, code: 'TOO_MANY_ATTEMPTS', retryAfterMs: 20_000 }), { key: 'limitIn', minutes: 1 });
  assert.deepEqual(inviteError({ status: 429, code: 'TOO_MANY_ATTEMPTS' }), { key: 'limit' });
  assert.deepEqual(inviteError({ status: 400, code: 'VALIDATION', details: [{ path: 'phone', code: 'invalid_phone', message: 'Telefon numarası geçersiz.' }] }), { key: 'phoneInvalid' });
  assert.deepEqual(inviteError({ status: 400, code: 'VALIDATION', details: [{ path: 'name', code: 'name_no_links', message: 'Ad bağlantı içeremez.' }] }), { key: 'server', message: 'Ad bağlantı içeremez.' });
  assert.deepEqual(inviteError({ status: 409, code: 'ALREADY_MEMBER', message: 'Bu kişi zaten firmanın üyesi.' }), { key: 'alreadyMember' });
  assert.deepEqual(inviteError({ status: 0, code: 'NETWORK', message: 'x' }), { key: 'network' });
  assert.deepEqual(inviteError({ status: 0, code: 'TIMEOUT', message: 'x' }), { key: 'network' });
  assert.deepEqual(inviteError({ status: 403, code: 'FORBIDDEN', message: '' }), { key: 'forbidden' });
  assert.deepEqual(inviteError({ status: 409, code: 'ORG_CLOSED', message: 'Firma kapalı.' }), { key: 'server', message: 'Firma kapalı.' });
  assert.deepEqual(inviteError({ status: 500, code: 'HTTP_500', message: '' }), { key: 'server', message: null });
  assert.deepEqual(inviteError(new Error('boom')), { key: 'server', message: null });
  assert.deepEqual(inviteError(null), { key: 'server', message: null });
});
