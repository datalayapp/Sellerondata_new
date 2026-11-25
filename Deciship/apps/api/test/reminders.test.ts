import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  DEV_PRODUCT_NOTIFY_SECRET,
  NOTICE_DEDUPE_KEY,
  NOTICE_LIMITS,
  isNoticeActionPath,
  isNoticePlainText,
  type NoticeText,
  type ProductNoticeBody,
  type ProductNoticeResponse,
  type ProductNoticeStatus,
} from '@sellerondata/contracts';
import { dateLong } from '@sellerondata/format';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatReminderPlan, formatReminderResult, parseReminderArgs } from '../src/cli/reminders.ts';
import { prisma } from '../src/db.ts';
import { missingProductionEnv } from '../src/env.ts';
import { runMaintenance } from '../src/services/maintenance.ts';
import { NotifyError, notifyConfigured, sendProductNotice, setNotifier } from '../src/services/notify.ts';
import {
  DECLINED_MEMORY_MS,
  DIGEST_MAX_ROWS,
  REMINDER_PERMISSION,
  buildTtkDigest,
  clearReminderMemory,
  emptyReminderResult,
  inDigest,
  inReminderHours,
  reminderFailureKind,
  runDisputeReminders,
  type DigestItem,
  type ReminderPlan,
} from '../src/services/reminders.ts';
import { API, caller, digestOf, disputeCompany, invoiceWithDiffs, trDay, type DisputeCompany } from './disputeHelpers.ts';
import { getApp, inCompany } from './helpers.ts';
import { setFxService } from '../src/services/fx.ts';
import { anyDayFx } from './fxFake.ts';

// Y9: bakım işi (`runMaintenance`) bütün firmalarda bekleyen ölçüm karşılaştırmasını tamamlar; önceki test dosyalarından
// kalan dövizli faturalar (USD tarife, 15.10.2026) kur ister. Gerçek TCMB'ye gidilmesin diye her güne yanıt veren sahte kur.
beforeAll(() => setFxService(anyDayFx({ USD: 40.05, EUR: 44.1, GBP: 50.2 })));
afterAll(() => setFxService(null));

const DAY = 86_400_000;
/** `day` + `n` gün, YYYY-MM-DD. */
const shift = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY).toISOString().slice(0, 10);
/**
 * Saat ilerletme: fatura tarihinden `daysAfter` gün sonra, UTC `hour`'da (09 UTC = İstanbul 12:00). TTK son günü fatura + 8 gün:
 * `daysLeft = 8 - daysAfter`. Türkiye günü UTC+3; 21 UTC'den önceki saatlerde takvim günü aynı kalır.
 */
const at = (invoiceDate: string, daysAfter: number, hour = 9, minute = 0) =>
  new Date(`${shift(invoiceDate, daysAfter)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`);

/** Hesap servisinin metin kuralı (sözleşmedeki ortak işlev): uymayan gövde gerçekte 400 alır. */
function breaksNoticeRule(body: ProductNoticeBody): boolean {
  return Object.values(body.message).some(
    (t: NoticeText) =>
      !isNoticePlainText(t.subject, NOTICE_LIMITS.subject) ||
      t.lines.length < NOTICE_LIMITS.linesMin ||
      t.lines.length > NOTICE_LIMITS.linesMax ||
      t.lines.some((l) => !isNoticePlainText(l, NOTICE_LIMITS.line)) ||
      (t.action !== undefined && (!isNoticePlainText(t.action.label, NOTICE_LIMITS.actionLabel) || !isNoticeActionPath(body.product, t.action.path))) ||
      (t.footer !== undefined && !isNoticePlainText(t.footer, NOTICE_LIMITS.footer)),
  );
}

/**
 * Sahte bildirimci: Hesap servisi gibi gövdeyi metin kuralıyla denetler (uymazsa 400), `(orgId, dedupeKey)` ikilisini bir kez
 * kuyruğa alır, sonra `duplicate` döner. `failFor` içindeki firma için ya da `failAll` açıkken `NotifyError` atar;
 * `statusFor` içindeki firma için o durumu döner.
 */
function fakeNotifier() {
  const calls: ProductNoticeBody[] = [];
  const seen = new Set<string>();
  const failFor = new Set<string>();
  const statusFor = new Map<string, ProductNoticeStatus>();
  let failAll: number | null = null;
  const fn = async (body: ProductNoticeBody): Promise<ProductNoticeResponse> => {
    calls.push(structuredClone(body));
    if (failAll !== null) throw new NotifyError('HTTP', failAll);
    if (failFor.has(body.orgId)) throw new NotifyError('HTTP', 500);
    if (breaksNoticeRule(body)) throw new NotifyError('HTTP', 400);
    const status = statusFor.get(body.orgId);
    if (status) return { status, recipients: 0 };
    const key = `${body.orgId}|${body.dedupeKey}`;
    if (seen.has(key)) return { status: 'duplicate', recipients: 0 };
    seen.add(key);
    return { status: 'queued', recipients: 2 };
  };
  return {
    fn,
    calls,
    failFor,
    statusFor,
    /** Her istek bu HTTP durumuyla düşer (`null`: kapalı). */
    failAll: (httpStatus: number | null) => {
      failAll = httpStatus;
    },
    /** Bu firmaya giden çağrıların anahtarları, sırayla. */
    keysFor: (orgId: string) => calls.filter((c) => c.orgId === orgId).map((c) => c.dedupeKey),
    /** Bu firmaya giden son gövde. */
    lastFor: (orgId: string) => calls.filter((c) => c.orgId === orgId).at(-1),
  };
}

function captureLog() {
  const warns: string[] = [];
  const errors: string[] = [];
  return { warns, errors, log: { warn: (_o: unknown, msg: string) => void warns.push(msg), error: (_o: unknown, msg: string) => void errors.push(msg) } };
}

const settingsOf = (companyId: string) => inCompany(companyId, async () => (await prisma.company.findFirstOrThrow({ where: { id: companyId } })).settings as Record<string, unknown>);
async function patchSettings(companyId: string, patch: Record<string, unknown>) {
  await inCompany(companyId, async () => {
    const s = (await prisma.company.findFirstOrThrow({ where: { id: companyId } })).settings as Record<string, unknown>;
    const next: Record<string, unknown> = { ...s, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
    await prisma.company.update({ where: { id: companyId }, data: { settings: next as object } });
  });
}
const setCreatedAt = (companyId: string, invoiceId: string, createdAt: Date) =>
  inCompany(companyId, () => prisma.invoice.update({ where: { id: invoiceId }, data: { createdAt } }));

describe('itiraz süresi hatırlatması: günlük özet (Mesaj 14 §4.4)', () => {
  let app: FastifyInstance;
  let call: ReturnType<typeof caller>;
  let fake: ReturnType<typeof fakeNotifier>;
  /** Türkiye firması, tek fark faturası (karar verilmemiş). */
  let c: DisputeCompany;
  let inv: Awaited<ReturnType<typeof invoiceWithDiffs>>;
  const D = trDay(-3);
  const lastDay = shift(D, 8);

  beforeAll(async () => {
    app = await getApp();
    call = caller(app);
    c = await disputeCompany(app);
    inv = await invoiceWithDiffs(app, c, [50], { invoiceDate: D, verify: 0 });
    const totals = await inCompany(c.admin.auth, async () => (await prisma.invoice.findFirstOrThrow({ where: { id: inv.invoiceId } })).totals as Record<string, number>);
    // fikstür gerçekten aday: fazla ödeme var, satır fark
    expect(totals.overchargeTotal).toBeGreaterThan(0);
    expect(totals.diff).toBe(1);
  });
  beforeEach(() => {
    fake = fakeNotifier();
    setNotifier(fake.fn);
    clearReminderMemory();
  });
  afterEach(() => {
    setNotifier(null);
  });

  const runFor = (companyId: string, now: Date, o: Parameters<typeof runDisputeReminders>[1] = {}) => runDisputeReminders(now, { companyId, ...o });

  it('pencere: 3 ve 1 gün kala özet; 4 ve 2 gün kala, son gün (erken yüklenmiş) ve süre dolunca yok; gün başına bir kez', async () => {
    const id = c.admin.companyId;
    const results = [];
    for (const daysAfter of [4, 5, 6, 7, 8, 9]) results.push(await runFor(id, at(D, daysAfter)));
    // anahtar firmanın takvim günü (İstanbul 12:00)
    expect(fake.keysFor(id)).toEqual([`ttk:${shift(D, 5)}`, `ttk:${shift(D, 7)}`]);
    expect(results[0]).toMatchObject({ disabled: false, companies: 1, checked: 1, sent: 0, duplicate: 0, failed: 0 });
    expect(results[1]).toMatchObject({ sent: 1, duplicate: 0 });
    // 2 gün kala: aday yok, istek yok
    expect(results[2]).toMatchObject({ checked: 1, sent: 0, duplicate: 0 });
    expect(results[3]).toMatchObject({ sent: 1, duplicate: 0 });
    // son gün: fatura 1 gün kala özetine girebilecek kadar erken yüklendi
    expect(results[4]).toMatchObject({ checked: 1, sent: 0, duplicate: 0 });
    // süre doldu
    expect(results[5]).toMatchObject({ companies: 1, checked: 1, sent: 0, duplicate: 0 });
    expect(fake.calls).toHaveLength(2);

    // aynı gün ikinci tur: süreç belleği Hesap'a sormaz, faturaları da okumaz
    expect(await runFor(id, at(D, 7, 12))).toMatchObject({ checked: 0, sent: 0, duplicate: 1 });
    expect(fake.calls).toHaveLength(2);
    // yeniden başlatılmış süreç (bellek boş): Hesap servisi tekrar anahtarıyla `duplicate` döner, posta yine bir kez
    clearReminderMemory();
    expect(await runFor(id, at(D, 7, 13))).toMatchObject({ sent: 0, duplicate: 1 });
    expect(fake.keysFor(id)).toEqual([`ttk:${shift(D, 5)}`, `ttk:${shift(D, 7)}`, `ttk:${shift(D, 7)}`]);
  });

  it('son gün: 1 gün kala özetine giremeyen (son günden bir önceki gün ya da sonra yüklenen) fatura son gün özetine girer', async () => {
    const id = c.admin.companyId;
    await setCreatedAt(id, inv.invoiceId, at(D, 7, 15));
    try {
      expect(await runFor(id, at(D, 8))).toMatchObject({ sent: 1 });
      expect(fake.keysFor(id)).toEqual([`ttk:${shift(D, 8)}`]);
      expect(fake.lastFor(id)!.message.tr.subject).toBe(`İtiraz için son gün bugün (${dateLong(lastDay, 'tr')})`);
      // daha önce yüklenmiş olsaydı 1 gün kala özetinde görünürdü
      await setCreatedAt(id, inv.invoiceId, at(D, 6, 15));
      clearReminderMemory();
      const before = fake.calls.length;
      expect(await runFor(id, at(D, 8, 10))).toMatchObject({ sent: 0, duplicate: 0 });
      expect(fake.calls).toHaveLength(before);
    } finally {
      await setCreatedAt(id, inv.invoiceId, new Date());
    }
  });

  it('son güne yakın tek yuva (Y129): son günden bir önceki gün sabah yüklenen fatura 1 gün kala özetine girmez, son gün bir kez girer', async () => {
    const id = c.admin.companyId;
    // İstanbul 09:00, 1 gün kala günü: o günün turundan önce yüklenmiş
    await setCreatedAt(id, inv.invoiceId, at(D, 7, 6));
    try {
      expect(await runFor(id, at(D, 7))).toMatchObject({ checked: 1, sent: 0, duplicate: 0 });
      expect(await runFor(id, at(D, 8))).toMatchObject({ sent: 1 });
      expect(fake.keysFor(id)).toEqual([`ttk:${shift(D, 8)}`]);
      expect(fake.lastFor(id)!.message.tr.subject).toBe(`İtiraz için son gün bugün (${dateLong(lastDay, 'tr')})`);
    } finally {
      await setCreatedAt(id, inv.invoiceId, new Date());
    }
  });

  it('gövde: iki dil, doğru firma ve alıcı izni, en acile göre konu ve giriş, uygulama içi bağlantı, sözleşme sınırları; tutar yok', async () => {
    const id = c.admin.companyId;
    await runFor(id, at(D, 5));
    await runFor(id, at(D, 7));
    expect(fake.calls).toHaveLength(2);
    for (const body of fake.calls) {
      expect(body).toMatchObject({ product: 'deciship', orgId: id, audience: { permission: 'deciship.disputes.manage' } });
      expect(NOTICE_DEDUPE_KEY.test(body.dedupeKey)).toBe(true);
      expect(Object.keys(body.message).sort()).toEqual(['en', 'tr']);
      expect(breaksNoticeRule(body)).toBe(false);
      for (const text of Object.values(body.message)) {
        // giriş + 1 fatura + yasal not
        expect(text.lines).toHaveLength(3);
        expect(text.lines[1]).toContain(inv.invoiceNo);
        expect(text.action!.path).toBe(`/deciship/invoices/${inv.invoiceId}?tab=DIFF`);
      }
      // tutar ve para birimi yok
      const json = JSON.stringify(body);
      expect(json).not.toMatch(/₺|TRY|[Oo]vercharge|[Aa]mount/);
      expect(json).not.toContain('http');
    }
    const [three, one] = fake.calls as [ProductNoticeBody, ProductNoticeBody];
    expect(three.message.tr.subject).toBe(`İtiraz için 3 gün kaldı (son gün ${dateLong(lastDay, 'tr')})`);
    expect(three.message.en.subject).toBe(`3 days left to dispute (last day ${dateLong(lastDay, 'en')})`);
    expect(three.message.tr.lines[0]).toBe('En yakın son güne 3 gün var. İtiraz bekleyen 1 fatura:');
    expect(three.message.en.lines[0]).toBe('The nearest deadline is in 3 days. 1 invoice to dispute:');
    // taşıyıcı adı fikstürde `uniq('Aras ')`
    expect(three.message.tr.lines[1]!.startsWith('Aras ')).toBe(true);
    expect(three.message.tr.lines[1]!.endsWith(` ${inv.invoiceNo} (${dateLong(D, 'tr')}): son gün ${dateLong(lastDay, 'tr')}`)).toBe(true);
    expect(three.message.en.lines[1]!.endsWith(` ${inv.invoiceNo} (${dateLong(D, 'en')}): last day ${dateLong(lastDay, 'en')}`)).toBe(true);
    expect(three.message.tr.lines[2]).toContain('Türk Ticaret Kanunu');
    expect(three.message.en.action!.label).toBe('Open invoice');
    expect(three.message.tr.footer).toBe("Bu hatırlatmaları DeciShip › Ayarlar'dan kapatabilirsiniz.");
    expect(one.message.tr.subject).toBe(`İtiraz için son gün yarın (${dateLong(lastDay, 'tr')})`);
    expect(one.message.en.subject).toBe(`Last day to dispute is tomorrow (${dateLong(lastDay, 'en')})`);
    expect(one.message.tr.lines[0]).toBe('En yakın son gün yarın. İtiraz bekleyen 1 fatura:');
  });

  it('bir firmada birden çok fatura tek postada; bağlantı fatura listesine', async () => {
    const g = await disputeCompany(app);
    const many = [];
    for (let i = 0; i < 3; i++) many.push(await invoiceWithDiffs(app, g, [50], { invoiceDate: D, verify: 0 }));
    expect(await runFor(g.admin.companyId, at(D, 5))).toMatchObject({ checked: 3, sent: 1 });
    const body = fake.lastFor(g.admin.companyId)!;
    expect(fake.keysFor(g.admin.companyId)).toEqual([`ttk:${shift(D, 5)}`]);
    for (const text of Object.values(body.message)) {
      expect(text.lines).toHaveLength(1 + 3 + 1);
      for (const x of many) expect(text.lines.some((l) => l.includes(x.invoiceNo))).toBe(true);
      expect(text.action!.path).toBe('/deciship/invoices?status=TO_DISPUTE');
    }
    expect(body.message.tr.lines[0]).toBe('En yakın son güne 3 gün var. İtiraz bekleyen 3 fatura:');
    expect(body.message.en.lines[0]).toBe('The nearest deadline is in 3 days. 3 invoices to dispute:');
    expect(body.message.tr.action!.label).toBe('Faturaları aç');
  });

  it('firmanın verisi turu bozamaz: bağlantıya benzeyen ve biçim karakterli değer temizlenir, Hesap kuralından geçer', async () => {
    const h = await disputeCompany(app);
    const bad = await invoiceWithDiffs(app, h, [50], { invoiceDate: D, verify: 0 });
    const RLO = String.fromCharCode(0x202e);
    await inCompany(h.admin.companyId, async () => {
      await prisma.invoice.update({ where: { id: bad.invoiceId }, data: { invoiceNo: 'www.kotu.example/fatura' } });
      await prisma.carrier.update({ where: { id: h.carrierId }, data: { name: `Aras${RLO} http://kotu.example` } });
    });
    expect(await runFor(h.admin.companyId, at(D, 5))).toMatchObject({ sent: 1, failed: 0 });
    const body = fake.lastFor(h.admin.companyId)!;
    expect(breaksNoticeRule(body)).toBe(false);
    expect(body.message.tr.lines[1]).toBe(`Kargo fatura (${dateLong(D, 'tr')}): son gün ${dateLong(lastDay, 'tr')}`);
    expect(body.message.en.lines[1]).toBe(`Carrier invoice (${dateLong(D, 'en')}): last day ${dateLong(lastDay, 'en')}`);
    expect(JSON.stringify(body)).not.toContain(RLO);
  });

  it('gece posta yok: firmanın saat diliminde 09:00–19:00; --now penceresiz', async () => {
    const id = c.admin.companyId;
    // İstanbul: 05:59 UTC = 08:59, 16:00 UTC = 19:00 → atlanır
    expect(await runFor(id, at(D, 5, 5, 59))).toMatchObject({ companies: 0, checked: 0, sent: 0 });
    expect(await runFor(id, at(D, 5, 16, 0))).toMatchObject({ companies: 0, sent: 0 });
    expect(fake.calls).toHaveLength(0);
    // 06:00 UTC = 09:00 → gider
    expect(await runFor(id, at(D, 5, 6, 0))).toMatchObject({ companies: 1, sent: 1 });
    clearReminderMemory();
    // penceresiz komut gece de çalışır (Hesap tekrarı yakalar)
    expect(await runFor(id, at(D, 5, 2, 0), { ignoreQuietHours: true })).toMatchObject({ companies: 1, duplicate: 1 });

    // saat dilimi firmanın ayarından: UTC firmasında 08:00 UTC sabah 8'dir → atlanır; 10:00 UTC gider
    const tz = (await settingsOf(id)).timeZone;
    await patchSettings(id, { timeZone: 'UTC' });
    try {
      clearReminderMemory();
      const before = fake.calls.length;
      expect(await runFor(id, at(D, 7, 8, 0))).toMatchObject({ companies: 0 });
      expect(fake.calls).toHaveLength(before);
      expect(await runFor(id, at(D, 7, 10, 0))).toMatchObject({ companies: 1, sent: 1 });
      expect(fake.keysFor(id).at(-1)).toBe(`ttk:${shift(D, 7)}`);
    } finally {
      await patchSettings(id, { timeZone: tz });
    }
  });

  it('firma atlanır: hatırlatma kapalı (ayar ucu), deneme turu açık, ülke Türkiye değil ya da bilinmiyor', async () => {
    const id = c.admin.companyId;
    const off = await call(c.admin.auth, 'PATCH', '/settings', { disputeReminders: false });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().disputeReminders).toBe(false);
    expect(await runFor(id, at(D, 5), { ignoreQuietHours: true })).toMatchObject({ companies: 0, checked: 0, sent: 0 });
    const on = await call(c.admin.auth, 'PATCH', '/settings', { disputeReminders: true });
    expect(on.statusCode, on.body).toBe(200);

    await patchSettings(id, { demo: { startedAt: new Date().toISOString(), byMemberId: null } });
    try {
      expect(await runFor(id, at(D, 5), { ignoreQuietHours: true })).toMatchObject({ companies: 0, sent: 0 });
    } finally {
      await patchSettings(id, { demo: undefined });
    }

    // ülke bilinmiyor (ayarda yok, Merkez'den olay gelmemiş): TTK söylenmez
    const country = (await settingsOf(id)).country;
    await patchSettings(id, { country: undefined });
    try {
      const nameVersion = await inCompany(id, async () => (await prisma.company.findFirstOrThrow({ where: { id }, select: { nameVersion: true } })).nameVersion);
      expect(nameVersion).toBeNull();
      expect(await runFor(id, at(D, 5), { ignoreQuietHours: true })).toMatchObject({ companies: 0, sent: 0 });
    } finally {
      await patchSettings(id, { country });
    }
    expect(fake.calls).toHaveLength(0);

    const us = await disputeCompany(app, { country: 'US', currency: 'USD' });
    await invoiceWithDiffs(app, us, [50], { invoiceDate: D, verify: 0 });
    expect(await runFor(us.admin.companyId, at(D, 5), { ignoreQuietHours: true })).toMatchObject({ companies: 0, sent: 0 });
    expect(fake.keysFor(us.admin.companyId)).toEqual([]);

    expect(await runFor(id, at(D, 5), { ignoreQuietHours: true })).toMatchObject({ companies: 1, sent: 1 });
  });

  it('fatura atlanır: etkin itiraz turu, silinmiş, örnek, fark kabul edilmiş; geri çekilen itirazdan sonra yine aday', async () => {
    const f = await disputeCompany(app);
    const disputed = await invoiceWithDiffs(app, f, [50], { invoiceDate: D, verify: 1 });
    const deleted = await invoiceWithDiffs(app, f, [50], { invoiceDate: D, verify: 0 });
    const sample = await invoiceWithDiffs(app, f, [50], { invoiceDate: D, verify: 0 });
    const accepted = await invoiceWithDiffs(app, f, [50], { invoiceDate: D, verify: 0 });
    const live = await invoiceWithDiffs(app, f, [50], { invoiceDate: D, verify: 0 });

    const sent = await call(f.admin.auth, 'POST', `/invoices/${disputed.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.admin.auth, disputed.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    const round = sent.json().dispute.active as { id: string; version: number };
    await inCompany(f.admin.auth, async () => {
      await prisma.invoice.update({ where: { id: deleted.invoiceId }, data: { deletedAt: new Date() } });
      await prisma.invoice.update({ where: { id: sample.invoiceId }, data: { isSample: true } });
    });
    const acc = await app.inject({ method: 'PATCH', url: `${API}/invoice-lines/${accepted.lines[0]!.id}`, headers: f.admin.auth, payload: { decision: 'ACCEPTED', reason: 'tolerans' } });
    expect(acc.statusCode, acc.body).toBe(200);

    const r = await runFor(f.admin.companyId, at(D, 5), { ignoreQuietHours: true });
    // etkin itirazlı, silinmiş ve örnek fatura sorguya hiç girmez; kabul edilen fatura okunur ama fazla ödemesi yok
    expect(r).toMatchObject({ companies: 1, checked: 2, sent: 1 });
    const rows = fake.lastFor(f.admin.companyId)!.message.tr.lines;
    expect(rows).toHaveLength(3);
    expect(rows[1]).toContain(live.invoiceNo);
    for (const x of [disputed, deleted, sample, accepted]) expect(rows.join('\n')).not.toContain(x.invoiceNo);

    // itiraz geri çekilince süre yine işler: sonraki özette (1 gün kala) iki fatura
    const w = await call(f.admin.auth, 'POST', `/disputes/${round.id}/withdraw`, { version: round.version, reason: 'yanlış' });
    expect(w.statusCode, w.body).toBe(200);
    expect(w.json().dispute.active).toBeNull();
    await runFor(f.admin.companyId, at(D, 7), { ignoreQuietHours: true });
    const next = fake.lastFor(f.admin.companyId)!;
    expect(next.dedupeKey).toBe(`ttk:${shift(D, 7)}`);
    expect(next.message.tr.lines.some((l) => l.includes(disputed.invoiceNo))).toBe(true);
    expect(next.message.tr.lines.some((l) => l.includes(live.invoiceNo))).toBe(true);
  });

  it('Y30: etkin itiraz turu olan faturaya gönderimden sonra listeye eklenen (gönderilmemiş) satır hatırlatılır', async () => {
    const f = await disputeCompany(app);
    const inv = await invoiceWithDiffs(app, f, [50, 60], { invoiceDate: D, verify: 1 });
    const sent = await call(f.admin.auth, 'POST', `/invoices/${inv.invoiceId}/disputes`, { sentOn: trDay(0), channel: 'EMAIL', selectionDigest: await digestOf(app, f.admin.auth, inv.invoiceId) });
    expect(sent.statusCode, sent.body).toBe(201);
    // ikinci satır itiraz listesinde değil (karar bekliyor): etkin turlu fatura aday değil
    expect(await runFor(f.admin.companyId, at(D, 5), { ignoreQuietHours: true })).toMatchObject({ companies: 1, checked: 0, sent: 0 });

    const v = await call(f.admin.auth, 'PATCH', `/invoice-lines/${inv.lines[1]!.id}`, { decision: 'VERIFIED' });
    expect(v.statusCode, v.body).toBe(200);
    clearReminderMemory();
    const r = await runFor(f.admin.companyId, at(D, 7), { ignoreQuietHours: true });
    expect(r).toMatchObject({ companies: 1, checked: 1, sent: 1 });
    const body = fake.lastFor(f.admin.companyId)!;
    expect(body.dedupeKey).toBe(`ttk:${shift(D, 7)}`);
    expect(body.message.tr.lines.some((l) => l.includes(inv.invoiceNo))).toBe(true);
    // tek fatura: bağlantı faturanın kendisine
    expect(body.message.tr.action?.path).toContain(inv.invoiceId);
  });

  it('firma düzeyinde olumsuz yanıt (disabled, no_recipients, limited) birkaç saat hatırlanır; diğer firmalara sıra gelir', async () => {
    const id = c.admin.companyId;
    for (const status of ['disabled', 'no_recipients', 'limited'] as const) {
      clearReminderMemory();
      const local = fakeNotifier();
      setNotifier(local.fn);
      local.statusFor.set(id, status);
      expect(await runFor(id, at(D, 5)), status).toMatchObject({ sent: 0, skipped: 1 });
      // aynı firma bu sürede sorulmaz, faturaları okunmaz
      expect(await runFor(id, at(D, 5, 11)), status).toMatchObject({ checked: 0, sent: 0, skipped: 1 });
      expect(local.calls, status).toHaveLength(1);
      // süre geçince yeniden sorulur
      const later = new Date(at(D, 5).getTime() + DECLINED_MEMORY_MS + 60_000);
      await runFor(id, later);
      expect(local.calls, status).toHaveLength(2);
    }
  });

  it('turdaki hatalar: 400 ardışık sayılmaz ve firmayı bekletir; 500 ve 401 sayılır, 401 bir kez hata yazar; tavan kalanı sonraki tura bırakır', async () => {
    // en az altı aday firma (paylaşılan veritabanında başkaları da olabilir: yalnız sayılara alt sınır konur)
    const extra: DisputeCompany[] = [];
    for (let i = 0; i < 5; i++) {
      const x = await disputeCompany(app);
      await invoiceWithDiffs(app, x, [50], { invoiceDate: D, verify: 0 });
      extra.push(x);
    }
    const all = (o: Parameters<typeof runDisputeReminders>[1] = {}) => runDisputeReminders(at(D, 5), { ignoreQuietHours: true, maxNotices: 10_000, ...o });

    // tek firmanın hatası (500) turu durdurmaz
    fake.failFor.add(c.admin.companyId);
    const first = await all();
    expect(first.failed).toBeGreaterThanOrEqual(1);
    expect(first.capped).toBe(false);
    for (const x of extra) expect(fake.keysFor(x.admin.companyId)).toEqual([`ttk:${shift(D, 5)}`]);
    // başarısız istek belleğe girmez: sonraki tur yeniden dener
    fake.failFor.clear();
    await runFor(c.admin.companyId, at(D, 5));
    expect(fake.keysFor(c.admin.companyId)).toEqual([`ttk:${shift(D, 5)}`, `ttk:${shift(D, 5)}`]);

    // 400: her firma reddedilir ama tur kesilmez; firmalar beklemeye alınır, sonraki turda sorulmaz
    clearReminderMemory();
    const rejected = fakeNotifier();
    rejected.failAll(400);
    setNotifier(rejected.fn);
    const l400 = captureLog();
    const r400 = await all({ log: l400.log });
    expect(r400.capped).toBe(false);
    expect(rejected.calls.length).toBeGreaterThanOrEqual(6);
    expect(r400.failed).toBe(rejected.calls.length);
    expect(l400.warns).toContain('dispute reminder rejected by the account service; company skipped for a while');
    expect(l400.warns).not.toContain('dispute reminder run stopped after repeated failures');
    const callsAfter400 = rejected.calls.length;
    const again = await all();
    expect(rejected.calls).toHaveLength(callsAfter400);
    expect(again.skipped).toBeGreaterThanOrEqual(6);

    // 500 ve 401 art arda: tur beşinci hatada kesilir; 401 bir kez hata düzeyinde yazılır
    for (const status of [500, 401]) {
      clearReminderMemory();
      const down = fakeNotifier();
      down.failAll(status);
      setNotifier(down.fn);
      const log = captureLog();
      const stopped = await all({ log: log.log });
      expect(stopped, String(status)).toMatchObject({ capped: true, sent: 0, failed: 5 });
      expect(down.calls, String(status)).toHaveLength(5);
      expect(log.warns).toContain('dispute reminder run stopped after repeated failures');
      const keyErrors = log.errors.filter((e) => e.includes('PRODUCT_NOTIFY_SECRET does not match'));
      expect(keyErrors, String(status)).toHaveLength(status === 401 ? 1 : 0);
    }

    // tavan: bir turda bir istek; ikinci tur cevaplanan firmayı geçer, sıradakine sorar
    clearReminderMemory();
    const capped = fakeNotifier();
    setNotifier(capped.fn);
    expect(await all({ maxNotices: 1 })).toMatchObject({ sent: 1, capped: true });
    expect(capped.calls).toHaveLength(1);
    expect(await all({ maxNotices: 1 })).toMatchObject({ sent: 1, duplicate: 1, capped: true });
    expect(capped.calls).toHaveLength(2);
    expect(capped.calls[1]!.orgId).not.toBe(capped.calls[0]!.orgId);
  });

  it('kuru çalışma göndermez: firma başına özet planı', async () => {
    const plans: ReminderPlan[] = [];
    const r = await runFor(c.admin.companyId, at(D, 5), { dryRun: true, onPlan: (p) => void plans.push(p) });
    expect(r).toMatchObject({ planned: 1, sent: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(plans).toEqual([{ companyId: c.admin.companyId, dedupeKey: `ttk:${shift(D, 5)}`, invoices: 1, nearestDaysLeft: 3 }]);
  });

  it('bildirim adresi yoksa kapalı: veritabanı okunmaz, istek yok; kuru çalışma yine sayar', async () => {
    setNotifier(null);
    const saved = process.env.ACCOUNT_NOTIFY_URL;
    delete process.env.ACCOUNT_NOTIFY_URL;
    try {
      expect(notifyConfigured()).toBe(false);
      expect(await runFor(c.admin.companyId, at(D, 5), { ignoreQuietHours: true })).toEqual(emptyReminderResult(true));
      expect(await runFor(c.admin.companyId, at(D, 5), { ignoreQuietHours: true, dryRun: true })).toMatchObject({ disabled: false, companies: 1, planned: 1 });
    } finally {
      if (saved === undefined) delete process.env.ACCOUNT_NOTIFY_URL;
      else process.env.ACCOUNT_NOTIFY_URL = saved;
    }
  });

  it('bakım işi hatırlatmayı çağırır; bildirim hatası bakımın geri kalanını düşürmez', async () => {
    const ok = await runMaintenance(at(D, 5).getTime());
    expect(ok.reminders.disabled).toBe(false);
    expect(fake.keysFor(c.admin.companyId)).toEqual([`ttk:${shift(D, 5)}`]);

    clearReminderMemory();
    const down = fakeNotifier();
    down.failAll(500);
    setNotifier(down.fn);
    const warns: string[] = [];
    const r = await runMaintenance(at(D, 7).getTime(), { warn: (_o, msg) => void warns.push(msg) });
    expect(r.reminders.failed).toBeGreaterThanOrEqual(1);
    expect(r).toMatchObject({ drafts: expect.any(Number), jobs: expect.any(Number), purged: expect.any(Number) });
    expect(warns).toContain('dispute reminder not sent');
  });
});

// ---------- veritabanı istemeyen saf kurallar ----------

const ORG = '00000000-0000-4000-8000-000000000001';
const item = (n: number, over: Partial<DigestItem> = {}): DigestItem => ({
  invoiceId: `00000000-0000-4000-8000-${String(100 + n).padStart(12, '0')}`,
  invoiceNo: `F${n}`,
  invoiceDate: '2026-11-10',
  carrierName: 'Aras',
  lastDay: '2026-11-18',
  daysLeft: 3,
  ...over,
});

describe('hatırlatma: saf kurallar', () => {
  it('özete giriş: 3 gün kala; 1 gün kala ya da son gün (yükleme gününe göre tam biri); 2, 4 ve süre dolmuş hayır', () => {
    expect([8, 4, 3, 2, 1, 0, -1].map((d) => inDigest(d, false))).toEqual([false, false, true, false, true, false, false]);
    // Y129: geç yüklenen fatura 1 gün kala özetine girmez, son gün özetine girer (iki gün üst üste listelenmez).
    expect([8, 4, 3, 2, 1, 0, -1].map((d) => inDigest(d, true))).toEqual([false, false, true, false, false, true, false]);
  });

  it('saat penceresi firmanın saat diliminde, 09:00 dahil 19:00 hariç', () => {
    expect(inReminderHours(new Date('2026-11-20T05:59:00Z'), 'Europe/Istanbul')).toBe(false);
    expect(inReminderHours(new Date('2026-11-20T06:00:00Z'), 'Europe/Istanbul')).toBe(true);
    expect(inReminderHours(new Date('2026-11-20T15:59:00Z'), 'Europe/Istanbul')).toBe(true);
    expect(inReminderHours(new Date('2026-11-20T16:00:00Z'), 'Europe/Istanbul')).toBe(false);
    expect(inReminderHours(new Date('2026-11-20T06:00:00Z'), 'UTC')).toBe(false);
    expect(inReminderHours(new Date('2026-11-20T09:00:00Z'), 'UTC')).toBe(true);
  });

  it('özet: son günü en yakın önce, en çok 6 satır ve "ve X fatura daha", konu ve giriş en acile göre, liste bağlantısı', () => {
    const items = [
      ...Array.from({ length: 6 }, (_, i) => item(i, { daysLeft: 3, lastDay: '2026-11-18' })),
      item(7, { daysLeft: 1, lastDay: '2026-11-16', invoiceNo: 'YAKIN1' }),
      item(8, { daysLeft: 0, lastDay: '2026-11-15', invoiceNo: 'BUGUN' }),
    ];
    const body = buildTtkDigest({ companyId: ORG, day: '2026-11-15', items });
    expect(body).toMatchObject({ product: 'deciship', orgId: ORG, dedupeKey: 'ttk:2026-11-15', audience: { permission: REMINDER_PERMISSION } });
    const tr = body.message.tr;
    expect(tr.lines).toHaveLength(1 + DIGEST_MAX_ROWS + 1 + 1);
    expect(tr.lines.length).toBeLessThanOrEqual(NOTICE_LIMITS.linesMax);
    expect(tr.subject).toBe(`İtiraz için son gün bugün (${dateLong('2026-11-15', 'tr')})`);
    expect(body.message.en.subject).toBe(`Last day to dispute is today (${dateLong('2026-11-15', 'en')})`);
    expect(tr.lines[0]).toBe('En yakın son gün bugün. İtiraz bekleyen 8 fatura:');
    expect(tr.lines[1]).toContain('BUGUN');
    expect(tr.lines[2]).toContain('YAKIN1');
    expect(tr.lines[7]).toBe('ve 2 fatura daha');
    expect(body.message.en.lines[7]).toBe('and 2 more invoices');
    expect(body.message.en.lines[0]).toBe('The nearest deadline is today. 8 invoices to dispute:');
    expect(tr.action).toEqual({ label: 'Faturaları aç', path: '/deciship/invoices?status=TO_DISPUTE' });
    expect(breaksNoticeRule(body)).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(NOTICE_LIMITS.bodyBytes);
    // tek "daha" fatura için İngilizce tekil
    expect(buildTtkDigest({ companyId: ORG, day: '2026-11-15', items: items.slice(0, 7) }).message.en.lines[7]).toBe('and 1 more invoice');
    // aynı girdi her zaman aynı gövde (sıra girdiden bağımsız)
    expect(buildTtkDigest({ companyId: ORG, day: '2026-11-15', items: [...items].reverse() })).toEqual(body);
    // yarın en acilse
    expect(buildTtkDigest({ companyId: ORG, day: '2026-11-15', items: items.slice(0, 7) }).message.tr.subject).toBe(`İtiraz için son gün yarın (${dateLong('2026-11-16', 'tr')})`);
    expect(() => buildTtkDigest({ companyId: ORG, day: '2026-11-15', items: [] })).toThrow(/empty/);
    expect(() => buildTtkDigest({ companyId: ORG, day: '15.11.2026', items })).toThrow(/dedupe/);
  });

  it('kullanıcı verisi düz metin: satır sonu, denetim ve biçim karakteri giremez, bağlantıya benzeyen değer genel metin olur, uzun ad kesilir', () => {
    const NUL = String.fromCharCode(0);
    const RLO = String.fromCharCode(0x202e);
    const ZWSP = String.fromCharCode(0x200b);
    const cases: [Partial<DigestItem>, (row: string) => void][] = [
      [{ invoiceNo: `F1\r\nBcc: x@example.com${'9'.repeat(200)}`, carrierName: `Aras${NUL}<b>Kargo</b>` }, (row) => expect(row).toContain('<b>Kargo</b>')],
      [{ invoiceNo: `F${RLO}fdp.exe`, carrierName: `Ar${ZWSP}as` }, (row) => expect(row.startsWith('Aras Ffdp.exe (')).toBe(true)],
      [{ invoiceNo: 'www.kotu.example', carrierName: 'Aras' }, (row) => expect(row.startsWith('Aras fatura (')).toBe(true)],
      [{ invoiceNo: 'F1', carrierName: 'https://kotu.example' }, (row) => expect(row.startsWith('Kargo F1 (')).toBe(true)],
      [{ invoiceNo: 'F1', carrierName: 'HTTP' }, (row) => expect(row.startsWith('HTTP F1 (')).toBe(true)],
      [{ invoiceNo: `${RLO}${ZWSP}`, carrierName: '   ' }, (row) => expect(row.startsWith('Kargo fatura (')).toBe(true)],
    ];
    for (const [over, check] of cases) {
      const body = buildTtkDigest({ companyId: ORG, day: '2026-11-15', items: [item(1, over)] });
      expect(breaksNoticeRule(body), JSON.stringify(over)).toBe(false);
      for (const t of Object.values(body.message)) {
        expect(t.subject).not.toMatch(/[\r\n]/);
        for (const l of t.lines) expect(/[\r\n]/.test(l) || l.includes(NUL) || l.includes(RLO) || l.includes(ZWSP)).toBe(false);
        expect(t.lines[1]!.length).toBeLessThanOrEqual(NOTICE_LIMITS.line);
      }
      // HTML kaçışı Hesap servisinin işi: metin olduğu gibi (düz) gider
      check(body.message.tr.lines[1]!);
    }
  });

  it('hata türü: zaman aşımı, ağ, 5xx ve 401 ulaşamama sayılır; 400/404/yanıt şekli reddedilmedir; adres ve anahtar yapılandırmadır', () => {
    expect(reminderFailureKind(new NotifyError('TIMEOUT'))).toBe('reach');
    expect(reminderFailureKind(new NotifyError('NETWORK'))).toBe('reach');
    expect(reminderFailureKind(new NotifyError('HTTP', 500))).toBe('reach');
    expect(reminderFailureKind(new NotifyError('HTTP', 503))).toBe('reach');
    expect(reminderFailureKind(new NotifyError('HTTP', 401))).toBe('reach');
    expect(reminderFailureKind(new NotifyError('HTTP', 400))).toBe('rejected');
    expect(reminderFailureKind(new NotifyError('HTTP', 404))).toBe('rejected');
    expect(reminderFailureKind(new NotifyError('BAD_RESPONSE', 200))).toBe('rejected');
    expect(reminderFailureKind(new NotifyError('TOO_LARGE'))).toBe('rejected');
    expect(reminderFailureKind(new Error('x'))).toBe('rejected');
    for (const r of ['NOT_CONFIGURED', 'NO_SECRET', 'BAD_URL'] as const) expect(reminderFailureKind(new NotifyError(r))).toBe('config');
  });

  it('komut satırı: gönderim yalnız --send ile; bayraksız kuru; bilinmeyen bayrak ve kimliksiz --company reddedilir', () => {
    expect(parseReminderArgs([])).toEqual({ now: false, send: false });
    expect(parseReminderArgs(['--now', '--dry'])).toEqual({ now: true, send: false });
    expect(parseReminderArgs(['--send'])).toEqual({ now: false, send: true });
    expect(parseReminderArgs(['--company', ORG])).toMatchObject({ companyId: ORG, send: false });
    expect(() => parseReminderArgs(['--dry', '--send'])).toThrow(/together/);
    expect(() => parseReminderArgs(['--sned'])).toThrow(/unknown argument/);
    expect(() => parseReminderArgs(['--company'])).toThrow(/company/);
    expect(() => parseReminderArgs(['--company', 'x; drop'])).toThrow(/company/);
    expect(formatReminderResult({ ...emptyReminderResult(), sent: 2 }, false)).toBe('Done: companies=0 checked=0 sent=2 duplicate=0 skipped=0 failed=0');
    expect(formatReminderResult({ ...emptyReminderResult(), planned: 1 }, true)).toBe('Dry run (nothing sent; add --send to send): companies=0 checked=0 planned=1 duplicate=0 skipped=0 failed=0');
    expect(formatReminderResult(emptyReminderResult(true), false)).toMatch(/ACCOUNT_NOTIFY_URL is empty/);
    expect(formatReminderPlan({ companyId: ORG, dedupeKey: 'ttk:2026-11-15', invoices: 3, nearestDaysLeft: 1 })).toBe(
      `Would send: company=${ORG} key=ttk:2026-11-15 invoices=3 nearestDaysLeft=1`,
    );
  });

  it('açılış denetimi: adres doluysa anahtar sözleşmedeki kurala uymalı (Hesap servisiyle aynı); geliştirmede denetim yok', () => {
    const PROD = { NODE_ENV: 'production', DATABASE_URL: 'x', ACCOUNT_JWKS_URL: 'x', ALLOWED_ORIGINS: 'x', FILE_TOKEN_SECRET: 'x', APP_BASE_URL: 'https://app.example.test' };
    const url = 'http://account-api:4100/api/account/internal/notify';
    const MSG = 'PRODUCT_NOTIFY_SECRET (32-512 visible ASCII characters, not the development key, when ACCOUNT_NOTIFY_URL is set)';
    for (const bad of ['', 'a'.repeat(31), 'a'.repeat(513), DEV_PRODUCT_NOTIFY_SECRET, `${'a'.repeat(20)} ${'a'.repeat(20)}`, `${'a'.repeat(32)}${String.fromCharCode(0xe7)}`]) {
      expect(missingProductionEnv({ ...PROD, ACCOUNT_NOTIFY_URL: url, PRODUCT_NOTIFY_SECRET: bad }), JSON.stringify(bad)).toEqual([MSG]);
    }
    for (const ok of ['a'.repeat(32), ` ${'a'.repeat(512)} `]) expect(missingProductionEnv({ ...PROD, ACCOUNT_NOTIFY_URL: url, PRODUCT_NOTIFY_SECRET: ok })).toEqual([]);
    // adres boşsa hatırlatma kapalı: anahtar istenmez; geliştirme ve testte varsayılan anahtar serbest
    expect(missingProductionEnv({ ...PROD, PRODUCT_NOTIFY_SECRET: 'kisa' })).toEqual([]);
    expect(missingProductionEnv({ NODE_ENV: 'development', ACCOUNT_NOTIFY_URL: url, PRODUCT_NOTIFY_SECRET: DEV_PRODUCT_NOTIFY_SECRET })).toEqual([]);
    expect(missingProductionEnv({ NODE_ENV: 'test', ACCOUNT_NOTIFY_URL: url })).toEqual([]);
  });
});

describe('bildirim istemcisi (sendProductNotice)', () => {
  const SECRET = 'test-notify-secret-0123456789abcdef-xyz';
  let server: http.Server;
  let base: string;
  let reply: (req: http.IncomingMessage, res: http.ServerResponse) => void;
  const received: { headers: http.IncomingHttpHeaders; body: string; url: string | undefined }[] = [];
  const saved = { url: process.env.ACCOUNT_NOTIFY_URL, secret: process.env.PRODUCT_NOTIFY_SECRET };
  const body = buildTtkDigest({ companyId: ORG, day: '2026-11-15', items: [item(1)] });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (ch) => (data += ch));
      req.on('end', () => {
        received.push({ headers: req.headers, body: data, url: req.url });
        reply(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ACCOUNT_NOTIFY_URL = `${base}/api/account/internal/notify`;
    process.env.PRODUCT_NOTIFY_SECRET = SECRET;
  });
  afterAll(async () => {
    for (const [k, v] of [['ACCOUNT_NOTIFY_URL', saved.url], ['PRODUCT_NOTIFY_SECRET', saved.secret]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    received.length = 0;
  });

  const json = (status: number, payload: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  };

  it('anahtar yalnız authorization başlığında; gövde JSON; yanıt şekli denetlenir', async () => {
    reply = json(200, { status: 'queued', recipients: 2 });
    await expect(sendProductNotice(body)).resolves.toEqual({ status: 'queued', recipients: 2 });
    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe('/api/account/internal/notify');
    expect(received[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(received[0]!.headers['content-type']).toBe('application/json');
    expect(JSON.parse(received[0]!.body)).toEqual(body);
    expect(received[0]!.body).not.toContain(SECRET);
  });

  it('hata: durum kodu ve neden, anahtar ya da yanıt gövdesi iletiye girmez', async () => {
    const cases: [typeof reply, string, number | null][] = [
      [json(401, { error: { code: 'UNAUTHORIZED', echo: SECRET } }), 'HTTP', 401],
      [json(500, {}), 'HTTP', 500],
      [json(200, { status: 'gonderildi', recipients: 1 }), 'BAD_RESPONSE', 200],
      [json(200, { status: 'queued', recipients: -1 }), 'BAD_RESPONSE', 200],
      [(_q, res) => res.end('x'.repeat(10_000)), 'BAD_RESPONSE', 200],
    ];
    for (const [r, reason, httpStatus] of cases) {
      reply = r;
      const err = await sendProductNotice(body).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NotifyError);
      expect(err).toMatchObject({ reason, httpStatus });
      expect(String((err as Error).message)).not.toContain(SECRET);
      expect(JSON.stringify(err)).not.toContain(SECRET);
    }
  });

  it('yönlendirme izlenmez: anahtar başka adrese taşınmaz', async () => {
    reply = (_q, res) => {
      res.writeHead(307, { location: `${base}/baska` });
      res.end();
    };
    await expect(sendProductNotice(body)).rejects.toMatchObject({ reason: 'NETWORK' });
    expect(received.map((r) => r.url)).toEqual(['/api/account/internal/notify']);
  });

  it('adres ya da anahtar yoksa, adres http(s) değilse ya da kimlik taşıyorsa istek atılmaz', async () => {
    reply = json(200, { status: 'queued', recipients: 1 });
    const url = process.env.ACCOUNT_NOTIFY_URL!;
    try {
      for (const [u, s, reason] of [
        ['', SECRET, 'NOT_CONFIGURED'],
        [url, '', 'NO_SECRET'],
        ['ftp://127.0.0.1/x', SECRET, 'BAD_URL'],
        [url.replace('http://', 'http://kim:parola@'), SECRET, 'BAD_URL'],
        ['bozuk adres', SECRET, 'BAD_URL'],
      ] as const) {
        process.env.ACCOUNT_NOTIFY_URL = u;
        process.env.PRODUCT_NOTIFY_SECRET = s;
        await expect(sendProductNotice(body)).rejects.toMatchObject({ reason });
      }
      expect(received).toHaveLength(0);
    } finally {
      process.env.ACCOUNT_NOTIFY_URL = url;
      process.env.PRODUCT_NOTIFY_SECRET = SECRET;
    }
  });

  it('gövde sınırı aşılırsa gönderilmez', async () => {
    reply = json(200, { status: 'queued', recipients: 1 });
    const big = { ...body, message: { ...body.message, tr: { ...body.message.tr, lines: Array.from({ length: 80 }, () => 'x'.repeat(300)) } } };
    await expect(sendProductNotice(big)).rejects.toMatchObject({ reason: 'TOO_LARGE' });
    expect(received).toHaveLength(0);
  });
});
