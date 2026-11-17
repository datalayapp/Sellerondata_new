// Sahte API'nin izin tablosu gerçek API'ninkiyle aynı (10-B16): e2e sahte API'ye karşı koşar; izin ayrışırsa canlıdaki 403 e2e'de görünmez.
// Gerçek tablo `Deciship/apps/api/test/routeRules.ts`. Onun gerçekle aynı kaldığını API'nin izin matrisi testi garanti eder
// (`permissionMatrix.test.ts`, veritabanı işi): Fastify'ın yol listesi = tablo, her rol × her uç gerçek yanıtla sınanır.
// Zincir: Fastify ⇄ routeRules.ts (API, test:db) ⇄ sahte tablo (bu test, veritabanısız).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { permissionsOf, type Permission } from '@sellerondata/contracts';
import { READ_ONLY_EXEMPT, ROLES, ROUTE_RULES, roleAllowed, type RouteRule } from '../../api/test/routeRules.ts';
import { MOCK_READ_ONLY_EXEMPT, MOCK_ROUTE_RULES, mockPermissionCheck, mockRouteOf } from '../src/mocks/account.ts';

/** Panelin çağırabildiği uçlar: herkese açık iki uç (sağlık, olay kancası) panelden çağrılmaz, sahte tabloda yoktur. */
const realKeys = Object.keys(ROUTE_RULES).filter((k) => ROUTE_RULES[k] !== 'public');

/** `:param` yerine örnek kimlik: sahte API'ye gelecek somut yol. */
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, 'p1');
const split = (key: string) => {
  const i = key.indexOf(' ');
  return { method: key.slice(0, i), path: key.slice(i + 1) };
};

/** Karşılaştırma için kuralın düz yazımı (izin sırası önemsiz). */
function show(rule: RouteRule | null | undefined): string {
  if (rule == null) return 'kural yok';
  if (rule === 'public' || rule === 'session') return rule;
  if ('all' in rule) return `hepsi(${[...rule.all].sort().join(', ')})`;
  return `biri(${[...rule].sort().join(', ')})`;
}

/** Panele giren roller: `web.access` olmayan rol (ölçüm) sahte API'de her uçtan NO_PRODUCT_ACCESS alır; gerçekte mobil uçları açıktır. */
const panelRoles = ROLES.filter((role) => permissionsOf('deciship', role).includes('deciship.web.access'));

describe('sahte API izin tablosu = gerçek API izin tablosu', () => {
  it('gerçek her uç sahte API\'de aynı izni ister', () => {
    const wrong: string[] = [];
    for (const key of realKeys) {
      const { method, path } = split(key);
      const mock = mockRouteOf(method, concrete(path))?.rule;
      if (show(mock) !== show(ROUTE_RULES[key])) wrong.push(`${key}: sahte ${show(mock)} → gerçek ${show(ROUTE_RULES[key])}`);
    }
    assert.deepEqual(wrong, []);
  });

  it('somut yol sahte tabloda doğru uca düşer (sabit parça değişkenden önce, Fastify gibi)', () => {
    const wrong: string[] = [];
    for (const key of realKeys) {
      const { method, path } = split(key);
      const got = mockRouteOf(method, concrete(path))?.key ?? null;
      if (got !== key) wrong.push(`${method} ${concrete(path)}: ${got ?? 'eşleşme yok'} (beklenen ${key})`);
    }
    assert.deepEqual(wrong, []);
  });

  it('sahte tabloda gerçekte olmayan uç yok', () => {
    assert.deepEqual(Object.keys(MOCK_ROUTE_RULES).filter((k) => !(k in ROUTE_RULES)), []);
  });

  it('panel rolleri her uçta gerçek API ile aynı geçer ya da 403 alır', () => {
    const wrong: string[] = [];
    for (const role of panelRoles) {
      const held = permissionsOf('deciship', role) as Permission[];
      for (const key of realKeys) {
        const { method, path } = split(key);
        const real = roleAllowed(ROUTE_RULES[key]!, role);
        const mock = mockPermissionCheck(method, concrete(path), held) === null;
        if (real !== mock) wrong.push(`${role} ${key}: sahte ${mock ? 'geçer' : '403'}, gerçek ${real ? 'geçer' : '403'}`);
      }
    }
    assert.ok(panelRoles.length >= 3, 'panel rolleri katalogdan gelmeli');
    assert.deepEqual(wrong, []);
  });

  it('web erişimi olmayan izin kümesi her uçtan NO_PRODUCT_ACCESS alır', () => {
    for (const key of realKeys) {
      const { method, path } = split(key);
      assert.equal(mockPermissionCheck(method, concrete(path), ['deciship.measurements.capture']), 'NO_PRODUCT_ACCESS', key);
    }
  });

  it('salt okunur abonelikte açık kalan yazma uçları aynı', () => {
    assert.deepEqual([...MOCK_READ_ONLY_EXEMPT].sort(), [...READ_ONLY_EXEMPT].sort());
  });

  /**
   * Gerçekte olmayan uca sahte işleyici kırar: panel o ucu çağırırsa e2e geçer, canlıda 404 olur.
   * İşleyicisi olmayan gerçek uç yalnız uyarıdır: gerçek API'nin panelin hiç çağırmadığı uçları var (mobil görüntü uçları,
   * Merkez'in `/platform/*` uçları, dosya indirme); panelin çağırıp sahtesi olmayan uç e2e'de zaten ağ hatasıyla görünür.
   */
  it('işleyici kapsamı: gerçekte olmayan sahte işleyici yok; işleyicisi olmayan gerçek uçlar uyarı', (t) => {
    const handlers = new Set<string>();
    for (const file of ['browser.ts', 'disputes.ts']) {
      const src = readFileSync(new URL(`../src/mocks/${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/http\.(get|post|put|patch|delete)\(\s*['"`]\/api\/deciship(\/[^'"`]*)['"`]/g)) {
        handlers.add(`${m[1]!.toUpperCase()} ${m[2]!.replace(/:[A-Za-z]+/g, ':')}`);
      }
    }
    const norm = (key: string) => key.replace(/:[A-Za-z]+/g, ':');
    const noHandler = realKeys.filter((k) => !handlers.has(norm(k)));
    // Gerçek uca düşmeyen işleyici: canlıda 404 olur. Somut yolu gerçek tabloda ara (ör. `/tariffs/bozuk` → `GET /tariffs/:id`).
    const noReal = [...handlers].filter((h) => {
      const { method, path } = split(h);
      const route = mockRouteOf(method, path.replace(/:/g, 'p1'));
      return !route || !(route.key in ROUTE_RULES);
    });
    t.diagnostic(`sahte işleyicisi olmayan gerçek uçlar (${noHandler.length}): ${noHandler.join(' | ') || '-'}`);
    assert.ok(handlers.size > 50, 'işleyici taraması çalışmalı');
    assert.deepEqual(noReal, [], 'gerçekte karşılığı olmayan sahte işleyiciler');
  });
});
