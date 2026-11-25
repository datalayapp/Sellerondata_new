// Arayüz görünürlüğü: kod rol adına değil izne ve aboneliğe bakar (ARCHITECTURE §1, §5).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasPermission, hasWebAccess, holdsPermission, isOrgAdmin, subscriptionWritable } from '../src/lib/permissions.ts';
import type { MeResponse } from '@sellerondata/contracts';

function me(permissions: string[], status: 'ACTIVE' | 'READ_ONLY' | 'CANCELED' | null = 'ACTIVE', orgRole: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER'): MeResponse {
  return {
    person: { id: 'p', name: 'A', email: null, phone: null, locale: 'tr', emailVerified: false },
    orgs: [],
    activeOrg: { id: 'o', name: 'F', country: 'TR', currency: 'TRY', orgRole, membershipId: 'm' },
    products: [{ key: 'deciship', available: true, subscription: status ? { status, plan: 'early_access' } : null, role: 'X', permissions }],
  };
}

describe('izinler', () => {
  it('yalnız listedeki izin geçer; oturum yoksa hiçbiri', () => {
    assert.equal(hasPermission(me(['deciship.invoices.view']), 'deciship.invoices.view'), true);
    assert.equal(hasPermission(me(['deciship.invoices.view']), 'deciship.invoices.upload'), false);
    assert.equal(hasPermission(null, 'deciship.web.access'), false);
  });

  it('abonelik etkin değilse yazma izinleri kapalı, okuma açık', () => {
    for (const status of ['READ_ONLY', 'CANCELED'] as const) {
      const m = me(['deciship.web.access', 'deciship.invoices.view', 'deciship.invoices.upload', 'deciship.data.export'], status);
      assert.equal(subscriptionWritable(m), false);
      assert.equal(hasPermission(m, 'deciship.invoices.upload'), false);
      assert.equal(holdsPermission(m, 'deciship.invoices.upload'), true, 'sayfa açık kalır');
      assert.equal(hasPermission(m, 'deciship.invoices.view'), true);
      assert.equal(hasPermission(m, 'deciship.data.export'), true);
      assert.equal(hasWebAccess(m), true);
    }
  });

  it('firma yönetimi firma rolüne bağlı', () => {
    assert.equal(isOrgAdmin(me([], 'ACTIVE', 'OWNER')), true);
    assert.equal(isOrgAdmin(me([], 'ACTIVE', 'ADMIN')), true);
    assert.equal(isOrgAdmin(me([], 'ACTIVE', 'MEMBER')), false);
    assert.equal(isOrgAdmin(null), false);
  });

  it('kaynak kodda ürün rolü adı geçmez', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const root = new URL('../src/', import.meta.url);
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === 'mocks' || e.name === 'locales' ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    const offenders = walk(root.pathname.replace(/^\/([A-Z]:)/, '$1')).filter((f) => /\.tsx?$/.test(f) && /['"](AUDITOR|ACCOUNTING|MEASURE|WORKER)['"]|\.role\s*===/.test(fs.readFileSync(f, 'utf8')));
    assert.deepEqual(offenders, []);
  });
});
