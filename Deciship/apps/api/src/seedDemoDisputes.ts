/**
 * Demo itirazları: Demo Lojistik firmasına örnek faturalar ve her durumda itiraz (gönderilmedi ve süresi yaklaşıyor,
 * gönderildi, kısmi geri alındı, reddedildi, kapandı, geri çekilip yeniden gönderildi, yeniden gönderildi). Tarihler bugüne
 * göredir. Faturalar gerçek içe aktarma ve karşılaştırma yolundan, itirazlar gerçek servis işlevlerinden geçer.
 *
 * Yalnız demo yığını çağırır (Platform demo betiği): `node dist/seedDemoDisputes.js` (giriş: src/bin/seedDemoDisputes.ts; bu
 * dosya kendini çalıştırmaz). Test yığını çağırmaz.
 * Firmada fatura varsa hiçbir şey yapmaz (yeniden çalıştırmak güvenli). Firma yoksa geliştirme tohumuyla açılır.
 */
import { turkeyDate } from '@deciship/core';
import { prisma, withCompany } from './db.ts';
import { env } from './env.ts';
import { num } from './lib/util.ts';
import { loadSampleData } from './services/companyData.ts';
import { refreshTotals } from './services/compare.ts';
import { addDisputeResult, currentSelectionDigest, resendDispute, revertDisputeResult, sendDispute, withdrawDispute } from './services/disputes.ts';
import { importDemoInvoice as importSample, sampleInvoice, type ImportedSample } from './services/sampleInvoices.ts';
import { seed, SEED_COMPANY, SEED_MEMBERS } from './dev-seed.ts';

/** Örnek faturanın içe aktarımı `services/sampleInvoices.ts`'e taşındı (deneme turu da kullanır); eski yol için dışa aktarılır. */
export { importDemoInvoice } from './services/sampleInvoices.ts';

/** Tohumdaki kişiler (kimlikler Hesap tohumuyla aynı). Rol adı burada yazılmaz: sırayla sahip, denetleyici, muhasebe. */
const OWNER = SEED_MEMBERS[0];
const AUDITOR = SEED_MEMBERS[2];
const ACCOUNTANT = SEED_MEMBERS[3];

const DAY_MS = 86_400_000;

function dayFrom(today: string, days: number): string {
  return new Date(Date.parse(`${today}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

type Imported = ImportedSample;

/** Denetleyici satırları itiraz listesine alır (gerçek karar alanları ve iz). */
async function verify(companyId: string, inv: Imported, count: number, at: Date) {
  const chosen = inv.lines.slice(0, count);
  if (chosen.length < count) throw new Error(`${inv.invoiceNo}: itiraz edilecek ${count} satır yok (${chosen.length})`);
  await prisma.invoiceLine.updateMany({ where: { id: { in: chosen.map((l) => l.id) } }, data: { decision: 'VERIFIED', decidedById: AUDITOR.id, decidedAt: at } });
  for (const l of chosen) {
    await prisma.auditLog.create({ data: { companyId, userId: AUDITOR.id, action: 'invoiceLine.decision', entity: 'InvoiceLine', entityId: l.id, data: { decision: 'VERIFIED', demo: true } } });
  }
  await refreshTotals(inv.id);
  return chosen;
}

async function activeRound(invoiceId: string) {
  return prisma.dispute.findFirstOrThrow({
    where: { invoiceId, withdrawnAt: null, supersededAt: null },
    include: { lines: { include: { invoiceLine: { select: { rowIndex: true } } }, orderBy: { invoiceLine: { rowIndex: 'asc' } } }, results: { orderBy: { createdAt: 'desc' } } },
  });
}

const actor = (companyId: string, member: { id: string }) => ({ companyId, userId: member.id });

export async function seedDemoDisputes(opts: { now?: Date; log?: (s: string) => void; waitForCompanyMs?: number } = {}) {
  opts = { waitForCompanyMs: 0, ...opts };
  if (env.isProduction) throw new Error('Demo itiraz tohumu üretimde çalışmaz.');
  const log = opts.log ?? ((s: string) => console.log(s));
  const now = opts.now ?? new Date();
  const today = turkeyDate(now);
  const companyId = SEED_COMPANY.id;

  // Demo kurulumunda firma Hesap'ın duyurusuyla (org-announce) eşzamansız açılır. Önce onu bekle: aynı anda iki taraf
  // açmaya çalışırsa tekil kimlik çakışır. Gelmezse geliştirme tohumu açar (varsa dokunmaz).
  // Üyeler Hesap'ta JIT ile de açılır: burada kimliklerle aynı.
  const companyExists = () => withCompany(companyId, () => prisma.company.findFirst({ where: { id: companyId }, select: { id: true } }));
  for (let i = 0; i < opts.waitForCompanyMs! / 500 && !(await companyExists()); i++) await new Promise((r) => setTimeout(r, 500));
  try {
    await seed({ log });
  } catch (err) {
    // Bekleme bittikten sonra duyuru yine de araya girdiyse firma artık vardır: devam et.
    if (!(await companyExists())) throw err;
  }

  return withCompany(companyId, async () => {
    const invoiceCount = await prisma.invoice.count({ where: { companyId } });
    if (invoiceCount > 0) {
      log(`Demo firmada ${invoiceCount} fatura var; demo itirazları yüklenmedi (yeniden yüklemek için firmayı sıfırlayın).`);
      return { skipped: true as const };
    }

    for (const m of [OWNER, AUDITOR, ACCOUNTANT]) {
      // Rol değişince eski rolün izin listesi kalmasın: aynı işlemde NULL (rolden türet). Alan Prisma ile yazılmaz (ham SQL).
      await prisma.$transaction(async (tx) => {
        await tx.member.upsert({
          where: { id: m.id },
          create: { id: m.id, companyId, personId: m.personId, name: m.name, role: m.role },
          update: { name: m.name, role: m.role, active: true },
        });
        await tx.$executeRaw`UPDATE "Member" SET "permissions" = NULL WHERE "id" = ${m.id} AND "companyId" = ${companyId}`;
      });
    }

    if ((await prisma.carrier.count({ where: { companyId } })) === 0) await loadSampleData(companyId, { log });

    // Dosyayı yükleyen ve içe aktarma kaydının sahibi: demo sahibi.
    const load = (id: string, day: string) => importSample(companyId, sampleInvoice(id), day, OWNER.id);
    const at = (days: number) => new Date(Date.parse(`${dayFrom(today, days)}T09:30:00.000Z`));
    const d = (days: number) => dayFrom(today, days);
    const summary: string[] = [];
    // B3: işaretleme gönderilecek kümenin özetini taşır (web metinden alır; tohum bugünkü kümeden)
    const sel = async (invoiceId: string) => ({ selectionDigest: (await currentSelectionDigest(companyId, invoiceId)) ?? '' });

    // Yükleme sırası samples/expected.json ile aynı (FedEx 11736, 11735'in tekrarlarını mükerrer bulur).
    const fedex1 = await load('fedex-9-482-11735', d(-28));
    const fedex2 = await load('fedex-9-482-11736', d(-10));
    const ups = await load('ups-0000F4A71X', d(-35));
    const dhl = await load('dhl-SIN-4471029', d(-25));
    const aras = await load('aras-ARS-2026-004871', d(-20));
    const yurtici = await load('yurtici-YK-2026-118833', d(-12));
    const mng = await load('mng-MNG-2026-77120', d(-7));

    // (a) Gönderilmedi, TTK süresi yarın doluyor
    await verify(companyId, mng, 3, at(-2));
    summary.push(`${mng.invoiceNo}: gönderilmedi, TTK son günü ${d(1)}`);

    // (b) Gönderildi, sonuç bekleniyor (muhasebe, e-posta)
    await verify(companyId, yurtici, 3, at(-9));
    await sendDispute(actor(companyId, ACCOUNTANT), yurtici, { ...(await sel(yurtici.id)), sentOn: d(-6), channel: 'EMAIL', reference: 'YK-TLP-55120' }, now);
    summary.push(`${yurtici.invoiceNo}: gönderildi, sonuç bekleniyor`);

    // (c) Kısmi geri alındı: bir dekont iki satırı kapsar, biri talepten az; bir satır bekliyor
    await verify(companyId, aras, 3, at(-17));
    await sendDispute(actor(companyId, OWNER), aras, { ...(await sel(aras.id)), sentOn: d(-15), channel: 'PORTAL', reference: 'ARS-ITR-20931' }, now);
    {
      const r = await activeRound(aras.id);
      const [l1, l2] = r.lines;
      const partial = Math.max(0.01, Math.round(num(l2!.claimedAmount) * 0.6 * 100) / 100);
      await addDisputeResult(actor(companyId, ACCOUNTANT), r.id, {
        version: r.version,
        kind: 'RECOVERED',
        resultOn: d(-4),
        creditNoteNo: 'AD-2026-0412',
        lines: [
          { disputeLineId: l1!.id, amount: num(l1!.claimedAmount) },
          { disputeLineId: l2!.id, amount: partial },
        ],
      }, now);
    }
    summary.push(`${aras.invoiceNo}: kısmi geri alındı (AD-2026-0412), bir satır bekliyor`);

    // (d) Reddedildi
    await verify(companyId, dhl, 3, at(-23));
    await sendDispute(actor(companyId, ACCOUNTANT), dhl, { ...(await sel(dhl.id)), sentOn: d(-20), channel: 'EMAIL', reference: 'DHL-CS-884201' }, now);
    {
      const r = await activeRound(dhl.id);
      await addDisputeResult(actor(companyId, ACCOUNTANT), r.id, {
        version: r.version,
        kind: 'REJECTED',
        resultOn: d(-8),
        reason: 'Taşıyıcı kendi tartı ve ölçü kayıtlarını esas aldı; koli fotoğrafları kabul edilmedi.',
        lines: r.lines.map((l) => ({ disputeLineId: l.id })),
      }, now);
    }
    summary.push(`${dhl.invoiceNo}: reddedildi`);

    // (e) Kapandı, tamamı geri alındı; bir giriş önce yanlış girilip geri alınmış
    await verify(companyId, ups, 3, at(-33));
    await sendDispute(actor(companyId, ACCOUNTANT), ups, { ...(await sel(ups.id)), sentOn: d(-30), channel: 'PORTAL', reference: 'UPS-1Z-77810' }, now);
    {
      let r = await activeRound(ups.id);
      await addDisputeResult(actor(companyId, ACCOUNTANT), r.id, {
        version: r.version,
        kind: 'RECOVERED',
        resultOn: d(-16),
        creditNoteNo: 'AD-2026-0377',
        lines: [{ disputeLineId: r.lines[0]!.id, amount: num(r.lines[0]!.claimedAmount) }],
      }, now);
      r = await activeRound(ups.id);
      await revertDisputeResult(actor(companyId, OWNER), r.results[0]!.id, { version: r.version, reason: 'Dekont numarası başka faturaya aitti; doğru dekontla yeniden girilecek.' });
      r = await activeRound(ups.id);
      await addDisputeResult(actor(companyId, ACCOUNTANT), r.id, {
        version: r.version,
        kind: 'RECOVERED',
        resultOn: d(-14),
        creditNoteNo: 'AD-2026-0391',
        lines: r.lines.map((l) => ({ disputeLineId: l.id, amount: num(l.claimedAmount) })),
      }, now);
    }
    summary.push(`${ups.invoiceNo}: kapandı, tamamı geri alındı (AD-2026-0391)`);

    // (f) Geri çekildi, sonra yeniden gönderildi (tur 1 geri çekilmiş, tur 2 etkin)
    await verify(companyId, fedex2, 3, at(-9));
    await sendDispute(actor(companyId, ACCOUNTANT), fedex2, { ...(await sel(fedex2.id)), sentOn: d(-8), channel: 'OTHER', channelNote: 'Taşıyıcı temsilcisine telefonla bildirildi' }, now);
    {
      const r = await activeRound(fedex2.id);
      await withdrawDispute(actor(companyId, ACCOUNTANT), r.id, { version: r.version, reason: 'Yazılı başvuru istendi; taşıyıcı portalından yeniden gönderilecek.' });
    }
    await sendDispute(actor(companyId, OWNER), fedex2, { ...(await sel(fedex2.id)), sentOn: d(-5), channel: 'PORTAL', reference: 'FDX-CR-3301847' }, now);
    summary.push(`${fedex2.invoiceNo}: tur 1 geri çekildi, tur 2 gönderildi`);

    // (g) Kısmi ret sonrası yeniden gönderildi (tur 1 yerini tur 2'ye bıraktı)
    await verify(companyId, fedex1, 4, at(-27));
    await sendDispute(actor(companyId, OWNER), fedex1, { ...(await sel(fedex1.id)), sentOn: d(-26), channel: 'EMAIL', reference: 'FDX-CR-3299012' }, now);
    {
      let r = await activeRound(fedex1.id);
      await addDisputeResult(actor(companyId, ACCOUNTANT), r.id, {
        version: r.version,
        kind: 'RECOVERED',
        resultOn: d(-19),
        creditNoteNo: 'AD-2026-0359',
        lines: [{ disputeLineId: r.lines[0]!.id, amount: num(r.lines[0]!.claimedAmount) }],
      }, now);
      r = await activeRound(fedex1.id);
      await addDisputeResult(actor(companyId, ACCOUNTANT), r.id, {
        version: r.version,
        kind: 'REJECTED',
        resultOn: d(-18),
        reason: 'Ek belge istendi: koli ölçü fotoğrafları ve gönderi irsaliyesi.',
        lines: [{ disputeLineId: r.lines[1]!.id }],
      }, now);
      r = await activeRound(fedex1.id);
      await resendDispute(actor(companyId, ACCOUNTANT), r.id, { ...(await sel(fedex1.id)), version: r.version, sentOn: d(-16), channel: 'EMAIL', reference: 'FDX-CR-3299012', channelNote: 'Ölçü fotoğrafları ve irsaliye eklendi' }, now);
    }
    summary.push(`${fedex1.invoiceNo}: tur 1'de bir satır geri alındı, bir satır reddedildi; belgelerle yeniden gönderildi`);

    log('Demo itirazları yüklendi:');
    for (const s of summary) log(` - ${s}`);
    return { skipped: false as const, invoices: summary.length };
  });
}
