import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildDisputeText,
  disputeClaim,
  disputeVatPct,
  isDisputable,
  withVat,
  type DiffType,
  type DisputeLine,
  type EdgeRounding,
  type Locale,
} from '@deciship/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from '../db.ts';
import { AppError, badRequest, forbiddenFor, notFound } from '../errors.ts';
import { m } from '../i18n/index.ts';
import { can } from '../lib/access.ts';
import { audit } from '../lib/audit.ts';
import { readSettings } from '../lib/settings.ts';
import { env } from '../env.ts';
import { isCleanOutcome, stripImageMetadata } from '../lib/imageMeta.ts';
import { absolutePath } from '../lib/storage.ts';
import { zonedDateTimeText } from '../lib/time.ts';
import { num, numOrNull } from '../lib/util.ts';
import { zipStream, type ZipEntry } from '../lib/zip.ts';
import { loadPricingTariff } from './compare.ts';
import { sendableDigest, sendableLines } from './disputes.ts';
import { isDomesticCarrier } from './tariffs.ts';

/**
 * İtiraz metni ve kanıt ZIP'i (Mesaj 5, 04-B8). İki çıktı aynı satır kümesini kullanır: `loadDisputeDraft` faturanın "İtiraz
 * listesinde" satırlarını okur, `buildDisputeText`'in süzdüğü (`isDisputable`) satırları sırasıyla tutar; metindeki "3)" satırının
 * fotoğrafları ZIP'te "03-…" adını alır.
 *
 * Güvenlik:
 * - Her sorgu firma bağlamında (RLS) ve ayrıca açık `companyId` süzgeciyle; başka firmanın ölçümü ya da dosyası satıra bağlı
 *   görünse bile alınmaz.
 * - Diskteki yol yalnız veritabanındaki `File.path`'ten (sunucunun ürettiği ad, `storeBuffer`), `absolutePath` depo kökünün
 *   dışını reddeder. ZIP içi adlar kullanıcı girdisinden türetilmez: sıra no + temizlenmiş takip no + sabit tür adı + sayaç.
 * - Adet ve boyut sınırı akış başlamadan, diskteki gerçek boyutla denetlenir (413). Akış sırasında dosya büyümüşse akış kesilir.
 * - Metin tutar taşır: fiyat görme izni olmayan kişiye üretilmez (403).
 */

export const EVIDENCE_MAX_PHOTOS = 1_000;
export const EVIDENCE_MAX_BYTES = 500 * 1024 * 1024;

const PHOTO_KINDS = ['PHOTO_BOX', 'PHOTO_SCALE', 'PHOTO_LABEL', 'PHOTO_OTHER'] as const;
type PhotoKind = (typeof PHOTO_KINDS)[number];

/** Uzantı dosya adından değil, sunucunun kaydettiği türden. */
const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export type EvidencePhoto = { id: string; kind: PhotoKind; path: string; mime: string; size: number };

type DimMethod = 'LIDAR' | 'AR' | 'REFERENCE' | 'MANUAL' | 'PRESET';
type WeightMethod = 'OCR' | 'MANUAL';

/** Metindeki bir satır: core girdisi + kanıtı (ölçüm ve fotoğraflar). */
export type DraftLine = {
  lineId: string;
  /** Metindeki sıra (1'den). */
  index: number;
  trackingNo: string;
  input: DisputeLine;
  /** Canlı ölçüm (silinmemiş, aynı firma) varsa; mükerrer satırda yok. */
  measurement: { measuredAtLocal: string; dimMethod: DimMethod; weightMethod: WeightMethod } | null;
  photos: EvidencePhoto[];
};

export type DisputeDraft = {
  /** Fotoğraf yolları yalnız bu firmanın klasöründen okunur (B6). */
  companyId: string;
  /** `vatPct`: faturanın bilinen KDV oranı (K43, `invoiceVatPct`); null ise metin yalnız KDV hariç yazar. */
  /**
   * `chargeUnit` (KALANLAR 1.12): metinde ücretli ağırlığın birimi (`disputeChargeUnit`); `divisor`, `edgeRounding` tarife
   * sürümünden (yoksa null): yurt içinde her satırda desi mi gerçek kg mı belirledi (core `chargeableUnitOf`).
   */
  invoice: {
    id: string;
    invoiceNo: string;
    invoiceDate: string;
    currency: string;
    vatPct: number | null;
    chargeUnit: 'kg' | 'desi';
    divisor: number | null;
    edgeRounding: EdgeRounding | null;
    carrier: { name: string; code: string };
  };
  /** `email`, `phone` (KALANLAR 1.12): imzada; istekten (`signatureContact`), yoksa yazılmaz. */
  company: { name: string; contactName: string; email?: string; phone?: string };
  lang: Locale;
  /** Firmanın saat dilimi (ölçüm anı, ZIP giriş tarihleri). */
  timeZone: string;
  /** `buildDisputeText`'e verilen bütün "İtiraz listesinde" satırları (core süzer). */
  allInputs: DisputeLine[];
  /** Metne giren satırlar, metindeki sırayla. */
  lines: DraftLine[];
  /** B3: metnin satır kümesinin özeti (`sendableDigest`, gönderme ile aynı); "Gönderildi olarak işaretle" bunu geri gönderir. */
  selectionDigest: string;
};

/**
 * K43: faturanın KDV oranı, yalnız içe aktarmada biliniyorsa (saklanan eşlemeden, `Invoice.mapping`):
 * - tablo faturası "Tutarlar KDV dahil" ile eşlendiyse eşlemenin oranı (`vatPct`, yoksa %20);
 * - PDF faturada okuma oranı biliyorsa (`{ source: 'ai', vatPct }`, `knownPdfVatPct`).
 * Tutarları KDV hariç eşlenmiş tablo faturasında ve eski PDF faturalarda oran bilinmez: null (metin yalnız KDV hariç).
 * Kural tek yerde; örn. "KDV hariç faturada da %20 varsay" denirse burası değişir.
 */
export function invoiceVatPct(mapping: unknown): number | null {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
  const o = mapping as Record<string, unknown>;
  if (o.source === 'ai') return disputeVatPct(typeof o.vatPct === 'number' ? o.vatPct : null);
  if (o.amountsIncludeVat !== true) return null;
  return disputeVatPct(typeof o.vatPct === 'number' ? o.vatPct : 20);
}

/**
 * KALANLAR 1.12: itiraz metninde ücretli ağırlığın birimi. Yurt içi taşıyıcı ücretli ağırlığı desi diye keser: faturanın
 * tarife sürümünün hacim böleni 3000 ise (desi tanımı) `desi`; fatura dayanaksızsa (sürüm yok) taşıyıcı kodu
 * (`isDomesticCarrier`). Değilse `kg`.
 */
export function disputeChargeUnit(divisor: number | null | undefined, carrierCode: string | null | undefined, carrierName?: string | null): 'kg' | 'desi' {
  if (divisor != null) return divisor === 3000 ? 'desi' : 'kg';
  return isDomesticCarrier(carrierCode, carrierName) ? 'desi' : 'kg';
}

/** İmzanın e-postası ve telefonu istekte bu başlıklarla gelir (değer `encodeURIComponent` ile). */
export const SIGNATURE_EMAIL_HEADER = 'x-signature-email';
export const SIGNATURE_PHONE_HEADER = 'x-signature-phone';

const SIGN_EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/;
const SIGN_PHONE = /^\+?[0-9][0-9 ()-]{4,30}$/;

/**
 * KALANLAR 1.12: itiraz imzasındaki e-posta ve telefon. DeciShip kişinin iletişim bilgisini bilmez ve saklamaz: web Merkez
 * hesabından (`/api/account/me` `person.email`, `person.phone`) okuyup metin ve ZIP isteğine başlıkla ekler (adreste değil,
 * istek günlüğüne girmesin). Kişinin kendi mektubudur, metni pencerede zaten düzenleyebilir; yine de biçimi bozuk, çok uzun
 * ya da satır sonu taşıyan değer yazılmaz. Yoksa imza bugünkü gibi ad ve firma.
 */
export function signatureContact(headers: FastifyRequest['headers']): { email?: string; phone?: string } {
  const read = (name: string): string | null => {
    const raw = headers[name];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (typeof v !== 'string' || !v || v.length > 600) return null;
    try {
      return decodeURIComponent(v).trim();
    } catch {
      return null;
    }
  };
  const email = read(SIGNATURE_EMAIL_HEADER);
  const phone = read(SIGNATURE_PHONE_HEADER);
  return {
    ...(email && email.length <= 254 && SIGN_EMAIL.test(email) ? { email } : {}),
    ...(phone && SIGN_PHONE.test(phone) ? { phone } : {}),
  };
}

/** Firmanın saat diliminde "YYYY-MM-DD HH:mm" (tanım `lib/time.ts`; rapor da kullanır). */
export { zonedDateTimeText };

/**
 * Faturanın itiraz taslağı: metin ve ZIP'in ortak satır kümesi. `GET /invoices/:id/dispute` de bunu kullanabilir.
 * Hatalar: 404 fatura yok (ya da başka firmanın), 403 fiyat izni yok, 400 `NO_VERIFIED_LINES` (listede satır yok ya da hiçbiri
 * artık itiraz edilebilir değil).
 */
export async function loadDisputeDraft(req: FastifyRequest, invoiceId: string, lang: Locale): Promise<DisputeDraft> {
  // Metin talep tutarlarını taşır: fiyat görme izni olmayan kişiye hiç üretilmez (app.ts `stripMoney` metnin içine bakmaz).
  if (!can(req, 'deciship.prices.view')) throw forbiddenFor(req);
  const companyId = req.auth.orgId;
  const inv = await prisma.invoice.findFirst({ where: { id: invoiceId, companyId, deletedAt: null }, include: { carrier: true } });
  if (!inv || inv.carrier.companyId !== companyId) throw notFound(m('invoice.notFound'));
  // B2: satır kümesi gönderme ile tek kaynaktan (`sendableLines`): "İtiraz listesinde", fark var, talebi > 0 ve geçerli sonucu
  // RECOVERED olmayan. Böylece ikinci turda metin, geri alınmış (ödenmiş) satırı yeniden talep etmez ve kaydedilen turla aynıdır.
  const [company, rows, sendable, pricing] = await Promise.all([
    prisma.company.findFirstOrThrow({ where: { id: companyId } }),
    prisma.invoiceLine.findMany({
      where: { invoiceId, companyId, decision: 'VERIFIED' },
      include: {
        measurement: {
          include: {
            files: {
              where: { companyId, kind: { in: [...PHOTO_KINDS] } },
              select: { id: true, kind: true, path: true, mime: true, size: true, companyId: true },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            },
          },
        },
      },
      orderBy: [{ rowIndex: 'asc' }, { id: 'asc' }],
    }),
    sendableLines(prisma, companyId, invoiceId),
    // KALANLAR 1.12: ücretli ağırlığın birimi faturanın tarife sürümünden (bölen)
    loadPricingTariff(companyId, inv.tariffRevisionId),
  ]);
  if (!rows.length) throw badRequest('NO_VERIFIED_LINES', m('dispute.noVerifiedLines'));
  const { timeZone } = readSettings(company.settings);
  const inSet = new Set(sendable.map((l) => l.id));

  const pairs = rows.filter((l) => inSet.has(l.id)).map((l) => {
    const diffTypes = l.diffTypes as DiffType[];
    const alive = l.measurement && !l.measurement.deletedAt && l.measurement.companyId === companyId ? l.measurement : null;
    // Kanıt yalnız canlı, aynı firmadaki ölçümden; mükerrer satırda ölçüm konu değil (core da yazmaz).
    const live = alive && !diffTypes.includes('DUPLICATE') ? alive : null;
    const input: DisputeLine = {
      trackingNo: l.trackingNo,
      shipDate: l.shipDate ? l.shipDate.toISOString().slice(0, 10) : null,
      diffTypes,
      decision: l.decision,
      status: l.status,
      // B11: "Ölçümümüz" ölçü ve ağırlığı yalnız canlı ölçümden (silinmiş ölçüm kargo firmasına kanıt diye yazılmaz).
      ourDims: alive ? { l: num(alive.lengthCm), w: num(alive.widthCm), h: num(alive.heightCm) } : null,
      ourActualKg: alive ? num(alive.weightKg) : null,
      ourChargeableKg: numOrNull(l.ourChargeableKg),
      billedDims: l.dimL != null && l.dimW != null && l.dimH != null ? { l: num(l.dimL), w: num(l.dimW), h: num(l.dimH) } : null,
      billedActualKg: numOrNull(l.actualKg),
      billedChargeableKg: numOrNull(l.billedChargeableKg),
      expectedAmount: numOrNull(l.expectedAmount),
      billedAmount: num(l.netAmount),
      diffAmount: numOrNull(l.diffAmount),
      surcharges: (Array.isArray(l.surcharges) ? l.surcharges : []) as { code: string; name?: string; amount: number }[],
    };
    const photos: EvidencePhoto[] = live
      ? live.files.filter((f) => f.companyId === companyId).map((f) => ({ id: f.id, kind: f.kind as PhotoKind, path: f.path, mime: f.mime, size: f.size }))
      : [];
    return {
      row: l,
      input,
      measurement: live ? { measuredAtLocal: zonedDateTimeText(live.measuredAt, timeZone), dimMethod: live.dimMethod as DimMethod, weightMethod: live.weightMethod as WeightMethod } : null,
      photos,
    };
  });

  const lines: DraftLine[] = pairs
    .filter((p) => isDisputable(p.input))
    .map((p, i) => ({ lineId: p.row.id, index: i + 1, trackingNo: p.row.trackingNo, input: p.input, measurement: p.measurement, photos: p.photos }));
  // doğrulanmış satırların hepsi yeniden karşılaştırmada uyumlu çıktıysa itiraz edilecek satır kalmaz
  if (!lines.length) throw badRequest('NO_VERIFIED_LINES', m('dispute.noDiffLines'));

  return {
    companyId,
    invoice: {
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      invoiceDate: inv.invoiceDate.toISOString().slice(0, 10),
      currency: inv.currency,
      vatPct: invoiceVatPct(inv.mapping),
      chargeUnit: disputeChargeUnit(pricing?.input.divisor ?? null, inv.carrier.code, inv.carrier.name),
      divisor: pricing?.input.divisor ?? null,
      edgeRounding: pricing?.input.edgeRounding ?? null,
      carrier: { name: inv.carrier.name, code: inv.carrier.code },
    },
    company: { name: company.name, contactName: req.auth.name, ...signatureContact(req.headers) },
    lang,
    timeZone,
    allInputs: pairs.map((p) => p.input),
    lines,
    // Özet metnin kendi satırlarından ve rakamlarından: iki okuma (satırlar, gönderilecek küme) arasında bir satır yeniden
    // hesaplanırsa ya da kümeye girip çıkarsa metin ile özet yine aynı şeyi anlatır; gönderme kilit altında bugünküyle
    // karşılaştırır, tutmazsa 409. (`sendable`'ın özeti metinde olmayan bir rakamı onaylatabilirdi.)
    selectionDigest: sendableDigest(lines.map((l) => ({ id: l.lineId, trackingNo: l.trackingNo, claim: disputeClaim(l.input), currency: inv.currency }))),
  };
}

/** Disk okuması aynı anda en çok bu kadar (her biri bir fotoğrafı belleğe alır: en çok 4 × 8 MB). */
const READ_CONCURRENCY = 4;

/**
 * 06-B5: fotoğrafın üst verisinin temizlenebilir olup olmadığı (kimlik → diskteki boyut, değişme anı, sonuç). İtiraz
 * penceresi her açılışta (dil değişince de) ve ZIP'in ön taraması bütün fotoğrafları diskten okuyup yeniden tarıyordu.
 * Saklanan dosya değişmez (`storeBuffer` yeni ad yazar); boyut ya da değişme anı farklıysa sonuç yeniden hesaplanır.
 * Süreç içidir, en çok `CLEAN_CACHE_MAX` kayıt (kayıt başına ~100 bayt). Sayma kuralı aynıdır (`locateEvidencePhotos`):
 * yalnız aynı dosyanın ikinci taraması atlanır. ZIP'e girerken her fotoğraf yine yeniden temizlenir (son güvence).
 */
const CLEAN_CACHE_MAX = 50_000;
const cleanCache = new Map<string, { size: number; mtimeMs: number; clean: boolean }>();

function cleanOutcomeOf(fileId: string, st: { size: number; mtimeMs: number }): boolean | undefined {
  const hit = cleanCache.get(fileId);
  return hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs ? hit.clean : undefined;
}

function rememberCleanOutcome(fileId: string, st: { size: number; mtimeMs: number }, clean: boolean) {
  cleanCache.delete(fileId);
  cleanCache.set(fileId, { size: st.size, mtimeMs: st.mtimeMs, clean });
  if (cleanCache.size > CLEAN_CACHE_MAX) cleanCache.delete(cleanCache.keys().next().value!);
}

/** Testler: önbelleği boşaltır. */
export function clearEvidenceCleanCache() {
  cleanCache.clear();
}

export type LocatedPhotos = {
  /** ZIP'e girebilen fotoğraf: diskte, firmanın klasöründe, üst verisi temizlenebiliyor. Kimlik → yol ve diskteki boyut. */
  found: Map<string, { abs: string; size: number }>;
  /** Diskte ama üst verisi temizlenemiyor (okunamayan yapı, HEIC…): ZIP'e girmez, iç notta ayrı nedenle yazılır. */
  unclean: Set<string>;
  /** false: kayıt sayısı ya da boyutu ZIP sınırını aşıyor, disk taranmadı (B6); sayılar kayıttan. */
  checked: boolean;
};

/**
 * Y54 (Y124 E3) ve Y24 (inceleme B3): kanıt fotoğrafının sayılma kuralı, tek yer. Fotoğraf ancak dosyası diskte,
 * firmanın kendi klasöründe (`<companyId>/…`) ve üst verisi temizlenebiliyorsa vardır (`stripImageMetadata`: temizlenmiş
 * ya da zaten temiz). İtiraz penceresindeki metin ve sayılar (`renderDisputeText`) ile ZIP (`streamEvidenceZip`) bu
 * işlevin sonucunu kullanır. Saklanan dosyaya dokunulmaz. Kayıtlı fotoğraf sayısı `EVIDENCE_MAX_PHOTOS`'u ya da kayıtlı
 * boyut `EVIDENCE_MAX_BYTES`'ı aşıyorsa disk taranmaz (ZIP zaten 413): sayılar kayıttan (`checked: false`).
 */
export async function locateEvidencePhotos(draft: DisputeDraft): Promise<LocatedPhotos> {
  const photos = draft.lines.flatMap((l) => l.photos);
  const found = new Map<string, { abs: string; size: number }>();
  const unclean = new Set<string>();
  if (photos.length > EVIDENCE_MAX_PHOTOS || photos.reduce((n, p) => n + p.size, 0) > EVIDENCE_MAX_BYTES) {
    for (const p of photos) found.set(p.id, { abs: '', size: p.size });
    return { found, unclean, checked: false };
  }
  let next = 0;
  const worker = async () => {
    while (next < photos.length) {
      const photo = photos[next++]!;
      const st = await statStored(draft.companyId, photo.path);
      if (!st) continue;
      // 06-B5: aynı dosyanın (boyutu ve değişme anı aynı) temizlenebilirliği önceden bilindiyse içerik yeniden okunmaz
      let clean = cleanOutcomeOf(photo.id, st);
      if (clean === undefined) {
        let data: Buffer;
        try {
          data = await fs.readFile(st.abs);
        } catch {
          continue; // denetimle okuma arasında kayboldu
        }
        clean = isCleanOutcome(stripImageMetadata(data).outcome);
        rememberCleanOutcome(photo.id, st, clean);
      }
      if (clean) found.set(photo.id, { abs: st.abs, size: st.size });
      else unclean.add(photo.id);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, photos.length) }, worker));
  return { found, unclean, checked: true };
}

/**
 * `GET /invoices/:id/dispute`: taslaktan metin; fotoğraf sayıları yalnız diskte bulunan dosyalarla (`locateEvidencePhotos`,
 * ZIP ile aynı kural). Yanıt `{ subject, body, lineCount, total, vatPct?, totalInclVat?, photoCount, linesWithoutPhoto }`
 * (`vatPct`, `totalInclVat` yalnız faturanın KDV oranı biliniyorsa, K43).
 */
export async function renderDisputeText(draft: DisputeDraft) {
  return { ...disputeTextFor(draft, new Set((await locateEvidencePhotos(draft)).found.keys())), selectionDigest: draft.selectionDigest };
}

/** Metin, verilen (diskte bulunmuş) fotoğraf kümesiyle. ZIP içindeki metin ZIP'in içeriğini anlatır. */
function disputeTextFor(draft: DisputeDraft, present: ReadonlySet<string>) {
  const byInput = new Map(draft.lines.map((l) => [l.input, l]));
  const counted = (l: DraftLine) => l.photos.filter((p) => present.has(p.id)).length;
  const result = buildDisputeText({
    company: draft.company,
    carrier: draft.invoice.carrier,
    invoice: {
      invoiceNo: draft.invoice.invoiceNo,
      invoiceDate: draft.invoice.invoiceDate,
      currency: draft.invoice.currency,
      vatPct: draft.invoice.vatPct,
      chargeUnit: draft.invoice.chargeUnit,
      divisor: draft.invoice.divisor,
      ...(draft.invoice.edgeRounding ? { edgeRounding: draft.invoice.edgeRounding } : {}),
    },
    lang: draft.lang,
    lines: draft.allInputs.map((input) => {
      const l = byInput.get(input);
      if (!l?.measurement) return { ...input, evidence: null };
      return { ...input, evidence: { ...l.measurement, photoCount: counted(l) } };
    }),
  });
  const photoCount = draft.lines.reduce((n, l) => n + counted(l), 0);
  // Fotoğrafı olmayan (mükerrer olmayan) satır: kullanıcı göndermeden önce bilsin.
  const linesWithoutPhoto = draft.lines.filter((l) => !l.input.diffTypes.includes('DUPLICATE') && counted(l) === 0).length;
  // K43: oran biliniyorsa toplamın KDV dahil hâli de (pencerenin özet satırı; metindeki toplamla aynı hesap)
  const vat = draft.invoice.vatPct;
  const vatFields = vat != null ? { vatPct: vat, totalInclVat: withVat(result.total, vat) } : {};
  return { subject: result.subject, body: result.body, lineCount: result.lineCount, total: result.total, ...vatFields, photoCount, linesWithoutPhoto };
}

/** Takip no ZIP adında: yalnız ASCII harf ve rakam, en çok 40 karakter. */
function safeTracking(trackingNo: string): string {
  const s = trackingNo.replace(/[^A-Za-z0-9]+/g, '').slice(0, 40);
  return s || 'x';
}

function kindLabel(kind: PhotoKind, lang: Locale): string {
  const label = m(`evidence.kind.${kind}`, undefined, lang).toLowerCase().replace(/[^a-z0-9]+/g, '');
  return label || 'photo';
}

export type EvidenceEntryName = { photo: EvidencePhoto; name: string; line: { index: number; trackingNo: string } };
type EvidencePlanItem = EvidenceEntryName & { abs: string };

/**
 * ZIP içi adlar: `NN-<takipNo>-<tür>-<n>.<uzantı>`. NN metindeki satır no (en az iki hane), n aynı satır ve türde 1'den sayaç.
 */
export function evidenceEntryNames(draft: DisputeDraft): EvidenceEntryName[] {
  const width = Math.max(2, String(draft.lines.length).length);
  const out: EvidenceEntryName[] = [];
  for (const line of draft.lines) {
    const counters = new Map<PhotoKind, number>();
    for (const photo of line.photos) {
      const n = (counters.get(photo.kind) ?? 0) + 1;
      counters.set(photo.kind, n);
      const ext = PHOTO_EXT[photo.mime.toLowerCase()] ?? 'bin';
      out.push({ photo, line: { index: line.index, trackingNo: line.trackingNo }, name: `${String(line.index).padStart(width, '0')}-${safeTracking(line.trackingNo)}-${kindLabel(photo.kind, draft.lang)}-${n}.${ext}` });
    }
  }
  return out;
}

const tooLarge = () => new AppError(413, 'EVIDENCE_TOO_LARGE', m('err.evidenceTooLarge'));

/**
 * Dosya diskte var mı, boyutu ne. Kayıt duruyor ama dosya yoksa, yol geçersizse ya da firmanın kendi klasöründe değilse
 * (`fileCleanup.ts` ile aynı koruma; `storeBuffer`: `<companyId>/<ay>/<uuid>.<uzantı>`) null: ZIP'te atlanır.
 */
async function statStored(companyId: string, rel: string): Promise<{ abs: string; size: number; mtimeMs: number } | null> {
  let abs: string;
  try {
    abs = absolutePath(rel);
  } catch {
    return null;
  }
  if (!abs.startsWith(path.resolve(env.storageDir, companyId) + path.sep)) return null;
  try {
    const st = await fs.stat(abs);
    return st.isFile() ? { abs, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * Eksik fotoğraf listesi: firmanın kendisi için iç not, kargo firmasına giden mektuba girmez. Satır başına metindeki satır no,
 * takip no ve ZIP'te olması gereken dosya adı (türü adından okunur).
 */
function missingFileText(missing: EvidenceEntryName[], unclean: EvidenceEntryName[], lang: Locale): string {
  const lines = (list: EvidenceEntryName[]) =>
    // eslint-disable-next-line no-control-regex -- kontrol karakterleri kanıt metnine bilerek girmez, boşluğa çevrilir
    list.map((p) => m('evidence.missingLine', { index: p.line.index, trackingNo: p.line.trackingNo.replace(/[\u0000-\u001f\u007f]+/g, ' '), file: p.name }, lang));
  const sections: string[] = [];
  if (missing.length) sections.push([m('evidence.missing', { count: missing.length }, lang), '', ...lines(missing)].join('\n'));
  // Y24 (B3): dosya var ama konum ve cihaz bilgisi temizlenemedi: gizlilik için ZIP'e konmadı
  if (unclean.length) sections.push([m('evidence.unclean', { count: unclean.length }, lang), '', ...lines(unclean)].join('\n'));
  return sections.join('\n\n');
}

/** Metin dosyası: Not Defteri'nde Türkçe harfler doğru görünsün (UTF-8 BOM, CRLF). */
function textFile(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')]);
}

/**
 * `GET /invoices/:id/dispute/evidence.zip`. İçerik: `00-itiraz-metni.txt` (EN: `00-dispute-letter.txt`) + fotoğraflar; eksik
 * fotoğraf varsa sonda iç not `01-eksik-dosyalar.txt` (EN: `01-missing-files.txt`). Giriş tarihleri firmanın saat diliminde.
 * Rota `deciship.data.export` ve `limited()` ile sarılır; burada ayrıca fiyat (metin) ve bütün ölçümleri görme (fotoğraf) izni aranır.
 */
export async function streamEvidenceZip(req: FastifyRequest, reply: FastifyReply, invoiceId: string, lang: Locale) {
  // Fotoğraflar firmanın bütün ölçümlerinden: dosya ucundaki "hepsini görme" izniyle aynı kural.
  if (!can(req, 'deciship.measurements.view_all')) throw forbiddenFor(req);
  const draft = await loadDisputeDraft(req, invoiceId, lang);
  const planned = evidenceEntryNames(draft);

  // Sınır akıştan önce: önce kayıtlı sayı ve boyut (diske dokunmadan), sonra diskteki gerçek boyut.
  if (planned.length > EVIDENCE_MAX_PHOTOS) throw tooLarge();
  if (planned.reduce((n, p) => n + p.photo.size, 0) > EVIDENCE_MAX_BYTES) throw tooLarge();
  // Diskte bulunan ve temizlenebilenler: itiraz penceresinin saydığıyla aynı işlev (Y54, Y24 B3).
  const located = await locateEvidencePhotos(draft);
  const items: EvidencePlanItem[] = [];
  let bytes = 0;
  for (const p of planned) {
    const st = located.found.get(p.photo.id);
    if (!st) continue;
    bytes += st.size;
    if (bytes > EVIDENCE_MAX_BYTES) throw tooLarge();
    items.push({ ...p, abs: st.abs });
  }
  const included = new Set(items.map((i) => i.photo.id));
  const unclean: EvidenceEntryName[] = planned.filter((p) => located.unclean.has(p.photo.id));
  const missing: EvidenceEntryName[] = planned.filter((p) => !included.has(p.photo.id) && !located.unclean.has(p.photo.id));

  // Mektup kargo firmasına gider: fotoğraf sayıları ZIP'te olanlara göre; eksik notu mektuba değil, ayrı dosyaya.
  const text = disputeTextFor(draft, included);
  const now = new Date();
  const letter: ZipEntry = { name: `${m('evidence.textFile', undefined, lang)}.txt`, data: textFile([text.subject, '', text.body].join('\n')), mtime: now };

  await audit(req.auth.orgId, req.auth.membershipId, 'invoice.evidenceExport', 'Invoice', invoiceId, {
    lines: draft.lines.length,
    photos: items.length,
    missing: missing.length,
    unclean: unclean.length,
  });

  const log = req.log;
  async function* entries(): AsyncGenerator<ZipEntry> {
    yield letter;
    let written = 0;
    for (const item of items) {
      let data: Buffer;
      try {
        data = await fs.readFile(item.abs);
      } catch (e) {
        // Denetimden sonra silinmiş: atlanır (metindeki sayı bir eksik kalır, nadir yarış).
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          log.warn({ fileId: item.photo.id }, 'evidence photo vanished during export');
          missing.push(item);
          continue;
        }
        throw e;
      }
      // Y24 (B3): her fotoğraf ZIP'e girerken yeniden temizlenir (bu değişiklikten önce saklananlar dahil); saklanan dosya
      // değişmez. Bu arada temizlenemez olduysa ZIP'e girmez, iç nota yazılır (metindeki sayı bir fazla kalır, nadir yarış).
      const clean = stripImageMetadata(data);
      if (!isCleanOutcome(clean.outcome)) {
        log.warn({ fileId: item.photo.id, outcome: clean.outcome }, 'evidence photo metadata could not be removed: left out of ZIP');
        unclean.push(item);
        continue;
      }
      data = clean.buffer;
      written += data.length;
      // Dosya denetimden sonra büyüdüyse sınır yine geçerli: akış kesilir, arşiv tamamlanmış görünmez.
      if (written > EVIDENCE_MAX_BYTES) throw new Error('Evidence ZIP exceeded the size limit while streaming');
      yield { name: item.name, data, mtime: now };
    }
    // Sonda: akış sırasında kaybolanlar da listeye girer.
    if (missing.length || unclean.length) {
      yield { name: `${m('evidence.missingFile', undefined, lang)}.txt`, data: textFile(missingFileText(missing, unclean, lang)), mtime: now };
    }
  }

  const fileName = `${m('evidence.fileName', { no: draft.invoice.invoiceNo.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) }, lang)}.zip`;
  return reply
    .header('Content-Type', 'application/zip')
    .header('Content-Disposition', `attachment; filename="${fileName}"`)
    .header('Cache-Control', 'private, no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(zipStream(entries(), { timeZone: draft.timeZone }));
}
