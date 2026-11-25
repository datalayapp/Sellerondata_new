import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  PRODUCT_KEYS,
  PRODUCT_LAUNCHES,
  PRODUCT_REGISTRY,
  PRODUCTS,
  checkRolePermissions,
  closeEntryPermissions,
  defineProduct,
  requiredEntryPermissions,
  hubOwnedProductKeys,
  isProductKey,
  rolePermissions,
  validateRegistry,
  RESERVED_PRODUCT_KEYS,
  webProductKeys,
  type Permission,
  type ProductEntry,
  type ProductKey,
} from '../src/index.ts';

// ---------- Tür düzeyi (yalnız `npm run typecheck` denetler) ----------

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <T extends true>(_: T) => undefined;
assertType<Equal<ProductKey, 'deciship' | 'orderloom' | 'tagpress'>>(true);
assertType<Equal<(typeof PRODUCT_KEYS)['length'], 3>>(true);
assertType<Equal<(typeof PRODUCT_KEYS)[0], 'deciship'>>(true);
// İzinsiz araçlar birleşime bir şey katmaz; şablon türü (`orderloom.${string}`) sızmaz. TagPress izinleri birleşimde.
assertType<Equal<Permission, (`deciship.${string}` | `tagpress.${string}`) & Permission>>(true);
assertType<Equal<Extract<Permission, `orderloom.${string}`>, never>>(true);
assertType<Equal<Extract<Permission, 'tagpress.web.access'>, 'tagpress.web.access'>>(true);
assertType<Equal<Extract<Permission, 'deciship.web.access'>, 'deciship.web.access'>>(true);
// @ts-expect-error izin listesinde olmayan anahtar
const _notAPermission: Permission = 'deciship.yok.boyle';
void _notAPermission;

const BASE = {
  name: 'Örnek Araç',
  tagline: { tr: 'Deneme', en: 'Sample' },
  color: '#667085',
  launch: 'pilot',
  ownerRole: 'ADMIN',
  inviteRole: 'VIEWER',
} as const;

// Rolde yazım hatası derlemede yakalanır (izin birleşimi yalnız `permissions`'tan çıkar).
defineProduct({
  ...BASE,
  key: 'ornekarac',
  permissions: { 'ornekarac.data.view': { tr: 'Veriyi görme', en: 'View data' } },
  // @ts-expect-error rolde listede olmayan izin
  roles: [{ key: 'ADMIN', label: { tr: 'Yönetici', en: 'Admin' }, description: { tr: '-', en: '-' }, permissions: ['ornekarac.data.vew'] }],
});
defineProduct({
  ...BASE,
  key: 'ornekarac',
  // @ts-expect-error izin anahtar önekli değil
  permissions: { 'baska.data.view': { tr: 'Veriyi görme', en: 'View data' } },
  roles: [],
});

// ---------- Fikstür ----------

const ORNEK = defineProduct({
  key: 'ornekarac',
  name: 'Örnek Araç',
  tagline: { tr: 'Deneme aracı', en: 'Sample tool' },
  color: '#667085',
  launch: 'pilot',
  permissions: {
    'ornekarac.reports.view': { tr: 'Raporları görme', en: 'View reports' },
    'ornekarac.data.view': { tr: 'Veriyi görme', en: 'View data' },
    'ornekarac.data.export': { tr: 'Veriyi dışa aktarma', en: 'Export data' },
    'ornekarac.items.write': { tr: 'Kayıt yazma', en: 'Write items' },
  },
  roles: [
    {
      key: 'ADMIN',
      label: { tr: 'Yönetici', en: 'Admin' },
      description: { tr: 'Her şey.', en: 'Everything.' },
      permissions: ['ornekarac.reports.view', 'ornekarac.data.view', 'ornekarac.data.export', 'ornekarac.items.write'],
    },
    { key: 'VIEWER', label: { tr: 'İzleyici', en: 'Viewer' }, description: { tr: 'Okur.', en: 'Reads.' }, permissions: ['ornekarac.reports.view', 'ornekarac.data.view'] },
  ],
  permissionRequires: {
    'ornekarac.data.export': ['ornekarac.data.view'],
    'ornekarac.items.write': ['ornekarac.data.export'],
  },
  permissionGroups: [
    { key: 'reports', label: { tr: 'Rapor', en: 'Reports' }, permissions: ['ornekarac.reports.view'] },
    { key: 'data', label: { tr: 'Veri', en: 'Data' }, permissions: ['ornekarac.data.view', 'ornekarac.data.export', 'ornekarac.items.write'] },
  ],
  lockedRoles: ['ADMIN'],
  ownerOnlyPermissions: ['ornekarac.items.write'],
  ownerRole: 'ADMIN',
  inviteRole: 'VIEWER',
  hub: { analytics: 'ornekarac.reports.view', data: 'ornekarac.data.view', export: 'ornekarac.data.export' },
  deploy: { api: { service: 'ornekarac-api', port: 4900 } },
});

// Bağımlılık, küme ve sahibe özel izin de yalnız listedeki izinleri anar (derlemede).
defineProduct({
  ...BASE,
  key: 'ornekarac',
  permissions: { 'ornekarac.data.view': { tr: 'Veriyi görme', en: 'View data' } },
  roles: [],
  // @ts-expect-error bağımlılıkta listede olmayan izin
  permissionRequires: { 'ornekarac.data.view': ['ornekarac.data.vew'] },
  // @ts-expect-error sahibe özel izin listede yok
  ownerOnlyPermissions: ['ornekarac.yok'],
});

/** Geçerli fikstürün bir alanını bozar; tür denetimini bilerek atlar (çalışırken denetimi sınanır). */
function broken(patch: Record<string, unknown>): ProductEntry {
  return { ...ORNEK, ...patch } as unknown as ProductEntry;
}

function errorsOf(entries: readonly ProductEntry[]): string[] {
  return validateRegistry(entries);
}

// ---------- Çalışırken ----------

test('uretim kaydi gecerli', () => {
  assert.deepEqual(validateRegistry(PRODUCT_REGISTRY), []);
});

test('ornek fikstur gecerli ve uretim kaydiyla birlikte de gecerli', () => {
  assert.deepEqual(errorsOf([ORNEK]), []);
  assert.deepEqual(errorsOf([...PRODUCT_REGISTRY, ORNEK]), []);
});

test('kayit sirasi PRODUCT_KEYS ve PRODUCTS ile ayni', () => {
  assert.deepEqual([...PRODUCT_KEYS], PRODUCT_REGISTRY.map((e) => e.key));
  assert.deepEqual(Object.keys(PRODUCTS), [...PRODUCT_KEYS]);
  for (const e of PRODUCT_REGISTRY) {
    assert.equal(PRODUCTS[e.key].launch, e.launch);
    assert.equal(PRODUCTS[e.key].name, e.name);
  }
});

test('durum listesi', () => {
  assert.deepEqual([...PRODUCT_LAUNCHES], ['off', 'pilot', 'public']);
  assert.equal(PRODUCTS.deciship.launch, 'public');
});

test('ayrilmis anahtarlar reddedilir; Merkez yollariyla uyumlu', () => {
  for (const key of RESERVED_PRODUCT_KEYS) {
    assert.ok(errorsOf([broken({ key, permissions: {}, roles: [], ownerRole: null, inviteRole: null, hub: undefined, launch: 'off' })]).some((m) => m.includes('ayrılmış')), key);
  }
  for (const key of ['hub', 'account', 'invite', 'internal', 'healthz', 'assets', 'api']) assert.ok(RESERVED_PRODUCT_KEYS.includes(key), key);
  const nav = readFileSync(new URL('../../../apps/hub-web/src/lib/nav.ts', import.meta.url), 'utf8');
  const own = /HUB_OWN_PATHS = \[([^\]]*)\]/.exec(nav)?.[1]?.match(/'([^']+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  assert.ok(own.length > 0);
  for (const p of own) assert.ok(RESERVED_PRODUCT_KEYS.includes(p), `hub-web yolu ayrılmış değil: ${p}`);
});

test('anahtar bicimi ve tekilligi', () => {
  for (const key of ['ab', 'Abc', '1abc', 'ornek-arac', 'ornek_arac', 'a'.repeat(21)]) {
    assert.ok(errorsOf([broken({ key, permissions: {}, roles: [], ownerRole: null, inviteRole: null, hub: undefined, launch: 'off' })]).some((m) => m.includes('anahtar')), key);
  }
  assert.ok(errorsOf([ORNEK, ORNEK]).some((m) => m.includes('tekil değil')));
});

test('izin oneki, etiket ve rol izinleri', () => {
  assert.ok(errorsOf([broken({ permissions: { ...ORNEK.permissions, 'baska.x': { tr: 'x', en: 'x' } } })]).some((m) => m.includes('önekli değil')));
  assert.ok(errorsOf([broken({ permissions: { ...ORNEK.permissions, 'ornekarac.': { tr: 'x', en: 'x' } } })]).some((m) => m.includes('önekli değil')));
  assert.ok(errorsOf([broken({ permissions: { ...ORNEK.permissions, 'ornekarac.x': { tr: '', en: 'x' } } })]).some((m) => m.includes('etiketi eksik')));
  const roles = [{ ...ORNEK.roles[0]!, permissions: ['ornekarac.yok'] }];
  assert.ok(errorsOf([broken({ roles })]).some((m) => m.includes('listede olmayan izin')));
  assert.ok(errorsOf([broken({ roles: [ORNEK.roles[0]!, ORNEK.roles[0]!] })]).some((m) => m.includes('rol tekil değil')));
  assert.ok(errorsOf([broken({ roles: [{ ...ORNEK.roles[0]!, key: 'admin' }], ownerRole: null, inviteRole: null })]).some((m) => m.includes('rol anahtarı')));
});

test('sahip ve davet rolu rollerde', () => {
  assert.ok(errorsOf([broken({ ownerRole: 'YOK' })]).some((m) => m.includes('sahip rolü')));
  assert.ok(errorsOf([broken({ inviteRole: 'YOK' })]).some((m) => m.includes('davet rolü')));
});

test('webAccess ve hub izinleri listede; deploy.web webAccess ister', () => {
  assert.ok(errorsOf([broken({ webAccess: 'ornekarac.web.access' })]).some((m) => m.includes('web giriş izni')));
  assert.ok(errorsOf([broken({ hub: { ...ORNEK.hub, export: 'ornekarac.yok' } })]).some((m) => m.includes('Merkez izni')));
  assert.ok(errorsOf([broken({ deploy: { ...ORNEK.deploy, web: { service: 'ornekarac-web', port: 80 } } })]).some((m) => m.includes('webAccess yok')));
});

test('acik aracta rol, sahip rolu ve deploy.api zorunlu; kapali aracta degil', () => {
  for (const launch of ['pilot', 'public'] as const) {
    assert.ok(errorsOf([broken({ launch, roles: [], ownerRole: null, inviteRole: null })]).some((m) => m.includes('rol yok')), launch);
    assert.ok(errorsOf([broken({ launch, ownerRole: null })]).some((m) => m.includes('sahip rolü yok')), launch);
    assert.ok(errorsOf([broken({ launch, deploy: undefined })]).some((m) => m.includes('deploy.api yok')), launch);
  }
  // Rolsüz fikstürde kilitli rol de yok (kilitli rol var olan rolü anmalı).
  assert.deepEqual(errorsOf([broken({ launch: 'off', roles: [], ownerRole: null, inviteRole: null, lockedRoles: undefined, hub: undefined, deploy: undefined })]), []);
  assert.ok(errorsOf([broken({ launch: 'beta' })]).some((m) => m.includes('bilinmeyen durum')));
});

test('servis, port, sure, renk, site, isaret ve mobil bicimi', () => {
  const api = ORNEK.deploy?.api;
  assert.ok(api);
  assert.ok(errorsOf([broken({ deploy: { api: { ...api, service: 'Ornek_API' } } })]).some((m) => m.includes('service')));
  assert.ok(errorsOf([broken({ deploy: { api: { ...api, port: 4900.5 } } })]).some((m) => m.includes('port')));
  assert.ok(errorsOf([broken({ deploy: { api: { ...api, port: 0 } } })]).some((m) => m.includes('port')));
  assert.ok(errorsOf([broken({ deploy: { api: { ...api, dev: 70000 } } })]).some((m) => m.includes('dev')));
  assert.ok(errorsOf([broken({ deploy: { api: { ...api, maxBody: '50mb' } } })]).some((m) => m.includes('maxBody')));
  assert.ok(errorsOf([broken({ deploy: { api: { ...api, readTimeout: '0s' } } })]).some((m) => m.includes('readTimeout')));
  assert.ok(errorsOf([broken({ color: 'gray' })]).some((m) => m.includes('renk')));
  assert.ok(errorsOf([broken({ color: '#66708' })]).some((m) => m.includes('renk')));
  assert.ok(errorsOf([broken({ site: { tr: 'urunler/x/', en: '/en/x/' } })]).some((m) => m.includes('site.tr')));
  assert.ok(errorsOf([broken({ mark: '../x.svg' })]).some((m) => m.includes('işaret')));
  assert.ok(errorsOf([broken({ mobile: { entry: 'x' } })]).some((m) => m.includes('mobile.entry')));
  assert.ok(errorsOf([broken({ tagline: { tr: 'x', en: ' ' } })]).some((m) => m.includes('slogan')));
});

test('izin bagimliligi yalniz listedeki izinleri anar, izin kendini gerektiremez', () => {
  const req = ORNEK.permissionRequires;
  assert.ok(errorsOf([broken({ permissionRequires: { ...req, 'ornekarac.yok': ['ornekarac.data.view'] } })]).some((m) => m.includes('bağımlılığı yazılan izin listede yok')));
  assert.ok(errorsOf([broken({ permissionRequires: { ...req, 'ornekarac.reports.view': ['ornekarac.yok'] } })]).some((m) => m.includes('gereksinimi listede yok')));
  assert.ok(errorsOf([broken({ permissionRequires: { ...req, 'ornekarac.reports.view': ['ornekarac.reports.view'] } })]).some((m) => m.includes('kendini gerektiriyor')));
});

test('hazir rol bagimliligi karsilamiyorsa hata; rol kendiliginden degismez', () => {
  // VIEWER'a data.export verilir ama data.view gereksinimi kaldırılır: geçişli eksik de söylenir.
  const viewer = { ...ORNEK.roles[1]!, permissions: ['ornekarac.reports.view', 'ornekarac.items.write'] };
  const entry = broken({ roles: [ORNEK.roles[0]!, viewer] });
  const errs = errorsOf([entry]);
  assert.ok(errs.some((m) => m.includes('VIEWER rolü bağımlılığı karşılamıyor: ornekarac.items.write → ornekarac.data.view, ornekarac.data.export')), errs.join('\n'));
  assert.deepEqual([...entry.roles[1]!.permissions], ['ornekarac.reports.view', 'ornekarac.items.write']);
});

test('kilitli roller ve sahibe ozel izinler', () => {
  assert.ok(errorsOf([broken({ lockedRoles: ['ADMIN', 'YOK'] })]).some((m) => m.includes('kilitli rol rollerde yok: YOK')));
  assert.ok(errorsOf([broken({ lockedRoles: ['VIEWER'] })]).some((m) => m.includes('sahip rolü kilitli rollerde yok')));
  // `lockedRoles` yazılmazsa sahip rolü yine kilitlidir (catalog `isRolePermissionsLocked`): hata değil.
  assert.deepEqual(errorsOf([broken({ lockedRoles: undefined })]), []);
  assert.ok(errorsOf([broken({ ownerOnlyPermissions: ['ornekarac.yok'] })]).some((m) => m.includes('sahibe özel izin listede yok')));
});

test('izin kumeleri: bicim, tekillik, etiket ve her izin tam bir kumede', () => {
  const [g1, g2] = ORNEK.permissionGroups ?? [];
  assert.ok(g1 && g2);
  const has = (groups: unknown, text: string) => errorsOf([broken({ permissionGroups: groups })]).some((m) => m.includes(text));
  assert.ok(has([{ ...g1, key: 'Rapor' }, g2], 'izin kümesi anahtarı'));
  assert.ok(has([g1, { ...g2, key: g1.key }], 'izin kümesi tekil değil'));
  assert.ok(has([{ ...g1, label: { tr: 'Rapor', en: ' ' } }, g2], 'izin kümesi etiketi eksik'));
  assert.ok(has([g1, g2, { key: 'bos', label: { tr: 'Boş', en: 'Empty' }, permissions: [] }], 'izin kümesi boş'));
  assert.ok(has([g1, { ...g2, permissions: [...g2.permissions, 'ornekarac.yok'] }], 'listede olmayan izin: ornekarac.yok'));
  assert.ok(has([{ ...g1, permissions: [...g1.permissions, 'ornekarac.data.view'] }, g2], 'izin birden çok kümede: ornekarac.data.view'));
  assert.ok(has([g2], 'izin hiçbir kümede değil: ornekarac.reports.view'));
  // İzni olan açık araçta küme zorunlu; kapalı araçta değil.
  assert.ok(has(undefined, 'permissionGroups yok'));
  assert.deepEqual(errorsOf([broken({ launch: 'off', permissionGroups: undefined })]), []);
});

test('closeEntryPermissions ve checkRolePermissions (fikstur)', () => {
  assert.deepEqual(closeEntryPermissions(ORNEK, ['ornekarac.items.write']), ['ornekarac.data.view', 'ornekarac.data.export', 'ornekarac.items.write']);
  assert.deepEqual(closeEntryPermissions(ORNEK, ['ornekarac.yok', 'ornekarac.reports.view', 'ornekarac.reports.view']), ['ornekarac.reports.view']);
  assert.deepEqual(closeEntryPermissions(ORNEK, []), []);
  assert.deepEqual(requiredEntryPermissions(ORNEK, 'ornekarac.items.write'), ['ornekarac.data.view', 'ornekarac.data.export']);
  assert.deepEqual(requiredEntryPermissions(ORNEK, 'ornekarac.yok'), []);
  assert.deepEqual(checkRolePermissions(ORNEK, ['ornekarac.reports.view']), { ok: true });
  assert.deepEqual(checkRolePermissions(ORNEK, ['ornekarac.items.write', 'ornekarac.data.view', 'ornekarac.yok', 'ornekarac.yok']), {
    ok: false,
    missing: [{ perm: 'ornekarac.items.write', requires: ['ornekarac.data.export'] }],
    unknown: ['ornekarac.yok'],
  });
  // Döngülü bağımlılık sonsuz döngüye girmez (kayıt döngüyü yasaklamaz; kapanış ikisini de verir).
  const loop = { permissions: { 'x.a': 1, 'x.b': 1 }, permissionRequires: { 'x.a': ['x.b'], 'x.b': ['x.a'] } };
  assert.deepEqual(closeEntryPermissions(loop, ['x.a']), ['x.a', 'x.b']);
  assert.deepEqual(checkRolePermissions(loop, ['x.b']), { ok: false, missing: [{ perm: 'x.b', requires: ['x.a'] }], unknown: [] });
});

test('rolePermissions: bilinen rol, bilinmeyen ve bos rol', () => {
  assert.deepEqual([...rolePermissions(ORNEK, 'VIEWER')], ['ornekarac.reports.view', 'ornekarac.data.view']);
  assert.deepEqual([...rolePermissions(ORNEK, 'YOK')], []);
  assert.deepEqual([...rolePermissions(ORNEK, null)], []);
  assert.deepEqual([...rolePermissions(ORNEK, undefined)], []);
  assert.deepEqual([...rolePermissions(ORNEK, '')], []);
  assert.deepEqual([...rolePermissions(PRODUCTS.deciship, 'MEASURE')], ['deciship.measurements.capture']);
});

test('isProductKey', () => {
  for (const k of PRODUCT_KEYS) assert.equal(isProductKey(k), true);
  for (const v of ['ornekarac', '', 'DECISHIP', 'toString', '__proto__', null, undefined, 3]) assert.equal(isProductKey(v), false, String(v));
});

test('Merkez yollari ile web araclari birbirinin tumleyeni', () => {
  const web = webProductKeys();
  const hub = hubOwnedProductKeys();
  assert.deepEqual(web, ['deciship', 'tagpress']);
  assert.deepEqual(hub, ['orderloom']);
  assert.deepEqual([...web, ...hub].sort(), [...PRODUCT_KEYS].sort());
  assert.equal(web.filter((k) => hub.includes(k)).length, 0);
});

test('DeciShip dagitim, site ve mobil alanlari', () => {
  const d = PRODUCTS.deciship;
  assert.deepEqual(d.deploy, {
    api: { service: 'deciship-api', port: 4000, maxBody: '50m', bodyTimeout: '120s', readTimeout: '240s', dev: 4000 },
    web: { service: 'deciship-web', port: 80, dev: 5173 },
  });
  assert.deepEqual(d.site, { tr: '/urunler/deciship/', en: '/en/products/deciship/' });
  assert.deepEqual(d.mobile, { entry: '/deciship/today' });
  assert.equal(d.mark, 'deciship-mark.svg');
  for (const k of ['orderloom', 'tagpress'] as const) {
    assert.equal(PRODUCTS[k].mark, `${k}-mark.svg`);
    assert.deepEqual(PRODUCTS[k].site, { tr: `/urunler/${k}/`, en: `/en/products/${k}/` });
  }
  assert.equal(PRODUCTS.orderloom.deploy, undefined);
  assert.equal(PRODUCTS.orderloom.webAccess, undefined);
  assert.deepEqual(PRODUCTS.tagpress.deploy, {
    api: { service: 'tagpress-api', port: 4200, maxBody: '50m', bodyTimeout: '120s', readTimeout: '300s', dev: 5422 },
    web: { service: 'tagpress-web', port: 80, dev: 5423 },
  });
  assert.equal(PRODUCTS.tagpress.webAccess, 'tagpress.web.access');
  assert.equal(PRODUCTS.tagpress.mobile, undefined);
});
