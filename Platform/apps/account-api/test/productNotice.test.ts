// Araç bildirimi ucu (Mesaj 14 §4.5): `POST /api/account/internal/notify`. Güvenlik sınırı: kimlik, gövde, alıcı, tavan, kaçış.
import crypto from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NOTICE_LIMITS, NOTICE_RESEND_AFTER_MINUTES, NOTIFY_PATH, type NoticeText } from '@sellerondata/contracts';
import { prisma } from '../src/db.ts';
import { PRODUCT_LAUNCH_ENV } from '../src/lib/launch.ts';
import { configureMailer, flushMail, type MailMessage } from '../src/lib/mailer.ts';
import { runMaintenance } from '../src/lib/maintenance.ts';
import { noticeBodyHash, productForSecret } from '../src/lib/productNotice.ts';

/** Bu adreslerin postası kurulurken hata atılır (alıcı başına hata yalıtımı testi); diğer herkes için gerçek işlev. */
const failingMail = vi.hoisted(() => new Set<string>());
vi.mock('../src/lib/mailer.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/mailer.ts')>();
  return {
    ...real,
    productNoticeMail: (...args: Parameters<typeof real.productNoticeMail>) => {
      if (failingMail.has(args[0])) throw new Error('posta kurulamadı (test)');
      return real.productNoticeMail(...args);
    },
  };
});
import { addMember, errorCode, getApp, randomIp, randomTrPhone, registerOrg, uniq, type Ctx } from './helpers.ts';
import { TEST_ORIGIN } from './testEnv.ts';

const SECRET = crypto.randomBytes(24).toString('hex');
const OTHER_SECRET = crypto.randomBytes(24).toString('hex');
const PERMISSION = 'deciship.disputes.manage';

let app: FastifyInstance;
const savedSecrets = process.env.PRODUCT_NOTIFY_SECRETS;
const savedLaunch = process.env[PRODUCT_LAUNCH_ENV];

beforeAll(async () => {
  process.env.PRODUCT_NOTIFY_SECRETS = `deciship=${SECRET},orderloom=${OTHER_SECRET}`;
  app = await getApp();
});

afterEach(async () => {
  await flushMail();
  configureMailer();
  process.env.PRODUCT_NOTIFY_SECRETS = `deciship=${SECRET},orderloom=${OTHER_SECRET}`;
  if (savedLaunch === undefined) delete process.env[PRODUCT_LAUNCH_ENV];
  else process.env[PRODUCT_LAUNCH_ENV] = savedLaunch;
  failingMail.clear();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (savedSecrets === undefined) delete process.env.PRODUCT_NOTIFY_SECRETS;
  else process.env.PRODUCT_NOTIFY_SECRETS = savedSecrets;
});

function text(lang: 'tr' | 'en', over: Partial<NoticeText> = {}): NoticeText {
  return {
    subject: lang === 'tr' ? 'İtiraz için son gün yarın' : 'Last day to dispute is tomorrow',
    lines: [lang === 'tr' ? 'Faturada 3 satırda fark var.' : '3 lines have discrepancies.'],
    action: { label: lang === 'tr' ? 'Faturayı aç' : 'Open invoice', path: '/deciship/invoices/abc' },
    footer: lang === 'tr' ? "Bu hatırlatmaları DeciShip › Ayarlar'dan kapatabilirsiniz." : 'You can turn these reminders off in DeciShip › Settings.',
    ...over,
  };
}

function body(orgId: string, over: Record<string, unknown> = {}) {
  return {
    product: 'deciship',
    orgId,
    dedupeKey: `ttk3:${uniq()}`,
    audience: { permission: PERMISSION },
    message: { tr: text('tr'), en: text('en') },
    ...over,
  };
}

function notify(payload: unknown, headers: Record<string, string> = { authorization: `Bearer ${SECRET}` }) {
  return app.inject({
    method: 'POST',
    url: NOTIFY_PATH,
    remoteAddress: randomIp(),
    headers,
    ...(typeof payload === 'string' ? { payload, headers: { ...headers, 'content-type': 'application/json' } } : { payload: payload as object }),
  });
}

const verify = (personId: string) => prisma.person.update({ where: { id: personId }, data: { emailVerifiedAt: new Date() } });

/** Firma + doğrulanmış e-postalı sahip (DeciShip ADMIN: itiraz izni var). */
/** Kayıt doğrulama postası (`email_verify`) burada boşaltılır: sonraki `captureMail` onu yakalamasın. */
async function firm(): Promise<Ctx> {
  const owner = await registerOrg(app);
  await verify(owner.personId);
  await flushMail();
  return owner;
}

/**
 * Bu kişiye giden ARAÇ BİLDİRİMİ postaları. Kayıt sırasında doğrulama postası (`email_verify`) da `MailLog`'a düşer; o bu
 * testlerin konusu değildir (CI'da her sayımı bir fazla gösteriyordu), şablonla süzülür.
 */
const NOTICE_TEMPLATE = 'product_notice:deciship';
const mailsTo = async (to: string | null) => {
  await flushMail();
  return to ? prisma.mailLog.findMany({ where: { to, template: NOTICE_TEMPLATE }, orderBy: { createdAt: 'asc' } }) : [];
};
const noticeCount = (orgId: string) => prisma.productNotice.count({ where: { orgId } });

/** Gönderilen iletiyi HTML'iyle yakalar (`MailLog` yalnız düz metni tutar). */
function captureMail() {
  const sent: MailMessage[] = [];
  configureMailer({ mailer: { send: async (m: MailMessage) => void sent.push(m) } });
  return sent;
}

describe('kimlik: ürün anahtarı', () => {
  it('anahtar yok, yanlış, eksik, fazla, başka şema, kullanıcı jetonu ya da çerez: 401, iz yok, anahtar yanıtta yok', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    const cases: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${crypto.randomBytes(24).toString('hex')}` },
      { authorization: `Bearer ${SECRET.slice(0, -1)}` },
      { authorization: `Bearer ${SECRET}x` },
      { authorization: `Basic ${SECRET}` },
      { authorization: SECRET },
      { authorization: 'Bearer ' },
      owner.headers,
      { cookie: `sod_at=${owner.accessToken}`, 'x-sod-csrf': '1', origin: TEST_ORIGIN, 'x-sod-org': owner.orgId },
    ];
    for (const headers of cases) {
      const res = await notify(payload, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(401);
      expect(errorCode(res)).toBe('UNAUTHORIZED');
      expect(res.body).not.toContain(SECRET);
    }
    expect(await noticeCount(owner.orgId)).toBe(0);
    expect(await mailsTo(owner.email)).toHaveLength(0);
  });

  it('kimliksiz istek gövde hatasını öğrenmez: bozuk JSON ve boş gövde de 401', async () => {
    expect((await notify('{bozuk', {})).statusCode).toBe(401);
    expect((await notify({}, {})).statusCode).toBe(401);
    expect((await notify('{bozuk')).statusCode).toBe(400);
  });

  it('şema adı büyük/küçük harf duyarsız; doğru anahtar geçer', async () => {
    const owner = await firm();
    const res = await notify(body(owner.orgId), { authorization: `bearer ${SECRET}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('queued');
  });

  it('anahtar haritası boşsa uç kapalı: her istek 401', async () => {
    const owner = await firm();
    process.env.PRODUCT_NOTIFY_SECRETS = '';
    const res = await notify(body(owner.orgId));
    expect(res.statusCode).toBe(401);
    expect(await noticeCount(owner.orgId)).toBe(0);
  });

  it('bir araç başka aracın adına ya da izniyle isteyemez', async () => {
    const owner = await firm();
    // orderloom anahtarı, deciship adına: 401 (ürün anahtardan gelir).
    const asOther = await notify(body(owner.orgId), { authorization: `Bearer ${OTHER_SECRET}` });
    expect(asOther.statusCode).toBe(401);
    // orderloom anahtarı, kendi adına ama deciship izniyle ve deciship yoluyla: 400.
    const foreignPermission = await notify(
      body(owner.orgId, {
        product: 'orderloom',
        message: { tr: text('tr', { action: { label: 'Aç', path: '/orderloom/x' } }), en: text('en', { action: { label: 'Open', path: '/orderloom/x' } }) },
      }),
      { authorization: `Bearer ${OTHER_SECRET}` },
    );
    expect(foreignPermission.statusCode).toBe(400);
    expect(errorCode(foreignPermission)).toBe('VALIDATION');
    // deciship anahtarı, orderloom ya da kayıtta olmayan ürün adına ya da ürünsüz: 401 (gövde doğrulamasından önce).
    for (const product of ['orderloom', 'nope', undefined]) {
      const claimOther = await notify(body(owner.orgId, { product, audience: { permission: 'orderloom.x' } }));
      expect(claimOther.statusCode, String(product)).toBe(401);
    }
    expect(await noticeCount(owner.orgId)).toBe(0);
    expect(await mailsTo(owner.email)).toHaveLength(0);
  });

  it('karşılaştırma sabit süreli: her anahtar timingSafeEqual ile, eşleşmede ya da uzunluk farkında erken çıkış yok', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');
    const secrets = new Map([
      ['deciship', SECRET],
      ['orderloom', OTHER_SECRET],
    ] as const);
    for (const [presented, expected] of [
      [SECRET, 'deciship'],
      [OTHER_SECRET, 'orderloom'],
      ['kisa', null],
      [`${SECRET}${SECRET}`, null],
      [SECRET.slice(0, -1), null],
    ] as const) {
      spy.mockClear();
      expect(productForSecret(presented, secrets)).toBe(expected);
      expect(spy).toHaveBeenCalledTimes(secrets.size);
      // Özetler eşit uzunlukta: timingSafeEqual uzunluk farkında atmaz, uzunluk da sızmaz.
      for (const [a, b] of spy.mock.calls) expect((a as Buffer).length).toBe((b as Buffer).length);
    }
  });
});

describe('gövde', () => {
  it('sözleşme dışı gövde 400 VALIDATION; satır yazılmaz, posta gitmez', async () => {
    const owner = await firm();
    const o = owner.orgId;
    const withTr = (over: Partial<NoticeText>) => body(o, { message: { tr: text('tr', over), en: text('en') } });
    const withPath = (path: string) => withTr({ action: { label: 'Aç', path } });
    const bad: [string, unknown][] = [
      ['bilinmeyen alan (alıcı adresi taşınamaz)', { ...body(o), to: 'saldirgan@x.co' }],
      ['orgId uuid değil', body(o, { orgId: 'firma-1' })],
      ['dedupeKey boşluklu', body(o, { dedupeKey: 'ttk3 abc' })],
      ['dedupeKey uzun', body(o, { dedupeKey: 'a'.repeat(NOTICE_LIMITS.dedupeKey + 1) })],
      ['izin öneki başka ürün', body(o, { audience: { permission: 'orderloom.disputes.manage' } })],
      ['izin katalogda yok', body(o, { audience: { permission: 'deciship.nope' } })],
      ['izin alanı fazla', body(o, { audience: { permission: PERMISSION, emails: ['x@y.co'] } })],
      ['İngilizce metin yok', body(o, { message: { tr: text('tr') } })],
      ['fazladan dil', body(o, { message: { tr: text('tr'), en: text('en'), de: text('en') } })],
      ['metinde html alanı', withTr({ html: '<b>x</b>' } as Partial<NoticeText>)],
      ['satır yok', withTr({ lines: [] })],
      ['satır çok', withTr({ lines: Array.from({ length: NOTICE_LIMITS.linesMax + 1 }, () => 'x') })],
      ['satır uzun', withTr({ lines: ['x'.repeat(NOTICE_LIMITS.line + 1)] })],
      ['konu uzun', withTr({ subject: 'x'.repeat(NOTICE_LIMITS.subject + 1) })],
      ['konu boş', withTr({ subject: '   ' })],
      ['konuda satır sonu (başlık enjeksiyonu)', withTr({ subject: 'Konu\r\nBcc: x@y.co' })],
      ['satırda denetim karakteri', withTr({ lines: ['a\u0007b'] })],
      ['satırda yön karakteri', withTr({ lines: [`fatura ${String.fromCharCode(0x202e)}exe.pdf`] })],
      ['konuda sıfır genişlikli boşluk', withTr({ subject: `Ko${String.fromCharCode(0x200b)}nu` })],
      ['konuda satır ayırıcı', withTr({ subject: `Konu${String.fromCharCode(0x2028)}Bcc: x@y.co` })],
      ['satırda bağlantı (http)', withTr({ lines: ['Buraya girin: http://kotu.example'] })],
      ['satırda bağlantı (www)', withTr({ lines: ['www.kotu.example'] })],
      ['dipnotta bağlantı', withTr({ footer: 'bkz //kotu.example ://' })],
      ['düğme etiketi uzun', withTr({ action: { label: 'x'.repeat(NOTICE_LIMITS.actionLabel + 1), path: '/deciship/x' } })],
      ['yol tam adres', withPath('https://kotu.example/deciship/')],
      ['yol protokolsüz adres', withPath('//kotu.example/deciship/')],
      ['yol başka araç', withPath('/orderloom/x')],
      ['yol Merkez', withPath('/home')],
      ['yol önek eksik', withPath('/decishipx/a')],
      ['yol üst klasör', withPath('/deciship/../account')],
      ['yol çift bölü', withPath('/deciship//kotu.example')],
      ['yol boşluk', withPath('/deciship/a b')],
      ['yol açı ayracı', withPath('/deciship/<x>')],
      ['yol kare', withPath('/deciship/x#frag')],
      ['yol ters bölü', withPath('/deciship/\\kotu.example')],
      ['yol uzun', withPath(`/deciship/${'a'.repeat(NOTICE_LIMITS.actionPath)}`)],
      ['gövde 16 KB üstü', { ...body(o), pad: 'x'.repeat(NOTICE_LIMITS.bodyBytes) }],
    ];
    for (const [name, payload] of bad) {
      const res = await notify(payload);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(400);
      expect(errorCode(res), name).toBe('VALIDATION');
    }
    expect(await noticeCount(o)).toBe(0);
    expect(await mailsTo(owner.email)).toHaveLength(0);
  });

  it('günlük özet boyu geçer: en çok NOTICE_LIMITS.linesMax satır (DeciShip 9 satır kullanır)', async () => {
    const owner = await firm();
    const lines = Array.from({ length: NOTICE_LIMITS.linesMax }, (_, i) => `Aras Kargo F${i} (10 Kasım 2026): son gün 18 Kasım 2026`);
    const res = await notify(body(owner.orgId, { message: { tr: text('tr', { lines }), en: text('en', { lines }) } }));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().status).toBe('queued');
  });

  it('eylemsiz ve dipnotsuz ileti geçer: düğme yok, sabit kaynak satırı var', async () => {
    const owner = await firm();
    const sent = captureMail();
    const bare = { subject: 'Konu', lines: ['Tek satır'] };
    const res = await notify(body(owner.orgId, { message: { tr: bare, en: bare } }));
    expect(res.json()).toEqual({ status: 'queued', recipients: 1 });
    await flushMail();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html).not.toContain('<a ');
    expect(sent[0]!.text).toContain('DeciShip');
  });

  it('firma yoksa 404 ORG_NOT_FOUND', async () => {
    const res = await notify(body(crypto.randomUUID()));
    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('ORG_NOT_FOUND');
  });
});

describe('alıcılar', () => {
  it('yalnız etkin, askıda olmayan, doğrulanmış e-postalı ve izni veren roldeki üyeler; yanıtta yalnız sayı', async () => {
    const owner = await firm(); // ADMIN: izin var
    const o = owner.orgId;
    const accountingEn = await addMember(app, o, { deciship: 'ACCOUNTING' });
    await prisma.person.update({ where: { id: accountingEn.personId }, data: { emailVerifiedAt: new Date(), locale: 'en' } });

    const unverified = await addMember(app, o, { deciship: 'ACCOUNTING' });
    const suspendedMembership = await addMember(app, o, { deciship: 'ACCOUNTING' });
    await verify(suspendedMembership.personId);
    await prisma.membership.update({ where: { id: suspendedMembership.membershipId }, data: { status: 'SUSPENDED' } });
    const suspendedPerson = await addMember(app, o, { deciship: 'ACCOUNTING' });
    await prisma.person.update({ where: { id: suspendedPerson.personId }, data: { emailVerifiedAt: new Date(), suspendedAt: new Date() } });
    const auditor = await addMember(app, o, { deciship: 'AUDITOR' }); // itiraz izni yok
    await verify(auditor.personId);
    const measure = await addMember(app, o, { deciship: 'MEASURE' });
    await verify(measure.personId);
    const noRole = await addMember(app, o, { orgRole: 'ADMIN' }); // firma yöneticisi ama DeciShip rolü yok
    await verify(noRole.personId);
    const phoneOnly = await addMember(app, o, { email: null, phone: randomTrPhone(), deciship: 'ADMIN' });
    const stranger = await firm(); // başka firmanın ADMIN'i

    const res = await notify(body(o));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'queued', recipients: 2 });
    for (const who of [owner, accountingEn, unverified, suspendedMembership, suspendedPerson, auditor, noRole, stranger]) {
      expect(res.body).not.toContain(who.email as string);
    }

    const ownerMail = await mailsTo(owner.email);
    expect(ownerMail).toHaveLength(1);
    expect(ownerMail[0]!.subject).toBe(text('tr').subject);
    const enMail = await mailsTo(accountingEn.email);
    expect(enMail).toHaveLength(1);
    expect(enMail[0]!.subject).toBe(text('en').subject);
    for (const who of [unverified, suspendedMembership, suspendedPerson, auditor, measure, noRole, stranger]) {
      expect(await mailsTo(who.email), who.email ?? '').toHaveLength(0);
    }
    expect(phoneOnly.email).toBeNull();
    const row = await prisma.productNotice.findFirstOrThrow({ where: { orgId: o } });
    expect(row).toMatchObject({ product: 'deciship', recipients: 2 });
  });

  it('bir alıcının postası kurulamazsa kalan alıcılar yine kuyruğa girer; yanıt ve iz değişmez', async () => {
    const owner = await firm();
    const second = await addMember(app, owner.orgId, { deciship: 'ACCOUNTING' });
    await verify(second.personId);
    failingMail.add(owner.email as string);
    const res = await notify(body(owner.orgId));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ status: 'queued', recipients: 2 });
    expect(await mailsTo(owner.email)).toHaveLength(0);
    expect(await mailsTo(second.email)).toHaveLength(1);
    expect(await noticeCount(owner.orgId)).toBe(1);
  });

  it('uygun alıcı yoksa no_recipients ve iz kalmaz: alıcı sonra doğrulanınca aynı anahtar gider', async () => {
    const owner = await registerOrg(app); // e-posta doğrulanmamış
    const payload = body(owner.orgId);
    expect((await notify(payload)).json()).toEqual({ status: 'no_recipients', recipients: 0 });
    expect(await noticeCount(owner.orgId)).toBe(0);
    await verify(owner.personId);
    expect((await notify(payload)).json()).toEqual({ status: 'queued', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(1);
  });
});

describe('abonelik ve araç durumu', () => {
  it('abonelik salt okunur, iptal ya da yoksa disabled; satır ve posta yok', async () => {
    for (const change of ['READ_ONLY', 'CANCELED', 'DELETE'] as const) {
      const owner = await firm();
      const where = { orgId_product: { orgId: owner.orgId, product: 'deciship' } };
      if (change === 'DELETE') await prisma.subscription.delete({ where });
      else
        await prisma.subscription.update({
          where,
          data: { status: change, ...(change === 'CANCELED' ? { canceledAt: new Date(), deleteAfter: new Date(Date.now() + 86_400_000) } : {}) },
        });
      const res = await notify(body(owner.orgId));
      expect(res.json(), change).toEqual({ status: 'disabled', recipients: 0 });
      expect(await noticeCount(owner.orgId)).toBe(0);
      expect(await mailsTo(owner.email)).toHaveLength(0);
    }
  });

  it('araç kapalıysa (PRODUCT_LAUNCH=off) disabled', async () => {
    const owner = await firm();
    process.env[PRODUCT_LAUNCH_ENV] = 'deciship=off';
    expect((await notify(body(owner.orgId))).json()).toEqual({ status: 'disabled', recipients: 0 });
    expect(await mailsTo(owner.email)).toHaveLength(0);
  });
});

describe('tekrar anahtarı ve günlük tavan', () => {
  it('aynı anahtar ikinci kez duplicate, posta bir kez; başka firmada aynı anahtar ayrıdır', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    expect((await notify(payload)).json()).toEqual({ status: 'queued', recipients: 1 });
    expect((await notify(payload)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(1);
    const other = await firm();
    expect((await notify({ ...payload, orgId: other.orgId })).json()).toEqual({ status: 'queued', recipients: 1 });
  });

  it('eşzamanlı aynı anahtar: tek ileti, tek posta', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    const results = await Promise.all(Array.from({ length: 6 }, () => notify(payload)));
    const statuses = results.map((r) => r.json().status).sort();
    expect(statuses).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'queued']);
    expect(await noticeCount(owner.orgId)).toBe(1);
    expect(await mailsTo(owner.email)).toHaveLength(1);
  });

  it('firma başına 24 saatte en çok 30 ileti: eskiler ve başka ürün sayılmaz; aşınca limited, posta yok', async () => {
    const owner = await firm();
    const o = owner.orgId;
    const hourAgo = new Date(Date.now() - 3_600_000);
    await prisma.productNotice.createMany({
      data: [
        ...Array.from({ length: NOTICE_LIMITS.perOrgPerDay - 1 }, () => ({ product: 'deciship', orgId: o, dedupeKey: uniq('eski'), recipients: 1, createdAt: hourAgo })),
        { product: 'deciship', orgId: o, dedupeKey: uniq('dun'), recipients: 1, createdAt: new Date(Date.now() - 25 * 3_600_000) },
        { product: 'orderloom', orgId: o, dedupeKey: uniq('baska'), recipients: 1, createdAt: hourAgo },
      ],
    });
    expect((await notify(body(o))).json()).toEqual({ status: 'queued', recipients: 1 });
    const over = body(o);
    expect((await notify(over)).json()).toEqual({ status: 'limited', recipients: 0 });
    expect(await mailsTo(owner.email)).toHaveLength(1);
    // Tavan iz bırakmaz: süre açılınca aynı anahtar gönderilebilir.
    expect(await prisma.productNotice.count({ where: { orgId: o, dedupeKey: over.dedupeKey } })).toBe(0);
  });

  it('bakım işi 30 günden eski bildirim izini siler, yenisine dokunmaz', async () => {
    const owner = await firm();
    const o = owner.orgId;
    const now = new Date();
    const old = uniq('eski');
    const recent = uniq('yeni');
    await prisma.productNotice.createMany({
      data: [
        { product: 'deciship', orgId: o, dedupeKey: old, recipients: 1, createdAt: new Date(now.getTime() - 31 * 86_400_000) },
        { product: 'deciship', orgId: o, dedupeKey: recent, recipients: 1, createdAt: new Date(now.getTime() - 29 * 86_400_000) },
      ],
    });
    await runMaintenance(now);
    const keys = (await prisma.productNotice.findMany({ where: { orgId: o }, select: { dedupeKey: true } })).map((r) => r.dedupeKey);
    expect(keys).toEqual([recent]);
  });

  it('gönderim bitince sentAt yazılır; yeni denemede sentAt boş olsa da duplicate (gönderim sürüyor olabilir)', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    expect((await notify(payload)).json()).toEqual({ status: 'queued', recipients: 1 });
    await flushMail();
    const row = await prisma.productNotice.findFirstOrThrow({ where: { orgId: owner.orgId, dedupeKey: payload.dedupeKey } });
    expect(row.sentAt).not.toBeNull();
    // Deneme anı ve gövde özeti yazıldı (deneme anı veritabanı saatiyle).
    expect(row.attemptedAt).not.toBeNull();
    expect(row.bodyHash).toBe(noticeBodyHash(payload));
    // Süreç gönderim sırasında durmuş gibi, ama deneme yeni (eşiğin içinde).
    await prisma.productNotice.update({ where: { id: row.id }, data: { sentAt: null, attemptedAt: new Date(Date.now() - (NOTICE_RESEND_AFTER_MINUTES - 1) * 60_000) } });
    expect((await notify(payload)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(1);
  });

  it('yarım kalmış gönderim (sentAt boş, son deneme eşikten eski): tekrar istek yeniden gönderir; aynı satır, createdAt değişmez', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    expect((await notify(payload)).json()).toEqual({ status: 'queued', recipients: 1 });
    await flushMail();
    const before = await prisma.productNotice.findFirstOrThrow({ where: { orgId: owner.orgId, dedupeKey: payload.dedupeKey } });
    const stale = new Date(Date.now() - (NOTICE_RESEND_AFTER_MINUTES + 1) * 60_000);
    await prisma.productNotice.update({ where: { id: before.id }, data: { sentAt: null, attemptedAt: stale } });

    expect((await notify(payload)).json()).toEqual({ status: 'queued', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(2);
    const after = await prisma.productNotice.findFirstOrThrow({ where: { id: before.id } });
    expect(after.createdAt.getTime()).toBe(before.createdAt.getTime());
    expect(after.attemptedAt!.getTime()).toBeGreaterThan(stale.getTime());
    expect(after.sentAt).not.toBeNull();
    expect(await noticeCount(owner.orgId)).toBe(1);
    // Gönderildi: artık tekrar.
    expect((await notify(payload)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(2);
  });

  it('yeniden gönderim yalnız aynı gövdeyle: başka metin ya da izin duplicate, posta gitmez; özet anahtar sırasına bağlı değil', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    expect((await notify(payload)).json().status).toBe('queued');
    await flushMail();
    const stale = new Date(Date.now() - (NOTICE_RESEND_AFTER_MINUTES + 1) * 60_000);
    const where = { orgId: owner.orgId, dedupeKey: payload.dedupeKey };
    await prisma.productNotice.updateMany({ where, data: { sentAt: null, attemptedAt: stale } });

    const otherText = { ...payload, message: { tr: text('tr', { subject: 'Başka konu' }), en: text('en') } };
    expect((await notify(otherText)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    const otherAudience = { ...payload, audience: { permission: 'deciship.invoices.view' } };
    expect((await notify(otherAudience)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(1);
    // Satır yarım kalır; ilk gövdeyle gelen istek gönderir.
    expect((await prisma.productNotice.findFirstOrThrow({ where })).sentAt).toBeNull();

    const reordered = { message: { en: payload.message.en, tr: payload.message.tr }, audience: payload.audience, dedupeKey: payload.dedupeKey, orgId: payload.orgId, product: payload.product };
    expect(noticeBodyHash(reordered)).toBe(noticeBodyHash(payload));
    expect((await notify(reordered)).json()).toEqual({ status: 'queued', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(2);
  });

  it('kademeli yayın: deneme anını yazmayan eski kodun satırı (attemptedAt boş) ve özeti olmayan satır gönderilmiş sayılır', async () => {
    const owner = await firm();
    const o = owner.orgId;
    const old = new Date(Date.now() - 60 * 60_000);
    const legacy = body(o);
    const noHash = body(o);
    // Eski kod: yalnız eski sütunlar (yeni sütunlar boş).
    await prisma.productNotice.create({ data: { product: 'deciship', orgId: o, dedupeKey: legacy.dedupeKey, recipients: 1, createdAt: old } });
    // Önceki sürüm (Y129 ilk hali): deneme anı var, özet yok.
    await prisma.productNotice.create({ data: { product: 'deciship', orgId: o, dedupeKey: noHash.dedupeKey, recipients: 1, createdAt: old, attemptedAt: old } });
    expect((await notify(legacy)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    expect((await notify(noHash)).json()).toEqual({ status: 'duplicate', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(0);
  });

  it('eşzamanlı yeniden gönderim: tek istek üstlenir, tek posta', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    expect((await notify(payload)).json().status).toBe('queued');
    await flushMail();
    await prisma.productNotice.updateMany({
      where: { orgId: owner.orgId, dedupeKey: payload.dedupeKey },
      data: { sentAt: null, attemptedAt: new Date(Date.now() - (NOTICE_RESEND_AFTER_MINUTES + 1) * 60_000) },
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => notify(payload)));
    expect(results.map((r) => r.json().status).sort()).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'queued']);
    expect(await mailsTo(owner.email)).toHaveLength(2);
    expect(await noticeCount(owner.orgId)).toBe(1);
  });

  it('yeniden gönderim tavanda yeniden sayılmaz; abonelik ve alıcı kuralı yeniden uygulanır', async () => {
    const owner = await firm();
    const o = owner.orgId;
    const payload = body(o);
    expect((await notify(payload)).json().status).toBe('queued');
    await flushMail();
    const stale = new Date(Date.now() - (NOTICE_RESEND_AFTER_MINUTES + 1) * 60_000);
    await prisma.productNotice.updateMany({ where: { orgId: o, dedupeKey: payload.dedupeKey }, data: { sentAt: null, attemptedAt: stale } });
    // Tavan dolu (yarım kalan ileti dahil 30): yeni anahtar limited, yarım kalan yine gider.
    await prisma.productNotice.createMany({
      data: Array.from({ length: NOTICE_LIMITS.perOrgPerDay - 1 }, () => ({ product: 'deciship', orgId: o, dedupeKey: uniq('dolu'), recipients: 1, sentAt: new Date() })),
    });
    expect((await notify(body(o))).json()).toEqual({ status: 'limited', recipients: 0 });

    // Abonelik etkin değilse yeniden gönderim de yok; satır yarım kalır, abonelik dönünce gider.
    const where = { orgId_product: { orgId: o, product: 'deciship' } };
    await prisma.subscription.update({ where, data: { status: 'READ_ONLY' } });
    expect((await notify(payload)).json()).toEqual({ status: 'disabled', recipients: 0 });
    expect((await prisma.productNotice.findFirstOrThrow({ where: { orgId: o, dedupeKey: payload.dedupeKey } })).sentAt).toBeNull();
    await prisma.subscription.update({ where, data: { status: 'ACTIVE' } });

    expect((await notify(payload)).json()).toEqual({ status: 'queued', recipients: 1 });
    expect(await mailsTo(owner.email)).toHaveLength(2);
    expect(await prisma.productNotice.count({ where: { orgId: o, product: 'deciship' } })).toBe(NOTICE_LIMITS.perOrgPerDay);
  });

  it('eşzamanlı farklı anahtarlar tavanı delemez', async () => {
    const owner = await firm();
    const o = owner.orgId;
    await prisma.productNotice.createMany({
      data: Array.from({ length: NOTICE_LIMITS.perOrgPerDay - 2 }, () => ({ product: 'deciship', orgId: o, dedupeKey: uniq('dolu'), recipients: 1 })),
    });
    const results = await Promise.all(Array.from({ length: 6 }, () => notify(body(o))));
    const statuses = results.map((r) => r.json().status).sort();
    expect(statuses).toEqual(['limited', 'limited', 'limited', 'limited', 'queued', 'queued']);
    expect(await prisma.productNotice.count({ where: { orgId: o, product: 'deciship' } })).toBe(NOTICE_LIMITS.perOrgPerDay);
    expect(await mailsTo(owner.email)).toHaveLength(2);
  });
});

describe('posta', () => {
  it('metin HTML olarak yorumlanmaz; tek bağlantı uygulama kökü + aracın yolu', async () => {
    const owner = await firm();
    const sent = captureMail();
    const hostile = text('tr', {
      subject: 'Konu <b>kalın</b> & "tırnak"',
      lines: ['<script>alert(1)</script>', '<a href="javascript:alert(1)">tıkla</a>', `"' onmouseover=alert(1) x='`],
      action: { label: '<img src=x onerror=alert(1)>', path: '/deciship/invoices/abc?tab=diff&page=2' },
      footer: '<i>dip</i>',
    });
    const res = await notify(body(owner.orgId, { message: { tr: hostile, en: text('en') } }));
    expect(res.json().status).toBe('queued');
    await flushMail();
    expect(sent).toHaveLength(1);
    const mail = sent[0]!;
    expect(mail.to).toBe(owner.email);
    expect(mail.template).toBe('product_notice:deciship');
    expect(mail.subject).toBe(hostile.subject);
    for (const raw of ['<script', '<b>', '<i>', '<img', 'href="javascript', ' onmouseover=alert(1) x=\'']) expect(mail.html).not.toContain(raw);
    expect(mail.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(mail.html).toContain('&quot;&#39; onmouseover=alert(1) x=&#39;');
    expect(mail.html.match(/<a /g)).toHaveLength(1);
    expect(mail.html).toContain(`<a href="${TEST_ORIGIN}/deciship/invoices/abc?tab=diff&amp;page=2"`);
    expect(mail.text).toContain(`${TEST_ORIGIN}/deciship/invoices/abc?tab=diff&page=2`);
  });

  it('geliştirmede MailLog kaydı: alıcı, şablon, konu, gövdede satır ve bağlantı', async () => {
    const owner = await firm();
    const payload = body(owner.orgId);
    expect((await notify(payload)).json().status).toBe('queued');
    const [log] = await mailsTo(owner.email);
    expect(log).toMatchObject({ to: owner.email, template: 'product_notice:deciship', subject: text('tr').subject });
    expect(log!.body).toContain(text('tr').lines[0]);
    expect(log!.body).toContain(`${TEST_ORIGIN}/deciship/invoices/abc`);
    expect(log!.body).not.toContain(SECRET);
  });
});
