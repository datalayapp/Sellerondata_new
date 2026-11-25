import net from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { redactUrl } from '../src/app.ts';
import { prisma } from '../src/db.ts';
import { configureMailer, flushMail, invitationMail, passwordResetMail, queueMail } from '../src/lib/mailer.ts';
import {
  addMember,
  API,
  errorCode,
  getApp,
  lastMailTo,
  PASSWORD,
  randomEmail,
  randomIp,
  randomTrPhone,
  registerOrg,
  webHeaders, asWeb } from './helpers.ts';

let app: FastifyInstance;
beforeAll(async () => {
  app = await getApp();
});
afterEach(() => {
  configureMailer();
});

describe('istek gövdesi', () => {
  it('JSON başlıklı boş gövde 400 vermez', async () => {
    const owner = await registerOrg(app);
    const logout = await app.inject({
      method: 'POST',
      url: `${API}/auth/logout`,
      headers: { ...owner.headers, 'content-type': 'application/json' },
    });
    expect(logout.statusCode).toBe(200);
  });

  it('bozuk JSON 400 VALIDATION', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/forgot-password`,
      remoteAddress: randomIp(),
      headers: { 'content-type': 'application/json' },
      payload: '{bozuk',
    });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('VALIDATION');
  });

  it('__proto__ içeren gövde reddedilir', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/forgot-password`,
      remoteAddress: randomIp(),
      headers: { 'content-type': 'application/json' },
      payload: '{"identifier":"a@b.co","__proto__":{"x":1}}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('NUL karakteri 500 üretmez: gövdede ve yolda', async () => {
    const body = await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: randomIp(),
      headers: { 'content-type': 'application/json' },
      payload: '{"identifier":"a\\u0000@b.co","password":"x","client":"mobile"}',
    });
    expect(body.statusCode).toBe(400);
    const owner = await registerOrg(app);
    const path = await app.inject({ method: 'DELETE', url: `${API}/org/members/abc%00def`, headers: await asWeb(owner) });
    expect(path.statusCode).toBe(400);
    const invite = await app.inject({ url: `${API}/invites/abc%00`, remoteAddress: randomIp() });
    expect(invite.statusCode).toBe(400);
  });

  it('ad alanında satır sonu kabul edilmez (posta başlığı enjeksiyonu)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: randomIp(),
      payload: { orgName: 'Firma\r\nBcc: kurban@x.com', name: 'A', email: randomEmail(), password: PASSWORD, client: 'mobile' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe('orgName');
  });

  it('büyük gövde reddedilir', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: randomIp(),
      payload: { identifier: 'a@b.co', password: 'x'.repeat(70_000), client: 'mobile' },
    });
    expect(res.statusCode).toBe(413);
  });

  it('dev şifre argon2\'ye ulaşmaz', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      remoteAddress: randomIp(),
      payload: { identifier: 'a@b.co', password: 'x'.repeat(300), client: 'mobile' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('yazım hatası kayıt hakkını yemez', async () => {
    const ip = randomIp();
    for (let i = 0; i < 8; i++) {
      const res = await app.inject({
        method: 'POST',
        url: `${API}/auth/register`,
        remoteAddress: ip,
        payload: { orgName: 'X', name: 'Y', email: 'gecersiz', password: PASSWORD, client: 'mobile' },
      });
      expect(res.statusCode).toBe(400);
    }
    const ok = await app.inject({
      method: 'POST',
      url: `${API}/auth/register`,
      remoteAddress: ip,
      payload: { orgName: 'X', name: 'Y', email: randomEmail(), password: PASSWORD, client: 'mobile' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('davet üzerine yazma', () => {
  it('ADMIN, OWNER\'ın yönetici davetini aynı kişiye davetle düşüremez', async () => {
    const owner = await registerOrg(app);
    const admin = await addMember(app, owner.orgId, { orgRole: 'ADMIN' });
    const phone = randomTrPhone();
    const first = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(owner),
      payload: { kind: 'PHONE_CODE', phone, name: 'Yeni Yönetici', orgRole: 'ADMIN' },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: `${API}/org/members/invite`,
      headers: await asWeb(admin),
      payload: { kind: 'PHONE_CODE', phone, name: 'Yeni Yönetici', orgRole: 'MEMBER' },
    });
    expect(second.statusCode).toBe(403);
    const preview = await app.inject({
      method: 'POST',
      url: `${API}/auth/join/preview`,
      remoteAddress: randomIp(),
      payload: { phone, code: first.json().code },
    });
    expect(preview.statusCode).toBe(200);
  });
});

describe('posta', () => {
  it('Mailer arayüzü: arka planda gönderir, hata isteği düşürmez', async () => {
    const sent: string[] = [];
    configureMailer({
      mailer: {
        send: async (m) => {
          if (m.to.startsWith('patla')) throw new Error('smtp yok');
          sent.push(m.to);
        },
      },
    });
    queueMail(passwordResetMail('patla@x.co', 'tr', 'http://x'));
    queueMail(passwordResetMail('iyi@x.co', 'en', 'http://x'));
    await flushMail();
    expect(sent).toEqual(['iyi@x.co']);
  });

  it('SMTP_URL yoksa geliştirmede MailLog\'a yazar', async () => {
    const to = randomEmail('kutu');
    queueMail(passwordResetMail(to, 'tr', 'http://x/reset'));
    const row = await lastMailTo(to);
    expect(row?.template).toBe('password_reset');
    expect(row?.body).toContain('http://x/reset');
  });

  it('üretimde SMTP yoksa bağlantı hiçbir yere yazılmaz', async () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const lines: unknown[] = [];
    const log = { info: (o: unknown) => lines.push(o), warn: (o: unknown) => lines.push(o) };
    try {
      configureMailer({ log });
      const to = randomEmail('uretim');
      queueMail(passwordResetMail(to, 'tr', 'http://x/gizli-baglanti'));
      await flushMail();
      expect(await prisma.mailLog.count({ where: { to } })).toBe(0);
      expect(JSON.stringify(lines)).not.toContain('gizli-baglanti');
      expect(lines.length).toBe(1);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });

  it('SMTP_URL varsa nodemailer gerçek SMTP konuşur', async () => {
    const received: string[] = [];
    const server = net.createServer((socket) => {
      let inData = false;
      let buffer = '';
      socket.setEncoding('utf8');
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (inData) {
          if (!buffer.endsWith('\r\n.\r\n')) return;
          received.push(buffer);
          buffer = '';
          inData = false;
          socket.write('250 OK\r\n');
          return;
        }
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const cmd = line.toUpperCase();
          if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) socket.write('250 test\r\n');
          else if (cmd.startsWith('MAIL') || cmd.startsWith('RCPT')) socket.write('250 OK\r\n');
          else if (cmd.startsWith('DATA')) {
            inData = true;
            socket.write('354 go\r\n');
          } else if (cmd.startsWith('QUIT')) {
            socket.write('221 bye\r\n');
            socket.end();
          } else socket.write('250 OK\r\n');
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    const savedUrl = process.env.SMTP_URL;
    process.env.SMTP_URL = `smtp://127.0.0.1:${port}`;
    const errors: unknown[] = [];
    try {
      configureMailer({ log: { info: () => {}, warn: (o) => errors.push(o) } });
      queueMail(invitationMail('alici@x.co', 'tr', { orgName: 'A&B <Lojistik>', inviterName: 'Ayşe', url: 'http://x/invite/t' }));
      await flushMail();
      expect(errors).toEqual([]);
      expect(received).toHaveLength(1);
      expect(received[0]).toContain('alici@x.co');
    } finally {
      process.env.SMTP_URL = savedUrl;
      server.close();
    }
  });

  it('şablon HTML kaçışlı, TR ve EN', () => {
    const tr = invitationMail('a@x.co', 'tr', { orgName: '<script>x</script>', inviterName: 'A&B', url: 'http://x/y' });
    expect(tr.html).not.toContain('<script>');
    expect(tr.html).toContain('&lt;script&gt;');
    expect(tr.html).toContain('A&amp;B');
    expect(tr.subject).toBe('SellerOnData üzerinde bir firmaya davet edildiniz');
    expect(invitationMail('a@x.co', 'en', { orgName: 'O', inviterName: 'I', url: 'u' }).subject).toBe('You have been invited to a company on SellerOnData');
  });
});

describe('günlük', () => {
  it('davet jetonu günlüğe düşmez', () => {
    expect(redactUrl('/api/account/invites/GIZLIJETON/accept?x=1')).toBe('/api/account/invites/[gizli]/accept?x=1');
    expect(redactUrl('/api/account/invites/GIZLIJETON')).toBe('/api/account/invites/[gizli]');
    expect(redactUrl('/api/account/me')).toBe('/api/account/me');
  });
});

describe('web kayıt', () => {
  it('kayıt da çerez yazar, CSRF ister', async () => {
    const payload = { orgName: 'Web Firma', name: 'Y', email: randomEmail(), password: PASSWORD };
    const denied = await app.inject({ method: 'POST', url: `${API}/auth/register`, remoteAddress: randomIp(), payload });
    expect(errorCode(denied)).toBe('CSRF_FAILED');
    const ok = await app.inject({ method: 'POST', url: `${API}/auth/register`, remoteAddress: randomIp(), headers: webHeaders(), payload });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().accessToken).toBeUndefined();
    expect(ok.json().me.activeOrg.name).toBe('Web Firma');
    expect(ok.cookies.map((c) => c.name).sort()).toEqual(['sod_at', 'sod_lang', 'sod_rt']);
  });
});
