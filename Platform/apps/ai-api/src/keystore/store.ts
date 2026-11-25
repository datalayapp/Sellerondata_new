import { randomUUID } from 'node:crypto';
import { AI_PROVIDERS, type AiAdminKey, type AiKeySource, type AiProvider, type AiProviderState } from '@sellerondata/contracts';
import type { Prisma, PrismaClient } from '../db.ts';
import type { ProviderProbe } from './probe.ts';
import { registerSecret } from './scrub.ts';
import { keyAad, needsReseal, openSecret, sealedKeyId, sealSecret, SealError, type MasterKeyRing } from './seal.ts';

/**
 * Anahtar deposu: sağlayıcı anahtarını mühürleyip saklar (`ProviderKey`), açar, sınar, kaldırır, ana anahtarı döndürür.
 * - Düz anahtar yalnız bu sınıfın içinde ve vekilin (G2) yukarı akış isteğinde bulunur; hiçbir yanıta, günlüğe, hata metnine ya da
 *   yönetici kaydına yazılmaz. Dışarıya yalnız `AiAdminKey` (son 4 hane, kim, ne zaman, son sınama) çıkar.
 * - Girişte önce sınanır: sağlayıcı reddederse ya da ulaşılamazsa kaydedilmez.
 * - Açılmış anahtar süreç belleğinde en çok `CACHE_MS` tutulur (her çağrıda veritabanına gidilmesin); bu süreçteki değiştirme ve
 *   kaldırma önbelleği hemen düşürür.
 * Bugün tek kapsam `platform` (sağlayıcı başına bir satır); firmanın kendi anahtarı (`org`) ileride aynı tabloda.
 */

export type KeyActor = { id: string; name: string };
/** Güncel ana anahtarla mühürlenmemiş satır. `inRing`: mührün ana anahtarı halkada (`AI_KEY_MASTER_PREVIOUS`) var mı. Gizli değer yok. */
export type StaleSeal = { provider: AiProvider; scope: string; inRing: boolean };
/** Mühür durumu: döndürme bekleyen satırlar, toplam satır, halkadaki eski ana anahtar sayısı. */
export type SealStatus = { stale: StaleSeal[]; total: number; previousKeys: number };

/**
 * Güncel ana anahtarla (`AI_KEY_MASTER`) mühürlenmemiş satırları sayar (tüm kapsamlar). Satır varsa eski ana anahtar ortamdan
 * çıkarılmamalı: `ai-key rotate-master` gerekir; anahtarı halkada olmayan satır hiç açılmaz. Açılış uyarısı ve `ai-key status` kullanır.
 */
export async function sealStatusOf(prisma: PrismaClient, ring: MasterKeyRing): Promise<SealStatus> {
  const rows = await prisma.providerKey.findMany({ select: { provider: true, scope: true, sealed: true }, orderBy: { setAt: 'asc' } });
  const stale = rows
    .filter((r) => needsReseal(r.sealed, ring))
    .map((r) => {
      const kid = sealedKeyId(r.sealed);
      return { provider: r.provider as AiProvider, scope: r.scope, inRing: !!kid && ring.previous.some((k) => k.kid === kid) };
    });
  return { stale, total: rows.length, previousKeys: ring.previous.length };
}

/**
 * Açılış denetimi: güncel ana anahtarla mühürlenmemiş satır varsa uyarı metni, yoksa null. Veritabanına ulaşılamazsa da null döner
 * (açılışı durdurmaz; `warn` yalnız hata türünü alır).
 */
export async function startupSealWarning(prisma: PrismaClient, ring: MasterKeyRing, onError?: (errName: string) => void): Promise<string | null> {
  try {
    const seal = await sealStatusOf(prisma, ring);
    return seal.stale.length > 0 ? staleWarning(seal) : null;
  } catch (e) {
    onError?.((e as Error)?.name ?? 'Error');
    return null;
  }
}

/** Güncel ana anahtarla mühürlenmemiş satır uyarısı (`ai-key status`, `rotate-master`, açılış günlüğü). Gizli değer yok. */
export function staleWarning(seal: SealStatus): string {
  const where = seal.stale.map((s) => (s.scope === 'platform' ? s.provider : `${s.provider} (${s.scope})`)).join(', ');
  const lost = seal.stale.filter((s) => !s.inRing).length;
  return [
    `Uyarı: ${seal.stale.length} anahtar güncel ana anahtarla (AI_KEY_MASTER) mühürlü değil: ${where}.`,
    'AI_KEY_MASTER_PREVIOUS ortamdan çıkarılmamalı; `ai-key rotate-master --operator <ad>` çalıştırın.',
    ...(lost > 0 ? [`${lost} satırın ana anahtarı halkada yok (açılamaz): eski anahtarı AI_KEY_MASTER_PREVIOUS'a ekleyin.`] : []),
  ].join(' ');
}
export type SetKeyResult = { ok: true; key: AiAdminKey } | { ok: false; reason: 'rejected' | 'unreachable'; httpStatus: number | null };
export type ProviderSecret = { key: string; keySource: AiKeySource; keyId: string };

/** Anahtar biçimi: görünür ASCII, boşluksuz, 20..512 karakter. Önek denetlenmez (sağlayıcı değiştirebilir); sınama karar verir. */
export const PROVIDER_KEY_PATTERN = /^[\x21-\x7e]{20,512}$/;

const CACHE_MS = 30_000;
const PLATFORM = { scope: 'platform', orgId: null } as const;

type Row = Awaited<ReturnType<PrismaClient['providerKey']['findFirst']>> & {};

export class KeyFormatError extends Error {
  constructor() {
    super('anahtar biçimi geçersiz');
    this.name = 'KeyFormatError';
  }
}

export class KeyStore {
  private cache = new Map<AiProvider, { secret: ProviderSecret; at: number }>();
  private readonly now: () => Date;

  constructor(
    private readonly deps: {
      prisma: PrismaClient;
      ring: () => MasterKeyRing;
      probe: ProviderProbe;
      now?: () => Date;
      /** Açılamayan mühür (yanlış ana anahtar, bozulmuş satır): gizli değer içermeyen olay. */
      onSealError?: (info: { provider: AiProvider; reason: SealError['reason'] }) => void;
    },
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  private row(provider: AiProvider): Promise<Row | null> {
    return this.deps.prisma.providerKey.findFirst({ where: { scope: PLATFORM.scope, orgId: null, provider } });
  }

  private view(provider: AiProvider, row: Row | null): AiAdminKey {
    if (!row) return { provider, state: 'missing', last4: null, setBy: null, setAt: null, lastTest: null };
    return {
      provider,
      state: row.rejectedAt ? 'rejected' : 'ok',
      last4: row.last4,
      setBy: row.setByName,
      setAt: row.setAt.toISOString(),
      lastTest: row.lastTestAt ? { at: row.lastTestAt.toISOString(), ok: row.lastTestOk === true, httpStatus: row.lastTestHttpStatus ?? null } : null,
    };
  }

  private audit(tx: Prisma.TransactionClient | PrismaClient, actor: KeyActor, action: string, provider: AiProvider | null, detail?: Record<string, unknown>) {
    return tx.adminAudit.create({
      data: { id: randomUUID(), actorId: actor.id, actorName: actor.name, action, provider, ...(detail ? { detail: detail as Prisma.InputJsonValue } : {}) },
    });
  }

  /** Her sağlayıcı bir satır, `AI_PROVIDERS` sırasıyla. */
  async list(): Promise<AiAdminKey[]> {
    const rows = await this.deps.prisma.providerKey.findMany({ where: { scope: PLATFORM.scope, orgId: null } });
    return AI_PROVIDERS.map((p) => this.view(p, rows.find((r) => r.provider === p) ?? null));
  }

  async get(provider: AiProvider): Promise<AiAdminKey> {
    return this.view(provider, await this.row(provider));
  }

  async providerStates(): Promise<Record<AiProvider, AiProviderState>> {
    const keys = await this.list();
    return Object.fromEntries(keys.map((k) => [k.provider, k.state])) as Record<AiProvider, AiProviderState>;
  }

  /**
   * Önce sınar, kabul edilirse eski anahtarın yerine mühürleyip yazar. Biçim bozuksa `KeyFormatError`. `skipTest` yalnız acil durum
   * komutunda (`ai-key set --no-test`, sağlayıcıya ulaşılamazken): sınama sonucu boş kalır.
   */
  async set(provider: AiProvider, rawKey: string, actor: KeyActor, opts: { skipTest?: boolean } = {}): Promise<SetKeyResult> {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!PROVIDER_KEY_PATTERN.test(key)) throw new KeyFormatError();
    registerSecret(key);
    const probe = opts.skipTest ? null : await this.deps.probe(provider, key);
    if (probe && probe.kind !== 'ok') {
      await this.audit(this.deps.prisma, actor, 'key.set_refused', provider, { reason: probe.kind, httpStatus: probe.httpStatus });
      return { ok: false, reason: probe.kind, httpStatus: probe.httpStatus };
    }
    const ring = this.deps.ring();
    const at = this.now();
    const sealed = sealSecret(key, keyAad({ ...PLATFORM, provider }), ring);
    const last4 = key.slice(-4);
    const row = await this.deps.prisma.$transaction(async (tx) => {
      await tx.providerKey.deleteMany({ where: { scope: PLATFORM.scope, orgId: null, provider } });
      const created = await tx.providerKey.create({
        data: {
          id: randomUUID(),
          scope: PLATFORM.scope,
          orgId: null,
          provider,
          sealed,
          masterKeyId: ring.current.kid,
          last4,
          setById: actor.id,
          setByName: actor.name,
          setAt: at,
          lastTestAt: probe ? at : null,
          lastTestOk: probe ? true : null,
          lastTestHttpStatus: probe?.httpStatus ?? null,
        },
      });
      await this.audit(tx, actor, 'key.set', provider, { last4, masterKeyId: ring.current.kid, tested: probe !== null });
      return created;
    });
    this.cache.set(provider, { secret: { key, keySource: 'platform', keyId: row.id }, at: Date.now() });
    return { ok: true, key: this.view(provider, row) };
  }

  /** Kaldırır; yoksa da `missing` döner (kayıt yalnız silindiyse yazılır). */
  async remove(provider: AiProvider, actor: KeyActor): Promise<AiAdminKey> {
    this.cache.delete(provider);
    await this.deps.prisma.$transaction(async (tx) => {
      const gone = await tx.providerKey.deleteMany({ where: { scope: PLATFORM.scope, orgId: null, provider } });
      if (gone.count > 0) await this.audit(tx, actor, 'key.remove', provider);
    });
    this.cache.delete(provider);
    return this.view(provider, null);
  }

  /** Kayıtlı anahtarı ücretsiz sınar, sonucu yazar. Anahtar yoksa null. Mühür açılamazsa `SealError`. */
  async test(provider: AiProvider, actor: KeyActor): Promise<AiAdminKey | null> {
    const row = await this.row(provider);
    if (!row) return null;
    const key = this.open(row);
    const probe = await this.deps.probe(provider, key);
    const at = this.now();
    const data: Prisma.ProviderKeyUpdateManyMutationInput = { lastTestAt: at, lastTestOk: probe.kind === 'ok', lastTestHttpStatus: probe.httpStatus };
    if (probe.kind === 'ok') data.rejectedAt = null;
    if (probe.kind === 'rejected') data.rejectedAt = at;
    // Sınama sürerken anahtar değiştiyse eski satırın sonucu yenisine yazılmaz (id ile).
    await this.deps.prisma.providerKey.updateMany({ where: { id: row.id }, data });
    await this.audit(this.deps.prisma, actor, 'key.test', provider, { result: probe.kind, httpStatus: probe.httpStatus });
    if (probe.kind === 'rejected') this.cache.delete(provider);
    return this.view(provider, await this.row(provider));
  }

  /**
   * Vekilin (G2) kullandığı düz anahtar. Yoksa ya da mühür açılamıyorsa null (araca `sod_provider_missing`). Değer yalnız yukarı akış
   * isteğinin anahtar başlığına konur.
   */
  async secretFor(provider: AiProvider): Promise<ProviderSecret | null> {
    const hit = this.cache.get(provider);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.secret;
    this.cache.delete(provider);
    const row = await this.row(provider);
    if (!row) return null;
    let key: string;
    try {
      key = this.open(row);
    } catch (e) {
      if (e instanceof SealError) {
        this.deps.onSealError?.({ provider, reason: e.reason });
        return null;
      }
      throw e;
    }
    const secret: ProviderSecret = { key, keySource: 'platform', keyId: row.id };
    this.cache.set(provider, { secret, at: Date.now() });
    return secret;
  }

  /** Vekil: sağlayıcı anahtarı 401/403 ile reddetti (durum `rejected`). `keyId` verilirse yalnız o satır işaretlenir. */
  async markRejected(provider: AiProvider, keyId?: string): Promise<void> {
    this.cache.delete(provider);
    await this.deps.prisma.providerKey.updateMany({
      where: { scope: PLATFORM.scope, orgId: null, provider, rejectedAt: null, ...(keyId ? { id: keyId } : {}) },
      data: { rejectedAt: this.now() },
    });
  }

  /** Vekil: reddedilmiş işaretli anahtar yeniden kabul edildi. */
  async markAccepted(provider: AiProvider, keyId?: string): Promise<void> {
    await this.deps.prisma.providerKey.updateMany({
      where: { scope: PLATFORM.scope, orgId: null, provider, rejectedAt: { not: null }, ...(keyId ? { id: keyId } : {}) },
      data: { rejectedAt: null },
    });
  }

  /** Güncel ana anahtarla mühürlenmemiş satırlar (`sealStatusOf`). */
  sealStatus(): Promise<SealStatus> {
    return sealStatusOf(this.deps.prisma, this.deps.ring());
  }

  /**
   * Ana anahtar döndürme: eski ana anahtarla mühürlü her satırı halkadaki anahtarla açıp güncel anahtarla yeniden mühürler (tek işlem).
   * Açılamayan satır varsa hiçbir şey değişmez (`SealError`). İşlemden sonra eski anahtarla yazan başka bir süreç (eski ortamla
   * çalışan ai-api) yeni satır bırakabilir: eski anahtarı çıkarmadan önce `sealStatus()` boş olmalı.
   */
  async rotateMaster(actor: KeyActor): Promise<{ resealed: number; total: number }> {
    const ring = this.deps.ring();
    const result = await this.deps.prisma.$transaction(async (tx) => {
      const rows = await tx.providerKey.findMany({ orderBy: { setAt: 'asc' } });
      let resealed = 0;
      for (const row of rows) {
        if (!needsReseal(row.sealed, ring)) continue;
        const aad = keyAad(row);
        const plain = openSecret(row.sealed, aad, ring);
        registerSecret(plain);
        await tx.providerKey.update({ where: { id: row.id }, data: { sealed: sealSecret(plain, aad, ring), masterKeyId: ring.current.kid } });
        resealed += 1;
      }
      await this.audit(tx, actor, 'master.rotate', null, { resealed, masterKeyId: ring.current.kid });
      return { resealed, total: rows.length };
    });
    this.cache.clear();
    return result;
  }

  private open(row: Row): string {
    const key = openSecret(row.sealed, keyAad(row), this.deps.ring());
    registerSecret(key);
    return key;
  }
}
