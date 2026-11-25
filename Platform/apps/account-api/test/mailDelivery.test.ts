import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { prisma } from '../src/db.ts';
import { classifyMailError, configureMailer, flushMail, invitationMail, passwordResetMail, queueMail, sendMailNow, type MailMessage } from '../src/lib/mailer.ts';
import { sha256 } from '../src/lib/crypto.ts';
import { API, getApp, randomEmail, randomIp, registerOrg, uniq, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});

afterEach(async () => {
  await flushMail();
  configureMailer();
});

const FAST = { retryDelaysMs: [5, 10], sendTimeoutMs: 200 };

/** nodemailer'ın gerçek hata biçimleri. */
function smtpError(code: string, responseCode?: number, message = 'smtp hatası') {
  return Object.assign(new Error(message), { code, ...(responseCode ? { responseCode } : {}) });
}

function capture() {
  const lines: { obj: Record<string, unknown>; msg?: string }[] = [];
  const log = {
    info: (obj: unknown, msg?: string) => lines.push({ obj: obj as Record<string, unknown>, msg }),
    warn: (obj: unknown, msg?: string) => lines.push({ obj: obj as Record<string, unknown>, msg }),
  };
  return { lines, log };
}

/** Sırayla verilen sonuçları üretir, biterse başarılı gönderir. */
function scriptedMailer(script: (Error | null)[]) {
  const attempts: MailMessage[] = [];
  const times: number[] = [];
  return {
    attempts,
    times,
    mailer: {
      send: async (message: MailMessage) => {
        attempts.push(message);
        times.push(Date.now());
        const step = script[attempts.length - 1];
        if (step) throw step;
      },
    },
  };
}

const message = () => passwordResetMail(`${uniq('alici')}@x.co`, 'tr', 'http://x/reset-password/GIZLI-JETON');

/** Davet postası yalnız doğrulanmış e-postası olan yönetici adına gider. */
async function verifiedOwner() {
  const owner = await registerOrg(app);
  await prisma.person.update({ where: { id: owner.personId }, data: { emailVerifiedAt: new Date() } });
  return owner;
}

async function invite(owner: { accessToken: string }, email: string) {
  return app.inject({ method: 'POST', url: `${API}/org/members/invite`, headers: await asWeb(owner), payload: { kind: 'EMAIL', email, name: 'Davetli' } });
}

function forgot(identifier: string) {
  return app.inject({ method: 'POST', url: `${API}/auth/forgot-password`, remoteAddress: randomIp(), payload: { identifier } });
}

/** Yanıtı SMTP'den bağımsız kanıtlamak için: kapı açılana kadar gönderim bitmez. */
function gatedMailer() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const started: MailMessage[] = [];
  return {
    open,
    started,
    mailer: {
      send: async (m: MailMessage) => {
        started.push(m);
        await gate;
      },
    },
  };
}

describe('hata sınıfı', () => {
  it.each([
    ['ECONNECTION', undefined, 'connection', true],
    ['ETIMEDOUT', undefined, 'timeout', true],
    ['EDNS', undefined, 'connection', true],
    ['ESOCKET', undefined, 'connection', true],
    ['ECONNREFUSED', undefined, 'connection', true],
    ['EENVELOPE', 451, 'temporary_rejection', true],
    ['EMESSAGE', 421, 'temporary_rejection', true],
    ['EENVELOPE', 550, 'rejected', false],
    ['EAUTH', 535, 'auth', false],
    ['ETLS', undefined, 'tls', false],
  ] as const)('%s %s: %s, geçici %s', (code, responseCode, errorClass, transient) => {
    const result = classifyMailError(smtpError(code, responseCode));
    expect(result.errorClass).toBe(errorClass);
    expect(result.transient).toBe(transient);
    expect(result.code).toBe(code);
  });

  it('bilinmeyen hata geçici sayılmaz, serbest kod günlüğe taşınmaz', () => {
    expect(classifyMailError(new Error('patladı'))).toMatchObject({ errorClass: 'unknown', transient: false });
    const odd = classifyMailError(smtpError('http://x/reset-password/GIZLI'));
    expect(odd.code).toBeUndefined();
  });
});

describe('arka plan gönderimi: sınırlı yeniden deneme', () => {
  it('geçici hata iki kez olursa üçüncü denemede gider, sonuç hatası yazılmaz', async () => {
    const { lines, log } = capture();
    const script = scriptedMailer([smtpError('ECONNECTION'), smtpError('EENVELOPE', 451)]);
    configureMailer({ ...FAST, mailer: script.mailer, log });
    queueMail(message());
    await flushMail();
    expect(script.attempts).toHaveLength(3);
    expect(lines.map((l) => l.msg)).toEqual(['e-posta yeniden denenecek', 'e-posta yeniden denenecek']);
  });

  it('geri çekilme: denemeler arasındaki bekleme artar', async () => {
    const script = scriptedMailer([smtpError('ECONNECTION'), smtpError('ECONNECTION')]);
    configureMailer({ retryDelaysMs: [40, 120], sendTimeoutMs: 200, mailer: script.mailer });
    queueMail(message());
    await flushMail();
    const [a, b, c] = script.times as [number, number, number];
    expect(b - a).toBeGreaterThanOrEqual(35);
    expect(c - b).toBeGreaterThanOrEqual(115);
  });

  it('geçici hata sürerse en çok üç deneme, sonra bırakır ve türüyle sınıfını yazar', async () => {
    const { lines, log } = capture();
    const script = scriptedMailer([smtpError('ECONNECTION'), smtpError('ECONNECTION'), smtpError('ECONNECTION'), null]);
    configureMailer({ ...FAST, mailer: script.mailer, log });
    queueMail(message());
    await flushMail();
    expect(script.attempts).toHaveLength(3);
    const last = lines.at(-1)!;
    expect(last.msg).toBe('e-posta gönderilemedi');
    expect(last.obj).toMatchObject({ operation: 'password_reset', errorClass: 'connection', code: 'ECONNECTION', attempt: 3 });
  });

  it.each([
    ['kalıcı ret', smtpError('EENVELOPE', 550)],
    ['kimlik doğrulama', smtpError('EAUTH', 535)],
    ['bilinmeyen', new Error('patladı')],
  ])('%s yeniden denenmez', async (_name, error) => {
    const script = scriptedMailer([error, null]);
    configureMailer({ ...FAST, mailer: script.mailer });
    queueMail(message());
    await flushMail();
    expect(script.attempts).toHaveLength(1);
  });

  it('asılı kalan gönderim zaman aşımına uğrar, timeout sayılıp yeniden denenir', async () => {
    const { lines, log } = capture();
    let calls = 0;
    configureMailer({
      retryDelaysMs: [5],
      sendTimeoutMs: 30,
      log,
      mailer: {
        send: () => {
          calls += 1;
          return new Promise<void>(() => {});
        },
      },
    });
    queueMail(message());
    await flushMail();
    expect(calls).toBe(2);
    expect(lines.at(-1)?.obj).toMatchObject({ errorClass: 'timeout', attempt: 2 });
  });

  it('günlükte jeton, bağlantı, alıcı ve ham hata metni yok', async () => {
    const { lines, log } = capture();
    const secret = 'http://x/reset-password/GIZLI-JETON';
    const script = scriptedMailer([
      smtpError('ECONNECTION', undefined, `bağlanamadı ${secret}`),
      smtpError('EENVELOPE', 550, `550 alici@x.co ret ${secret}`),
    ]);
    configureMailer({ ...FAST, mailer: script.mailer, log });
    queueMail(passwordResetMail('alici@x.co', 'tr', secret));
    await flushMail();
    const out = JSON.stringify(lines);
    expect(lines.length).toBe(2);
    expect(out).not.toContain('GIZLI');
    expect(out).not.toContain('alici@x.co');
    expect(out).not.toContain('reset-password');
    expect(lines.every((l) => !('err' in l.obj))).toBe(true);
  });
});

describe('anlık gönderim', () => {
  it('başarıda true', async () => {
    const script = scriptedMailer([]);
    configureMailer({ ...FAST, mailer: script.mailer });
    expect(await sendMailNow(message())).toBe(true);
  });

  it('hatada false, istek içinde yeniden denemez, türü ve sınıfı yazar', async () => {
    const { lines, log } = capture();
    const script = scriptedMailer([smtpError('ECONNECTION'), null]);
    configureMailer({ ...FAST, mailer: script.mailer, log });
    expect(await sendMailNow(message())).toBe(false);
    expect(script.attempts).toHaveLength(1);
    expect(lines.at(-1)?.obj).toMatchObject({ operation: 'password_reset', errorClass: 'connection' });
  });

  it('zaman aşımında false: istek SMTP kadar asılı kalmaz', async () => {
    configureMailer({ sendTimeoutMs: 30, mailer: { send: () => new Promise<void>(() => {}) } });
    const started = Date.now();
    expect(await sendMailNow(message())).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('üretimde SMTP yoksa false: gönderilmeyen posta "gönderildi" sayılmaz', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const { lines, log } = capture();
      configureMailer({ log });
      expect(await sendMailNow(invitationMail('a@x.co', 'tr', { orgName: 'F', inviterName: 'K', url: 'http://x/invite/GIZLI' }))).toBe(false);
      expect(lines.at(-1)?.obj).toMatchObject({ operation: 'invitation', errorClass: 'not_configured' });
      expect(JSON.stringify(lines)).not.toContain('GIZLI');
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('davet: mailSent gerçek sonucu söyler', () => {
  it('gönderim olursa true; bağlantı her durumda döner', async () => {
    const owner = await verifiedOwner();
    await flushMail();
    const script = scriptedMailer([]);
    configureMailer({ ...FAST, mailer: script.mailer });
    const res = await invite(owner, randomEmail('davetli'));
    expect(res.statusCode).toBe(201);
    expect(res.json().mailSent).toBe(true);
    expect(script.attempts).toHaveLength(1);
    expect(script.attempts[0]?.template).toBe('invitation');
  });

  it('SMTP hata verirse false, davet yine oluşur ve bağlantı döner', async () => {
    const owner = await verifiedOwner();
    await flushMail();
    configureMailer({ ...FAST, mailer: scriptedMailer([smtpError('ECONNECTION')]).mailer });
    const email = randomEmail('davetli');
    const res = await invite(owner, email);
    expect(res.statusCode).toBe(201);
    expect(res.json().mailSent).toBe(false);
    expect(res.json().link).toContain('/invite/');
    expect(await prisma.invitation.count({ where: { orgId: owner.orgId, email } })).toBe(1);
  });

  it('SMTP asılı kalırsa zaman aşımıyla false', async () => {
    const owner = await verifiedOwner();
    await flushMail();
    configureMailer({ sendTimeoutMs: 30, mailer: { send: () => new Promise<void>(() => {}) } });
    const res = await invite(owner, randomEmail('davetli'));
    expect(res.statusCode).toBe(201);
    expect(res.json().mailSent).toBe(false);
  });

  it('yeniden gönder de aynı: hata false, başarı true, her ikisinde yeni bağlantı', async () => {
    const owner = await verifiedOwner();
    await flushMail();
    const created = await invite(owner, randomEmail('davetli'));
    await flushMail();
    const id = created.json().invitation.id as string;
    const resend = async () => app.inject({ method: 'POST', url: `${API}/org/invitations/${id}/resend`, headers: await asWeb(owner) });

    configureMailer({ ...FAST, mailer: scriptedMailer([smtpError('EENVELOPE', 550)]).mailer });
    const failed = await resend();
    expect(failed.statusCode).toBe(200);
    expect(failed.json().mailSent).toBe(false);
    expect(failed.json().link).toContain('/invite/');

    configureMailer({ ...FAST, mailer: scriptedMailer([]).mailer });
    const ok = await resend();
    expect(ok.json().mailSent).toBe(true);
    expect(ok.json().link).not.toBe(failed.json().link);
  });

  it('gerçek nodemailer, kapalı SMTP portu: mailSent false, istek düşmez', async () => {
    const owner = await verifiedOwner();
    await flushMail();
    const closed = net.createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
    const { port } = closed.address() as net.AddressInfo;
    await new Promise((r) => closed.close(r));
    const savedUrl = process.env.SMTP_URL;
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    const { lines, log } = capture();
    try {
      configureMailer({ log, sendTimeoutMs: 3000 });
      const res = await invite(owner, randomEmail('davetli'));
      expect(res.statusCode).toBe(201);
      expect(res.json().mailSent).toBe(false);
      expect(lines.at(-1)?.obj).toMatchObject({ operation: 'invitation', errorClass: 'connection' });
    } finally {
      if (savedUrl === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = savedUrl;
    }
  });

  it('SMTP, TCP bağlantısını kabul edip hiç selam vermezse gerçek nodemailer de zaman aşımıyla false', async () => {
    const owner = await verifiedOwner();
    await flushMail();
    const sockets: net.Socket[] = [];
    const silent = net.createServer((s) => sockets.push(s));
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const { port } = silent.address() as net.AddressInfo;
    const savedUrl = process.env.SMTP_URL;
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    try {
      configureMailer({ sendTimeoutMs: 100 });
      const started = Date.now();
      const res = await invite(owner, randomEmail('davetli'));
      expect(res.json().mailSent).toBe(false);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      if (savedUrl === undefined) delete process.env.SMTP_URL;
      else process.env.SMTP_URL = savedUrl;
      sockets.forEach((s) => s.destroy());
      silent.close();
    }
  });
});

describe('şifre sıfırlama: hesabın varlığı sızmaz', () => {
  it('yanıt SMTP\'yi beklemez: bilinen ve bilinmeyen adres, posta bitmeden aynı yanıtı alır', async () => {
    const owner = await registerOrg(app);
    await flushMail();
    const gated = gatedMailer();
    configureMailer({ ...FAST, sendTimeoutMs: 5000, mailer: gated.mailer });

    const known = await forgot(owner.email as string);
    const unknown = await forgot(randomEmail('yok'));
    expect(known.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(known.statusCode);
    expect(unknown.body).toBe(known.body);
    expect(Object.keys(unknown.headers).sort()).toEqual(Object.keys(known.headers).sort());

    // Kapı hâlâ kapalı: bilinen adresin postası sürerken yanıt çoktan dönmüştü.
    await expect.poll(() => gated.started.length).toBe(1);
    gated.open();
    await flushMail();
    expect(gated.started[0]?.to).toBe(owner.email);
  });

  // Süre ölçümü ("SMTP yavaşken bilinen adresin yanıtı bilinmeyenden belirgin uzun sürmez") kapı dışında:
  // timing.perf.test.ts (`npm run test:perf`). Yanıtın SMTP'yi beklemediği yukarıdaki kapılı sahte sunucuyla denetlenir.

  it('SMTP kalıcı hata verse de yanıt aynı', async () => {
    const owner = await registerOrg(app);
    await flushMail();
    configureMailer({ ...FAST, mailer: { send: async () => Promise.reject(smtpError('EENVELOPE', 550)) } });
    const known = await forgot(owner.email as string);
    const unknown = await forgot(randomEmail('yok'));
    expect(known.statusCode).toBe(200);
    expect(known.body).toBe(unknown.body);
  });

  it('geçici hatada yeniden denenir; denemelerde aynı jeton gider, veritabanında yalnız özeti durur', async () => {
    const owner = await registerOrg(app);
    await flushMail();
    const script = scriptedMailer([smtpError('ECONNECTION'), smtpError('ECONNECTION')]);
    configureMailer({ ...FAST, mailer: script.mailer });
    await forgot(owner.email as string);
    await flushMail();
    expect(script.attempts).toHaveLength(3);
    expect(new Set(script.attempts.map((m) => m.text)).size).toBe(1);

    const token = /reset-password\/(\S+)/.exec(script.attempts[0]?.text ?? '')?.[1] as string;
    expect(token).toBeTruthy();
    const rows = await prisma.oneTimeToken.findMany({ where: { personId: owner.personId, kind: 'PASSWORD_RESET' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(await prisma.mailLog.count({ where: { to: owner.email as string, template: 'password_reset' } })).toBe(0);

    // Yeniden denenen posta çalışır: bağlantı şifreyi yeniler.
    const reset = await app.inject({
      method: 'POST',
      url: `${API}/auth/reset-password`,
      remoteAddress: randomIp(),
      payload: { token, password: 'YeniSifre-48213' },
    });
    expect(reset.statusCode).toBeLessThan(300);
  });
});

describe('e-posta doğrulama', () => {
  it('kayıt posta hatasından etkilenmez, geçici hatada yeniden denenir', async () => {
    const script = scriptedMailer([smtpError('ETIMEDOUT'), null]);
    configureMailer({ ...FAST, mailer: script.mailer });
    const owner = await registerOrg(app);
    expect(owner.personId).toBeTruthy();
    await flushMail();
    expect(script.attempts.filter((m) => m.template === 'email_verify')).toHaveLength(2);
    const rows = await prisma.oneTimeToken.findMany({ where: { personId: owner.personId, kind: 'EMAIL_VERIFY' } });
    const token = /verify-email\/(\S+)/.exec(script.attempts[0]?.text ?? '')?.[1] as string;
    expect(rows[0]?.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('kalıcı hata kaydı düşürmez', async () => {
    configureMailer({ ...FAST, mailer: { send: async () => Promise.reject(smtpError('EAUTH', 535)) } });
    const owner = await registerOrg(app);
    expect(owner.orgId).toBeTruthy();
  });
});
