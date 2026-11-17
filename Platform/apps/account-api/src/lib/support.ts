import { parseArgs, type ParseArgsConfig } from 'node:util';
import { PRODUCT_KEYS, isProductKey, type ProductKey } from '@sellerondata/contracts';
import { disconnectPrisma, prisma, type Prisma } from '../db.ts';
import { writeAudit } from './audit.ts';
import { normalizePhone } from './identity.ts';
import { assertLaunchConfig } from './launch.ts';
import { applyMemberUpdate, bumpPersonEpochs, lockMemberships, lockPerson, revokeInvitationsBy, revokeResetCodesFor } from './members.ts';
import { revokeAllSessions } from './sessions.ts';

/** Destek komutları kim tarafından çalıştırıldığını açıkça söyler: denetim izi ortam değişkenine güvenmez. */
export function requireOperator(operator: string | undefined): string {
  const name = (operator ?? '').trim();
  if (!name) throw new Error('operator zorunlu: komutu çalıştıran kişi.');
  return name;
}

// --- Destek komutlarının ortak kabuğu (scripts/*.ts). Çıkış: 0 başarı ya da değişiklik yok, 1 iş hatası, 2 kullanım hatası ya da eksik onay.

/** Kullanım hatası ya da eksik onay: çıkış 2. */
export class UsageError extends Error {}

/** Firma kimliği UUID biçiminde olmalı: ad ya da yarım kimlikle yanlış firmada komut çalışmasın. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: string | undefined): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function orgIdArg(value: string | undefined): string {
  if (!isUuid(value)) throw new UsageError(`Firma kimliği UUID biçiminde olmalı (org:list ile bulun): ${value ?? '(yok)'}`);
  return value.toLowerCase();
}

export function productArg(value: string | undefined): ProductKey {
  if (!isProductKey(value)) throw new UsageError(`Bilinmeyen ürün: ${value ?? '(yok)'} (kayıtta: ${PRODUCT_KEYS.join(', ')})`);
  return value;
}

/** `--operator` yoksa kullanım hatası: denetim izi kimin çalıştırdığını ortam değişkeninden (USER) almaz. */
export function operatorArg(value: string | undefined): string {
  if (!value?.trim()) throw new UsageError('--operator <ad> zorunlu: komutu çalıştıran kişi (denetim izine yazılır).');
  return value.trim();
}

/** Tam sayı seçenek (`--days`, `--limit`); verilmediyse undefined. */
export function intArg(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = /^[0-9]+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`--${name} ${min} ile ${max} arasında tam sayı olmalı: ${value}`);
  return n;
}

/** `node:util` `parseArgs`, katı kip: bilinmeyen seçenek ya da eksik değer kullanım hatasıdır. */
export function parseCommandArgs<O extends NonNullable<ParseArgsConfig['options']>>(argv: string[], options: O) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** Komut çıktısındaki gün: "5 Şubat 2027" (UTC). */
const DAY_FORMAT = new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export function formatDay(date: Date): string {
  return DAY_FORMAT.format(date);
}

/** Komutu çalıştırır, hatayı çıkış koduna çevirir, bağlantıyı kapatır. `usage` kullanım hatasında stderr'e yazılır. */
export async function runSupportCommand(usage: string, main: () => Promise<number | void>): Promise<void> {
  try {
    // Servisin açılışta reddedeceği `PRODUCT_LAUNCH` ile komut da çalışmaz (çıkış 1): ör. rolü olmayan araca abonelik yazılmasın.
    for (const w of assertLaunchConfig().warnings) console.error(`UYARI: ${w}`);
    process.exitCode = (await main()) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) console.error(err.message);
      console.error(`Kullanım: ${usage}`);
      process.exitCode = 2;
    } else {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } finally {
    await disconnectPrisma();
  }
}

/**
 * Numara yanlış kişide (SMS olmadan sahiplik kanıtlanamıyor, ARCHITECTURE §11). Numarayı kişiden ayırır, açık oturumlar ve jetonlar düşer.
 * Kişinin başka girişi yoksa askıya alır: üyelikler askıya alınır, ürünlere olay gider. Geri almak için `restorePerson`.
 * Sahip olduğu firma varsa durur: OWNER askıda olamaz, önce devir gerekir.
 */
export async function releasePhone(input: string, opts: { operator: string }): Promise<{ personId: string; suspended: boolean }> {
  const operator = requireOperator(opts.operator);
  const phone = normalizePhone(input);
  if (!phone) throw new Error('Telefon numarası geçersiz.');
  return prisma.$transaction(async (tx) => {
    const found = await tx.person.findUnique({ where: { phone }, select: { id: true } });
    if (!found) throw new Error('Bu numarayla kayıtlı kişi bulunamadı.');
    await lockPerson(tx, found.id);
    const person = await tx.person.findUniqueOrThrow({
      where: { id: found.id },
      include: { memberships: { select: { id: true, orgRole: true, status: true } } },
    });
    if (person.phone !== phone) throw new Error('Bu numarayla kayıtlı kişi bulunamadı.');
    const suspended = !person.email;
    if (suspended && person.memberships.some((m) => m.orgRole === 'OWNER')) {
      throw new Error('Kişinin başka girişi yok ve firma sahibi (OWNER). Önce sahiplik devredilmeli veya e-posta eklenmeli.');
    }
    await tx.person.update({
      where: { id: person.id },
      data: { phone: null, phoneVerifiedAt: null, ...(suspended ? { suspendedAt: new Date() } : {}) },
    });
    await revokeResetCodesFor(tx, person.id);
    await revokeAllSessions(tx, person.id);
    // Geri alma yalnız bu komutun askıya aldıklarını açar: yöneticinin önceden askıya aldığı üyelik askıda kalır.
    const suspendedMemberships = suspended ? person.memberships.filter((m) => m.status === 'ACTIVE').map((m) => m.id) : [];
    if (suspended) {
      if (person.memberships.length) await lockMemberships(tx, person.memberships.map((m) => m.id));
      for (const id of suspendedMemberships) {
        await applyMemberUpdate(tx, id, { status: 'SUSPENDED' });
        await revokeInvitationsBy(tx, id);
      }
    } else {
      await bumpPersonEpochs(tx, person.id);
    }
    await writeAudit(tx, {
      actor: {},
      action: 'support.phone_released',
      target: person.id,
      meta: { phoneLast4: phone.slice(-4), suspended, operator, suspendedMemberships } as Prisma.InputJsonValue,
    });
    return { personId: person.id, suspended };
  });
}

/**
 * `releasePhone`in tersi: askıyı kaldırır, numarayı yazar, komutun askıya aldığı üyelikleri açar. Şifre değişmez.
 * Numara gerekir (e-postası olmayan kişinin başka kimliği yok). Düz numara saklanmadığı için destek numarayı kişiden alır.
 */
export async function restorePerson(personId: string, opts: { phone?: string; operator: string }): Promise<{ personId: string; reactivated: number }> {
  const operator = requireOperator(opts.operator);
  const phone = opts.phone ? normalizePhone(opts.phone) : null;
  if (opts.phone && !phone) throw new Error('Telefon numarası geçersiz.');
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, personId);
    const person = await tx.person.findUnique({ where: { id: personId } });
    if (!person) throw new Error('Kişi bulunamadı.');
    if (!person.suspendedAt) throw new Error('Kişi askıda değil.');
    if (!phone && !person.email) throw new Error('Kişinin başka girişi yok: telefon numarası verilmeli.');
    if (phone) {
      const holder = await tx.person.findUnique({ where: { phone }, select: { id: true } });
      if (holder && holder.id !== person.id) throw new Error('Bu numara başka bir kişiye ait. Önce o kişiden ayrılmalı.');
    }
    await tx.person.update({ where: { id: person.id }, data: { suspendedAt: null, ...(phone ? { phone } : {}) } });

    const release = await tx.auditLog.findFirst({
      where: { action: 'support.phone_released', target: person.id },
      orderBy: { createdAt: 'desc' },
    });
    const ids = (release?.meta as { suspendedMemberships?: string[] } | null)?.suspendedMemberships ?? [];
    const existing = await tx.membership.findMany({ where: { id: { in: ids }, personId: person.id, status: 'SUSPENDED' }, select: { id: true } });
    if (existing.length) await lockMemberships(tx, existing.map((m) => m.id));
    for (const m of existing) await applyMemberUpdate(tx, m.id, { status: 'ACTIVE' });

    await writeAudit(tx, {
      actor: {},
      action: 'support.phone_restored',
      target: person.id,
      meta: { phoneLast4: phone ? phone.slice(-4) : null, operator, reactivated: existing.length },
    });
    return { personId: person.id, reactivated: existing.length };
  });
}
