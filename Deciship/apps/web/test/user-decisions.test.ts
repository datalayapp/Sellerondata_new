// Kullanıcı kararları K2 (yüklemede tarife önseçimi), K3 (kayıtlı eşlemeyi yalnız ayar izni değiştirir), K43 (itiraz
// penceresinde KDV dahil toplam). Sunucu tarafı: apps/api/test/kullaniciKararlari.test.ts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { permissionsOf, type MeResponse } from '@sellerondata/contracts';
import { hasPermission } from '../src/lib/permissions.ts';
import { defaultTariffOf, nextAutoPick, tariffForDate, validOn } from '../src/lib/tariffPick.ts';

const src = (rel: string) => fs.readFileSync(path.resolve(import.meta.dirname, '../src', rel), 'utf8');
const locale = (loc: string, ns: string) => JSON.parse(src(`locales/${loc}/${ns}.json`));

const t = (id: string, o: { isDefault?: boolean; active?: boolean; from?: string; to?: string; updated?: string } = {}) => ({
  id,
  active: o.active ?? true,
  isDefault: o.isDefault ?? false,
  validFrom: o.from ? `${o.from}T00:00:00.000Z` : null,
  validTo: o.to ? `${o.to}T00:00:00.000Z` : null,
  updatedAt: `${o.updated ?? '2026-01-01'}T00:00:00.000Z`,
});

describe('K2: fatura gününde geçerli tarife, yoksa varsayılan (sunucuyla aynı kural)', () => {
  const y2026 = t('2026', { isDefault: true, from: '2026-01-01', to: '2026-12-31' });
  const y2025 = t('2025', { from: '2025-01-01', to: '2025-12-31' });
  const open = t('süresiz', { updated: '2026-06-01' });
  const pasif = t('pasif', { active: false, from: '2024-01-01', to: '2024-12-31' });
  const list = [y2026, y2025, open, pasif];

  it('geçerli olan; birden çoksa varsayılan, sonra dönemli, sonra en yeni', () => {
    assert.equal(tariffForDate(list, '2025-12-15')?.id, '2025');
    assert.equal(tariffForDate(list, '2025-01-01')?.id, '2025'); // ilk gün dahil
    assert.equal(tariffForDate(list, '2026-03-01')?.id, '2026');
    assert.equal(tariffForDate(list, '2024-06-01')?.id, 'süresiz'); // pasif seçilmez
    assert.equal(tariffForDate([t('a', { updated: '2026-01-01' }), t('b', { updated: '2026-02-01' })], '2026-05-01')?.id, 'b');
  });

  it('o gün geçerli tarife yoksa ya da tarih yoksa / bozuksa taşıyıcının varsayılanı', () => {
    assert.equal(tariffForDate([y2026, y2025], '2024-06-01')?.id, '2026');
    assert.equal(tariffForDate(list, '')?.id, '2026');
    assert.equal(tariffForDate(list, undefined)?.id, '2026');
    assert.equal(tariffForDate(list, '15.12.2025')?.id, '2026');
    assert.equal(tariffForDate([pasif], '2024-06-01'), null);
    assert.equal(defaultTariffOf([open, y2025])?.id, 'süresiz'); // varsayılan işaretli yoksa en son güncellenen
    assert.equal(validOn(y2025, '2026-01-01'), false);
  });

  it('önseçim yenileme: boşken önseçilir; kendiliğinden seçilen tarih değişince yenilenir; elle seçim korunur', () => {
    assert.equal(nextAutoPick('', null, '2026'), '2026');
    assert.equal(nextAutoPick('2026', '2026', '2025'), '2025'); // tarih 2025'e çekildi, kişi dokunmamıştı
    assert.equal(nextAutoPick('2026', '2026', '2026'), null); // değişen yok
    assert.equal(nextAutoPick('2026', null, '2025'), null); // elle seçilmiş (ya da kayıtlı fatura): dokunulmaz
    assert.equal(nextAutoPick('x', 'y', '2025'), null);
    assert.equal(nextAutoPick('', null, null), null); // tarifesi yok
  });

  it('seçici fatura tarihini kullanır ve "fatura gününde geçerli" ipucunu TR ve EN verir', () => {
    const code = src('components/TariffSelect.tsx');
    assert.match(code, /tariffForDate\(list, date\)/);
    assert.match(code, /nextAutoPick\(/);
    for (const loc of ['tr', 'en']) assert.ok(locale(loc, 'tariffs').select.dateSelected.includes('{{date}}'), loc);
    // sihirbaz önseçimin kendiliğinden olduğunu adım değişse de bilir
    assert.match(src('pages/invoice-upload/MetaStep.tsx'), /autoPicked=\{tariffAuto\}/);
  });
});

describe('K3: kayıtlı sütun eşlemesi izinle (rol adıyla değil)', () => {
  const me = (permissions: string[]): MeResponse => ({
    person: { id: 'p', name: 'A', email: null, phone: null, locale: 'tr', emailVerified: false },
    orgs: [],
    activeOrg: { id: 'o', name: 'F', country: 'TR', currency: 'TRY', orgRole: 'MEMBER', membershipId: 'm' },
    products: [{ key: 'deciship', available: true, subscription: { status: 'ACTIVE', plan: 'early_access' }, role: 'X', permissions }],
  });

  it('ayar izni olan hatırlar; Muhasebe ve Denetleyici (yükleyebilir ama ayar izni yok) hatırlayamaz', () => {
    assert.equal(hasPermission(me([...permissionsOf('deciship', 'ADMIN')]), 'deciship.settings.manage'), true);
    for (const role of ['ACCOUNTING', 'AUDITOR']) {
      const held = [...permissionsOf('deciship', role)];
      assert.ok(held.includes('deciship.invoices.upload'), role);
      assert.equal(hasPermission(me(held), 'deciship.settings.manage'), false, role);
    }
  });

  it('sihirbaz kutuyu izne bağlar, izin yoksa kapalı ve nedeni yazılı (TR ve EN); istek de false gider', () => {
    const page = src('pages/InvoiceUpload.tsx');
    assert.match(page, /const canRemember = usePermission\("deciship\.settings\.manage"\)/);
    assert.match(page, /const saveMapping = canRemember && saveMappingWish/);
    const step = src('pages/invoice-upload/MappingStep.tsx');
    assert.match(step, /disabled=\{!canRemember\}/);
    assert.match(step, /t\("sur\.rememberLocked"\)/);
    for (const loc of ['tr', 'en']) assert.ok(locale(loc, 'invoiceUpload').sur.rememberLocked.length > 20, loc);
  });
});

describe('K43: itiraz penceresinde talep KDV hariç ve KDV dahil', () => {
  it('özet satırı KDV dahil toplam gelince ikisini de yazar (TR ve EN)', () => {
    for (const [loc, excl, incl] of [['tr', 'KDV hariç', 'KDV dahil'], ['en', 'excl. VAT', 'incl. VAT']] as const) {
      const d = locale(loc, 'invoiceDetail').dispute;
      for (const k of ['summaryVat_one', 'summaryVat_other']) {
        assert.ok(d[k].includes(excl) && d[k].includes(incl) && d[k].includes('{{totalVat}}'), `${loc} ${k}`);
      }
    }
    assert.match(src('pages/invoice-detail/DisputeDialog.tsx'), /totalInclVat != null \? "dispute\.summaryVat" : "dispute\.summary"/);
  });
});
