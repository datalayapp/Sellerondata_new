import { defineProduct } from '@sellerondata/contracts';

/**
 * Sahte araç "Örnek Araç" (Mesaj 11 §3.10). Kayıtta YOK: kalıcı olarak yalnız test fikstürüdür (karar 14). Tur 4 ölçümünde
 * bu girdi geçici olarak `contracts/src/products.ts` `PRODUCT_REGISTRY`'ye kopyalanır, sonra çıkarılır.
 * İşaret yok (tek harfli kare), web yok (yolları Merkez'e düşer), renk nötr gri (karar 13).
 */
export const ORNEKARAC = defineProduct({
  key: 'ornekarac',
  name: 'Örnek Araç',
  tagline: { tr: 'Ortak araç paketinin örneği', en: 'A sample of the shared tool kit' },
  color: '#667085',
  launch: 'pilot',
  permissions: {
    'ornekarac.reports.view': { tr: 'Raporları görme', en: 'View reports' },
    'ornekarac.data.view': { tr: 'Veriyi görme', en: 'View data' },
    'ornekarac.data.export': { tr: 'Veriyi dışa aktarma', en: 'Export data' },
    'ornekarac.items.write': { tr: 'Kayıt ekleme', en: 'Add records' },
  },
  roles: [
    {
      key: 'ADMIN',
      label: { tr: 'Yönetici', en: 'Admin' },
      description: { tr: 'Her şey.', en: 'Everything.' },
      permissions: ['ornekarac.reports.view', 'ornekarac.data.view', 'ornekarac.data.export', 'ornekarac.items.write'],
    },
    {
      key: 'VIEWER',
      label: { tr: 'İzleyici', en: 'Viewer' },
      description: { tr: 'Yalnız okur.', en: 'Read only.' },
      permissions: ['ornekarac.reports.view', 'ornekarac.data.view'],
    },
  ],
  ownerRole: 'ADMIN',
  inviteRole: 'VIEWER',
  hub: { analytics: 'ornekarac.reports.view', data: 'ornekarac.data.view', export: 'ornekarac.data.export' },
  deploy: { api: { service: 'ornekarac-api', port: 4900 } },
});

export const ORNEKARAC_SCHEMA = 'ornekarac';
/**
 * Kendi iki rolü, gerçek araç gibi (infra/postgres/init.sql düzeni, `Platform/scripts/products-db.mjs`): göç rolü şemanın sahibi
 * ve göçü çalıştırır, uygulama rolü yalnız veri okur/yazar. Test kurulumu ikisini kümede açar (`dbSetup.ts`).
 */
export const ORNEKARAC_ADMIN_ROLE = 'sod_ornekarac_admin';
export const ORNEKARAC_APP_ROLE = 'sod_ornekarac';
