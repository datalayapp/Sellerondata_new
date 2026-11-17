import crypto from 'node:crypto';
import type { PlatformEvent } from '@sellerondata/contracts';
import { describe, expect, it } from 'vitest';
import { prisma, withCompany } from '../src/db.ts';
import { companyFixture } from './fixtures.ts';
import { createWorker, getApp, inCompany, registerCompany, sendEvent, uniq } from './helpers.ts';

const orgUpdated = (orgId: string, version: number | undefined, fields: { companyConfirmed?: unknown; name?: string; currency?: string; country?: string } = {}) =>
  ({ eventId: crypto.randomUUID(), type: 'org.updated', orgId, product: 'deciship', name: 'Firma', ...(version === undefined ? {} : { version }), ...fields }) as PlatformEvent;

/** Kayıtlı ayar (yanıt değil): Merkez onayı ayar yanıtlarına girmez. */
const storedSettings = (companyId: string) =>
  withCompany(companyId, async () => (await prisma.company.findFirstOrThrow({ where: { id: companyId } })).settings as Record<string, unknown>);

describe('İlk kurulum sihirbazı (/settings/onboarding)', () => {
  it('yeni şirket: kurulum gerekli; ilerleme saklanır, taşıyıcı eklenince yönlendirme biter, tamamlanınca bant kalkar', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Kurulum A');

    const me0 = (await app.inject({ method: 'GET', url: '/api/deciship/me', headers: a.auth })).json();
    expect(me0.onboarding).toEqual({ completed: false, required: true, showBanner: true });

    const s0 = await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: a.auth });
    expect(s0.statusCode).toBe(200);
    expect(s0.json()).toMatchObject({ completed: false, required: true, carriers: [], boxPresets: 3, invoices: [] });
    // çalışan adımı Merkez'e taşındı: kurulumda iz kalmadı
    expect(s0.json()).not.toHaveProperty('workers');
    expect((await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { step: 'kullanicilar' } })).statusCode).toBe(400);
    // Firma adımı Merkez'e taşındı (2026-11-13): zorunlu adımlarda yok. Eski istemcinin `done: 'sirket'` isteği yine kabul edilir.
    expect(s0.json().requiredSteps).toEqual(['tasiyicilar', 'tarifeler', 'olcum']);

    const p1 = await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { step: 'tasiyicilar', done: 'sirket' } });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().state).toMatchObject({ step: 'tasiyicilar', done: ['sirket'], skipped: [] });
    expect(p1.json().state.startedAt).toBeTruthy();

    // atla → tamamla: listeler birbirini dışlar
    await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { skipped: 'tarifeler' } });
    const p2 = await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { done: 'tarifeler' } });
    expect(p2.json().state).toMatchObject({ done: ['sirket', 'tarifeler'], skipped: [] });

    // geçersiz adım / alan reddedilir
    expect((await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { step: 'yok' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { foo: 1 } })).statusCode).toBe(400);

    // Ayarlar kaydı kurulum ilerlemesini silmez
    const ps = await app.inject({ method: 'PATCH', url: '/api/deciship/settings', headers: a.auth, payload: { desiDivisor: 5000 } });
    expect(ps.statusCode).toBe(200);
    expect(ps.json().onboarding.done).toEqual(['sirket', 'tarifeler']);

    // taşıyıcı eklenince yönlendirme gerekmez, kurulum yine tamamlanmamış sayılır
    const c = await app.inject({ method: 'POST', url: '/api/deciship/carriers', headers: a.auth, payload: { code: 'fedex' } });
    expect(c.statusCode).toBe(201);
    const s1 = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: a.auth })).json();
    expect(s1).toMatchObject({ completed: false, required: false, showBanner: true });
    expect(s1.carriers).toEqual([expect.objectContaining({ code: 'fedex', name: 'FedEx', activeTariffCount: 0, tariffs: [] })]);

    const done = await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { complete: true } });
    expect(done.json()).toMatchObject({ completed: true, required: false, showBanner: false });
    expect((await app.inject({ method: 'GET', url: '/api/deciship/me', headers: a.auth })).json().onboarding.completed).toBe(true);

    // yeniden açılabilir
    const re = await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { complete: false } });
    expect(re.json().completed).toBe(false);
  });

  it('yalnız yönetici; çalışan /me içinde kurulum bilgisi görmez', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Kurulum Yetki');
    const w = await createWorker(app, a.auth);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: w.auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: w.auth, payload: { step: 'ozet' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding' })).statusCode).toBe(401);
    const me = (await app.inject({ method: 'GET', url: '/api/deciship/me', headers: w.auth })).json();
    expect(me.onboarding).toBeUndefined();
    expect(me.company.settings.onboarding).toBeUndefined();
  });

  it('şirketler birbirinden ayrık: başka şirketin faturası örnek faturası görünmez', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Kurulum İzole A');
    const b = await registerCompany(app, 'Kurulum İzole B');
    const companyA = a.companyId;
    const companyB = b.companyId;
    const invB = await inCompany(b.auth, async () => {
      const carrierB = await prisma.carrier.create({ data: { companyId: companyB, code: 'ups', name: 'UPS' } });
      const file = await prisma.file.create({
        data: { companyId: companyB, kind: 'INVOICE_SOURCE', path: 'x/y.csv', sha256: 'x', originalName: 'y.csv', mime: 'text/csv', size: 1, createdById: b.user.id },
      });
      return prisma.invoice.create({
        data: { companyId: companyB, carrierId: carrierB.id, invoiceNo: 'B-1', invoiceDate: new Date(), currency: 'TRY', sourceFileId: file.id, mapping: {}, totals: { lines: 0 }, isSample: true },
      });
    });

    await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: b.auth, payload: { step: 'ozet' } });
    const pa = await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { step: 'faturalar' } });
    expect(pa.statusCode).toBe(200);
    // B'nin örnek faturası, ilerlemesi ve taşıyıcısı A'ya görünmez
    expect(pa.json().invoices).toEqual([]);
    expect(pa.json().state.step).toBe('faturalar');
    expect(pa.json().carriers).toEqual([]);
    const sb = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: b.auth })).json();
    expect(sb.state.step).toBe('ozet');

    // kendi örnek faturası özetiyle listelenir; silinince listeden düşer
    expect(sb.invoices).toEqual([expect.objectContaining({ id: invB.id, invoiceNo: 'B-1', carrier: expect.objectContaining({ name: 'UPS' }) })]);
    await inCompany(b.auth, () => prisma.invoice.update({ where: { id: invB.id }, data: { deletedAt: new Date() } }));
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: b.auth })).json().invoices).toEqual([]);
    expect(companyA).not.toBe(companyB);
  });

  it('eski adım adı "kalibrasyon" kayıtlı ilerlemede "faturalar" olarak okunur', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Kurulum Eski Adım');
    const { companyId } = a;
    const c = await inCompany(a.auth, () => prisma.company.findUniqueOrThrow({ where: { id: companyId } }));
    const settings = { ...(c.settings as Record<string, unknown>), onboarding: { step: 'kalibrasyon', done: ['sirket', 'kalibrasyon'], skipped: ['kalibrasyon'] } };
    await inCompany(a.auth, () => prisma.company.update({ where: { id: companyId }, data: { settings } }));
    const s = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: a.auth })).json();
    expect(s.state.step).toBe('faturalar');
    expect(s.state.done).toEqual(['sirket', 'faturalar']);
    expect(s.state.skipped).toEqual(['faturalar']);
  });

  // GEÇİCİ (deneme dönemi) özellikle birlikte kaldırılır.
  it('Sistemi sıfırla kurulumu baştan başlatır; Örnek verileri yükle tamamlanmış sayar', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Kurulum Sıfırlama');
    await app.inject({ method: 'PATCH', url: '/api/deciship/settings/onboarding', headers: a.auth, payload: { step: 'olcum', done: 'sirket', complete: true } });

    const samples = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true, samples: true } });
    expect(samples.statusCode).toBe(200);
    const s1 = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: a.auth })).json();
    expect(s1).toMatchObject({ completed: true, required: false, showBanner: false });

    const reset = await app.inject({ method: 'POST', url: '/api/deciship/settings/data/reset', headers: a.auth, payload: { confirm: true } });
    expect(reset.statusCode).toBe(200);
    const s2 = (await app.inject({ method: 'GET', url: '/api/deciship/settings/onboarding', headers: a.auth })).json();
    expect(s2).toMatchObject({ completed: false, required: true, showBanner: true, carriers: [] });
    expect(s2.state).toMatchObject({ done: [], skipped: [] });
    expect(s2.state.step).toBeUndefined();
    // diğer ayarlar korunur
    expect((await app.inject({ method: 'GET', url: '/api/deciship/settings', headers: a.auth })).json().desiDivisor).toBe(3000);
  });
});

describe('kurulum tamam: tek tanım (/me, /settings/onboarding, Merkez)', () => {
  const API = '/api/deciship';
  const read = async (auth: { authorization: string }) => {
    const app = await getApp();
    const get = async (url: string) => (await app.inject({ method: 'GET', url: `${API}${url}`, headers: auth })).json();
    const [me, status, overview] = await Promise.all([get('/me'), get('/settings/onboarding'), get('/platform/overview')]);
    return { me: me.onboarding, status: { completed: status.completed, required: status.required, showBanner: status.showBanner }, setup: overview.setup };
  };
  const expectFlags = async (auth: { authorization: string }, flags: { completed: boolean; required: boolean; showBanner: boolean }) => {
    const r = await read(auth);
    expect(r.me).toEqual(flags);
    expect(r.status).toEqual(flags);
    expect(r.setup.completed).toBe(flags.completed);
    expect(Boolean(r.setup.label)).toBe(!flags.completed);
    return r;
  };

  it('hiçbir şey yok: tamamlanmadı, /setup yönlendirmesi sürer', async () => {
    const a = await registerCompany(await getApp(), uniq('Boş '));
    await expectFlags(a.auth, { completed: false, required: true, showBanner: true });
  });

  it('taşıyıcı var, gerisi yok, sihirbaz açılmadı: tamamlanmadı; yönlendirme ve bant yok; Merkez de tamamlanmadı der', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Taşıyıcı '));
    await app.inject({ method: 'POST', url: `${API}/carriers`, headers: a.auth, payload: { code: 'aras', name: 'Aras' } });
    await expectFlags(a.auth, { completed: false, required: false, showBanner: false });
  });

  it('zorunlu adımların hepsi veride: sihirbaz bitmese de tamam; ilk fatura silinirse tamam olmaktan çıkar', async () => {
    const app = await getApp();
    const f = await companyFixture(app);
    const r = await expectFlags(f.admin.auth, { completed: true, required: false, showBanner: false });
    expect(r.setup.steps.filter((s: { required: boolean }) => s.required).every((s: { done: boolean }) => s.done)).toBe(true);
    const del = await app.inject({ method: 'DELETE', url: `${API}/invoices/${f.invoiceId}`, headers: f.admin.auth });
    expect(del.statusCode).toBe(204);
    await expectFlags(f.admin.auth, { completed: false, required: false, showBanner: false });
  });

  it('sihirbaz tamamlandı: veri eksik olsa da tamam', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Sihirbaz '));
    const done = await app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: a.auth, payload: { complete: true } });
    expect(done.statusCode, done.body).toBe(200);
    await expectFlags(a.auth, { completed: true, required: false, showBanner: false });
  });

  it('Merkez onayı yoksa sihirbaz tamamlanmış olsa da tamam değil; onay gelince tamam', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Onaysız '), { realDefaults: true });
    const done = await app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: a.auth, payload: { complete: true } });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().state.completedAt).toBeTruthy();
    const r = await expectFlags(a.auth, { completed: false, required: true, showBanner: true });
    // Merkez overview'da firma adımı yok: Merkez onayı kendi panelinde gösterir.
    expect(r.setup.steps.map((s: { id: string }) => s.id)).not.toContain('company');
    expect((await sendEvent(app, orgUpdated(a.companyId, 1, { companyConfirmed: true }))).statusCode).toBe(200);
    await expectFlags(a.auth, { completed: true, required: false, showBanner: false });
  });

  it('ölçüm kuralları: kenar toleransının iki varsayılanı (yeni 0,5, eski 1, kayıtsız) "dokunulmadı"; başka değer hazır sayılır', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Kurallar '), { realDefaults: true });
    const rulesDone = async () => {
      const o = (await app.inject({ method: 'GET', url: `${API}/platform/overview`, headers: a.auth })).json();
      return o.setup.steps.find((s: { id: string }) => s.id === 'measure-rules').done as boolean;
    };
    const writeEdge = (edgeTolCm: number | undefined) =>
      withCompany(a.companyId, async () => {
        const { edgeTolCm: _old, ...rest } = (await prisma.company.findFirstOrThrow({ where: { id: a.companyId } })).settings as Record<string, unknown>;
        await prisma.company.update({ where: { id: a.companyId }, data: { settings: edgeTolCm === undefined ? rest : { ...rest, edgeTolCm } } as never });
      });
    expect((await storedSettings(a.companyId)).edgeTolCm).toBe(0.5);
    expect(await rulesDone()).toBe(false);
    await writeEdge(1);
    expect(await rulesDone()).toBe(false);
    await writeEdge(undefined);
    expect(await rulesDone()).toBe(false);
    const patched = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { edgeTolCm: 0.7 } });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await rulesDone()).toBe(true);
  });

  it('zorunlu adımların hepsi veride ama Merkez onayı geri "bekliyor" derse tamam olmaktan çıkar', async () => {
    const app = await getApp();
    const f = await companyFixture(app);
    await expectFlags(f.admin.auth, { completed: true, required: false, showBanner: false });
    await sendEvent(app, orgUpdated(f.admin.companyId, 1, { companyConfirmed: false }));
    await expectFlags(f.admin.auth, { completed: false, required: false, showBanner: false });
    await sendEvent(app, orgUpdated(f.admin.companyId, 2, { companyConfirmed: true }));
    await expectFlags(f.admin.auth, { completed: true, required: false, showBanner: false });
  });
});

describe('Merkez firma onayı (org.updated companyConfirmed)', () => {
  const API = '/api/deciship';
  const status = async (auth: { authorization: string }) => {
    const app = await getApp();
    return (await app.inject({ method: 'GET', url: `${API}/settings/onboarding`, headers: auth })).json();
  };

  it('yeni firma onaysız açılır; kurulum yanıtı firmanın DeciShip kopyasını taşır', async () => {
    const app = await getApp();
    const a = await registerCompany(app, 'Onay Yeni', { realDefaults: true });
    expect((await storedSettings(a.companyId)).companyConfirmed).toBe(false);
    expect((await status(a.auth)).company).toEqual({ name: 'Onay Yeni', currency: 'TRY', country: null, timeZone: 'Europe/Istanbul', confirmed: false });
    await sendEvent(app, orgUpdated(a.companyId, 1, { name: 'Onay Yeni', currency: 'USD', country: 'US', companyConfirmed: true }));
    expect((await status(a.auth)).company).toEqual({ name: 'Onay Yeni', currency: 'USD', country: 'US', timeZone: 'Europe/Istanbul', confirmed: true });
  });

  it('olayla açılan firma da onaysız açılır; ilk olay onaylı derse onaylı', async () => {
    const app = await getApp();
    const plain = crypto.randomUUID();
    expect((await sendEvent(app, orgUpdated(plain, 1))).statusCode).toBe(200);
    expect((await storedSettings(plain)).companyConfirmed).toBe(false);
    const confirmed = crypto.randomUUID();
    await sendEvent(app, orgUpdated(confirmed, 1, { companyConfirmed: true }));
    expect((await storedSettings(confirmed)).companyConfirmed).toBe(true);
    // üye olayı firmayı önce açarsa da onaysız (olay sırası garantisiz)
    const viaMember = crypto.randomUUID();
    const m = await sendEvent(app, { eventId: crypto.randomUUID(), type: 'member.upserted', orgId: viaMember, product: 'deciship', membershipId: crypto.randomUUID(), personId: crypto.randomUUID(), name: 'Üye', orgRole: 'MEMBER', role: 'ADMIN', active: true, epoch: 1 } as PlatformEvent);
    expect(m.statusCode, m.body).toBe(200);
    expect((await storedSettings(viaMember)).companyConfirmed).toBe(false);
  });

  it('true ve false yazılır; alan yoksa ya da bozuksa kayıtlı değer kalır, ad yine işlenir; eski ve sürümsüz olay ezmez', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Onay Sıra '), { realDefaults: true });
    const stored = async () => (await storedSettings(a.companyId)).companyConfirmed;
    const confirmed = async () => (await status(a.auth)).company.confirmed;

    await sendEvent(app, orgUpdated(a.companyId, 1, { name: 'Ad 1' }));
    expect(await stored()).toBe(false);
    for (const [i, bad] of (['yes', 1, null, 'true', {}] as unknown[]).entries()) {
      const r = await sendEvent(app, orgUpdated(a.companyId, 2 + i, { name: `Bozuk ${i}`, companyConfirmed: bad }));
      expect(r.statusCode, r.body).toBe(200);
      expect(await stored()).toBe(false);
    }
    expect((await status(a.auth)).company.name).toBe('Bozuk 4');

    await sendEvent(app, orgUpdated(a.companyId, 10, { companyConfirmed: true }));
    expect(await stored()).toBe(true);
    expect(await confirmed()).toBe(true);
    await sendEvent(app, orgUpdated(a.companyId, 11, { name: 'Alan yok' }));
    expect(await stored()).toBe(true);

    const late = await sendEvent(app, orgUpdated(a.companyId, 5, { companyConfirmed: false }));
    expect(late.json()).toEqual({ ok: true, outcome: 'stale' });
    expect(await stored()).toBe(true);
    await sendEvent(app, orgUpdated(a.companyId, undefined, { companyConfirmed: false }));
    expect(await stored()).toBe(true);

    await sendEvent(app, orgUpdated(a.companyId, 12, { companyConfirmed: false }));
    expect(await stored()).toBe(false);
    expect(await confirmed()).toBe(false);
  });

  it('kayıtlı değer yok (bu alandan önce açılmış firma): onaylı sayılır', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Onay Eski '), { realDefaults: true });
    const { companyConfirmed: _drop, ...rest } = await storedSettings(a.companyId);
    await inCompany(a.auth, () => prisma.company.update({ where: { id: a.companyId }, data: { settings: rest as object } }));
    expect((await status(a.auth)).company.confirmed).toBe(true);
    await app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: a.auth, payload: { complete: true } });
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: a.auth })).json().onboarding.completed).toBe(true);
    // alanı taşımayan eski biçim olay da bir şey yazmaz
    await sendEvent(app, orgUpdated(a.companyId, 1));
    expect(await storedSettings(a.companyId)).not.toHaveProperty('companyConfirmed');
  });

  it('PATCH /settings onayı yazamaz; ayar yanıtları onayı taşımaz', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Onay Yazma '), { realDefaults: true });
    for (const companyConfirmed of [true, false]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { companyConfirmed } });
      expect(r.statusCode).toBe(400);
    }
    expect((await storedSettings(a.companyId)).companyConfirmed).toBe(false);
    const ok = await app.inject({ method: 'PATCH', url: `${API}/settings`, headers: a.auth, payload: { desiDivisor: 4000 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).not.toHaveProperty('companyConfirmed');
    expect((await storedSettings(a.companyId)).companyConfirmed).toBe(false);
    expect((await app.inject({ method: 'GET', url: `${API}/settings`, headers: a.auth })).json()).not.toHaveProperty('companyConfirmed');
    expect((await app.inject({ method: 'GET', url: `${API}/me`, headers: a.auth })).json().company.settings).not.toHaveProperty('companyConfirmed');
  });

  // GEÇİCİ (deneme dönemi) veri sıfırlamayla birlikte kaldırılır.
  it('veri sıfırlama ve örnek veri onayı korur: onaysız firma örnek veriyle de tamamlanmış sayılmaz', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Onay Sıfırlama '), { realDefaults: true });
    const samples = await app.inject({ method: 'POST', url: `${API}/settings/data/reset`, headers: a.auth, payload: { confirm: true, samples: true } });
    expect(samples.statusCode, samples.body).toBe(200);
    expect((await storedSettings(a.companyId)).companyConfirmed).toBe(false);
    expect(await status(a.auth)).toMatchObject({ completed: false, company: { confirmed: false } });
    await sendEvent(app, orgUpdated(a.companyId, 1, { companyConfirmed: true }));
    const reset = await app.inject({ method: 'POST', url: `${API}/settings/data/reset`, headers: a.auth, payload: { confirm: true } });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await storedSettings(a.companyId)).companyConfirmed).toBe(true);
  });

  it('eski kayıt: "sirket" adımı okunur ve kabul edilir ama hiçbir kurala girmez', async () => {
    const app = await getApp();
    const a = await registerCompany(app, uniq('Onay Eski Adım '));
    const settings = { ...(await storedSettings(a.companyId)), onboarding: { step: 'sirket', done: ['sirket'], skipped: [] } };
    await inCompany(a.auth, () => prisma.company.update({ where: { id: a.companyId }, data: { settings } }));
    const s = await status(a.auth);
    expect(s.state).toMatchObject({ step: 'sirket', done: ['sirket'], skipped: [] });
    expect(s).toMatchObject({ completed: false, required: true });
    // eski istemci: firma adımını atla / onayla isteği 400 almaz
    for (const payload of [{ skipped: 'sirket' }, { done: 'sirket', step: 'sirket' }]) {
      const r = await app.inject({ method: 'PATCH', url: `${API}/settings/onboarding`, headers: a.auth, payload });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json().completed).toBe(false);
    }
  });
});
