import { m } from '../i18n/index.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import { z } from 'zod';
import { Prisma, prisma, withCompany } from '../db.ts';
import { REPO_ROOT } from '../env.ts';
import { notFound } from '../errors.ts';
import { can, loadMemberAccess, memberPermissions } from '../lib/access.ts';
import { absolutePath, verifyFileToken } from '../lib/storage.ts';

const PHOTO_KINDS = ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER'] as const;

/**
 * Oturumla gelen kişinin görebileceği dosyalar. Fatura dosyası fiyat içerir: fatura görme VE fiyat görme izniyle. Hesap
 * `invoices.view → prices.view` bağımlılığını zorunlu tutar (özel roller v1); burada ikisi birden aranır ki bağımlılığı
 * taşımayan bir jeton (hata ya da eski kural) yine de fiyatlı dosyayı açamasın. `stripMoney` ikili dosyaya işlemez.
 * Fotoğraf: hepsini görme izni, ya da ölçüm yapan kişi için yalnız kendi ölçümü.
 */
function visibleFiles(req: FastifyRequest): Prisma.FileWhereInput | null {
  const visible: Prisma.FileWhereInput[] = [];
  if (can(req, 'deciship.invoices.view') && can(req, 'deciship.prices.view')) visible.push({ kind: 'INVOICE_SOURCE' });
  if (can(req, 'deciship.measurements.view_all')) visible.push({ kind: { in: [...PHOTO_KINDS] } });
  else if (can(req, 'deciship.measurements.capture')) visible.push({ kind: { in: [...PHOTO_KINDS] }, measurement: { measuredById: req.auth.membershipId } });
  return visible.length ? { OR: visible } : null;
}

/**
 * Silinen kaydın dosyası kapanır. Faturanın geri yüklemesi yoktur: herkese kapalı. Silinen ölçümü geri yükleme ekranı
 * yönetme izniyle açar: fotoğrafını da o izin görür. Faturaya henüz bağlanmamış yükleme açıktır.
 * Diskten temizlenmiş dosya (Mesaj 7, `purgedAt`) herkese kapalıdır: 404.
 */
function liveFile(canManageMeasurements: boolean): Prisma.FileWhereInput {
  return {
    AND: [
      { purgedAt: null },
      { OR: [{ invoicesAsSource: { none: {} } }, { invoicesAsSource: { some: { deletedAt: null } } }] },
      canManageMeasurements ? {} : { OR: [{ measurementId: null }, { measurement: { deletedAt: null } }] },
    ],
  };
}

export async function fileRoutes(app: FastifyInstance) {
  /** `?t=` imzalı bağlantı `<img>` için: yetkisi imzayı üreten yanıttan gelir. Yoksa oturum gerekir. */
  const tokenOrSession: onRequestHookHandler = (req, reply, done) => {
    if ((req.query as { t?: unknown } | undefined)?.t) return done();
    app.authenticate(req, reply, done);
  };

  app.get('/files/:id', { onRequest: tokenOrSession }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(100) }).parse(req.params);
    const { t } = z.object({ t: z.string().optional() }).parse(req.query);
    let file;
    const signed = Boolean(t);
    if (t) {
      const v = verifyFileToken(t);
      if (v && v.fileId === id) {
        file = await withCompany(v.companyId, async () => {
          // Kapalı firmanın dosyası açılmaz (oturumlu yol auth-kit'te 409 ORG_CLOSED alır; imzalı bağlantı oraya uğramaz).
          if (!(await prisma.company.findFirst({ where: { id: v.companyId, closedAt: null }, select: { id: true } }))) return null;
          // Bağlantı kişiye bağlı: üyelik pasifse ya da yetkisi değiştiyse (rol ya da rolün izinleri: epoch) süresi dolmadan düşer.
          const [member] = await loadMemberAccess(v.companyId, [v.membershipId]);
          if (!member?.active || member.epoch !== v.epoch) return null;
          // Rol adına değil üyenin geçerli izinlerine bakılır: özel rol ve düzenlenmiş hazır rol de doğru sonuç verir.
          const held = memberPermissions(member);
          const manage = held.includes('deciship.measurements.manage');
          // Fatura kaynağı fiyat taşır: imza onu üreten yanıttan (fatura ayrıntısı) gelse de fiyat izni de aranır (oturumlu yolla
          // aynı ikinci kat). Fotoğrafın yetkisi imzadan gelir: fatura satırındaki ölçüm fotoğrafı da açılabilsin.
          const sourceOk = held.includes('deciship.invoices.view') && held.includes('deciship.prices.view');
          return prisma.file.findFirst({ where: { id, companyId: v.companyId, ...(sourceOk ? {} : { kind: { not: 'INVOICE_SOURCE' } }), ...liveFile(manage) } });
        });
      }
    } else {
      const visible = visibleFiles(req);
      if (visible) file = await prisma.file.findFirst({ where: { AND: [{ id, companyId: req.auth.orgId }, visible, liveFile(can(req, 'deciship.measurements.manage'))] } });
    }
    if (!file) throw notFound(m('file.notFoundOrExpired'));
    const abs = absolutePath(file.path);
    if (!fs.existsSync(abs)) throw notFound(m('file.notFound'));
    reply.header('Content-Type', file.mime);
    // Oturumlu yanıt kişiye özel ve yetkisi değişebilir: yazılmaz. İmzalı bağlantı kısa ömürlü, görsel için önbelleklenir.
    reply.header('Cache-Control', signed ? 'private, max-age=600' : 'private, no-store');
    // yüklenen dosya API kökeninde betik olarak çalışamasın
    reply.header('X-Content-Type-Options', 'nosniff');
    // PDF içindeki bağlantıdan çıkarken adresteki imza Referer ile gitmesin
    reply.header('Referrer-Policy', 'no-referrer');
    // (PDF hariç: Chrome'un PDF görüntüleyicisi sandbox içinde açılmaz; PDF türünü sunucu belirler)
    if (file.mime !== 'application/pdf') reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    if (file.kind === 'INVOICE_SOURCE' && file.originalName) {
      reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
    }
    return reply.send(fs.createReadStream(abs));
  });

  app.get('/reference-card.pdf', { onRequest: app.requirePermission('deciship.measurements.capture') }, async (_req, reply) => {
    const candidates = [
      path.join(REPO_ROOT, 'samples', 'reference-card.pdf'),
      path.resolve(process.cwd(), 'assets', 'reference-card.pdf'),
    ];
    const found = candidates.find((p) => fs.existsSync(p));
    if (!found) throw notFound(m('file.referenceCardMissing'));
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `inline; filename="${m('file.referenceCardName')}"`);
    return reply.send(fs.createReadStream(found));
  });
}
