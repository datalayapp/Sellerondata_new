-- Mesaj 14 (itiraz süresi hatırlatması): bakım işi firmaları listeleyebilsin. Yalnız okuma ve yalnız bakım kapsamı
-- (20261107000000_maintenance_scope deseni). Hatırlatma işi yalnız `id` ve `settings` okur (firmanın saat dilimi, ayarı, ülkesi);
-- fatura ve diğer tablolar bakım kapsamında AÇILMAZ, adaylar firma bağlamında (`withCompany`) okunur.
-- Yalnız ilke eklenir; hiçbir satır güncellenmez (NO FORCE -> UPDATE -> FORCE gerekmez), tablo ve sütun değişmez.
-- Bakım kapsamı yalnız süreç içi bakım işi tarafından açılır; HTTP isteği bu kapsama giremez (test/rls.test.ts sınar).
CREATE POLICY company_maintenance_read ON "deciship"."Company" FOR SELECT
  USING (current_setting('app.scope', true) = 'maintenance');
