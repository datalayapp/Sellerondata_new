// Ölçüm paneli: çöp kutusu (Ölçümü sil) yalnız ölçüm yönetme izni olana ve düzenlenebilir kayıtta görünür.
// Düğme ⋯ menüsündeki eski "Sil" ile aynı onay penceresini açar (MeasurementPanel `setConfirmDel`).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { panelActions } from '../src/pages/measurements/panelActions.ts';

describe('panelActions', () => {
  it('izin yoksa eylem satırı yok (çöp kutusu çıkmaz)', () => {
    assert.equal(panelActions(false, { canEdit: true }), 'none');
    assert.equal(panelActions(false, { deleted: true }), 'none');
  });
  it('izinli kişi düzenlenebilir kayıtta çöp kutusu + Düzenle görür', () => {
    assert.equal(panelActions(true, {}), 'edit');
    assert.equal(panelActions(true, { canEdit: true }), 'edit');
  });
  it('sunucu kapattıysa (canEdit: false) silme de yok', () => {
    assert.equal(panelActions(true, { canEdit: false }), 'none');
  });
  it('silinmiş kayıtta yalnız Geri yükle', () => {
    assert.equal(panelActions(true, { deleted: true }), 'restore');
    assert.equal(panelActions(true, { deletedAt: '2026-11-13T10:00:00Z' }), 'restore');
  });
  it('kayıt yüklenmeden eylem yok', () => {
    assert.equal(panelActions(true, undefined), 'none');
  });
});

describe('MeasurementPanel çöp kutusu', () => {
  const src = readFileSync(new URL('../src/pages/measurements/MeasurementPanel.tsx', import.meta.url), 'utf8');
  it('erişilebilir adı ve ipucu sözlükten, aynı onay penceresini açar', () => {
    const btn = src.match(/<Button[\s\S]*?className="pn-del"[\s\S]*?\/>/)?.[0];
    assert.ok(btn, 'çöp kutusu düğmesi bulunamadı');
    assert.match(btn, /icon="trash"/);
    assert.match(btn, /aria-label=\{t\('panel\.deleteAria'\)\}/);
    assert.match(btn, /title=\{t\('panel\.deleteAria'\)\}/);
    assert.match(btn, /onClick=\{\(\) => setConfirmDel\(true\)\}/);
    // tek onay penceresi: silme isteği yalnız pencerenin "Sil" düğmesinden gider
    assert.equal(src.match(/del\.mutate\(\)/g)?.length, 1);
  });
  it('düğme yalnız "edit" kipinde çizilir', () => {
    assert.match(src, /mode = panelActions\(canManage, m\)/);
    assert.match(src, /!m \|\| mode === 'none' \? undefined : mode === 'restore' \?/);
  });
});

// Kalıcı silme (kullanıcı kararı 2026-11-13): yalnız "Geri yükle" kipinde, sunucunun `purge` bilgisiyle; korumada devre dışı ve
// nedeni görünür; onay penceresinde tek eylem kırmızı "Kalıcı olarak sil", metin geri alınamadığını ve takip no'yu söyler.
describe('MeasurementPanel kalıcı silme', () => {
  const panel = readFileSync(new URL('../src/pages/measurements/MeasurementPanel.tsx', import.meta.url), 'utf8');
  const src = readFileSync(new URL('../src/pages/measurements/PurgeMeasurement.tsx', import.meta.url), 'utf8');
  const tr = JSON.parse(readFileSync(new URL('../src/locales/tr/measurements.json', import.meta.url), 'utf8'));
  const en = JSON.parse(readFileSync(new URL('../src/locales/en/measurements.json', import.meta.url), 'utf8'));
  it('düğme yalnız silinmiş kaydın (restore) eylem satırında, Geri yükle ile birlikte; neden gövdede', () => {
    const restoreBranch = panel.slice(panel.indexOf("mode === 'restore' ?"), panel.indexOf("t('row.restore')"));
    assert.match(restoreBranch, /<PurgeMeasurementButton m=\{m\} onPurged=\{onClose\} \/>/);
    assert.equal(panel.match(/<PurgeMeasurementButton/g)?.length, 1);
    assert.match(panel, /<PurgeBlockedNote m=\{m\} \/>/);
  });
  it('sunucu bilgisi yoksa düğme yok; korumada devre dışı; istek yalnız penceredeki tehlike düğmesinden', () => {
    assert.match(src, /if \(!m\.purge\) return null;/);
    assert.match(src, /disabled=\{!allowed\}/);
    assert.match(src, /const allowed = m\.purge\?\.allowed === true;/);
    assert.equal(src.match(/purge\.mutate\(\)/g)?.length, 1);
    assert.match(src, /<ModalAction kind="danger" icon="trash" loading=\{purge\.isPending\} onClick=\{\(\) => purge\.mutate\(\)\}>/);
    assert.equal(src.match(/kind="prim"/g), null);
  });
  it('metinler iki dilde: geri alınamaz, takip no, iki koruma nedeni', () => {
    for (const d of [tr, en]) {
      assert.match(d.purge.text, /\{\{trackingNo\}\}/);
      assert.ok(d.purge.title && d.purge.confirm && d.panel.purgeAria && d.toast.purged);
      assert.ok(d.panel.purgeBlocked.DISPUTE && d.panel.purgeBlocked.DECIDED_LINE);
    }
    assert.match(tr.purge.text, /geri alınamaz/);
    assert.match(en.purge.text, /cannot be undone/);
  });
});
