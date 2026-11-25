import { isOrgOpen, runInOrg } from "../../org/context.ts";
import { INSTALL_KEYS } from "../../org/tables.ts";

/** Kurulum genelinde eşzamanlı arka plan işi üst sınırının varsayılanı (SUNUCU-PLANI §2.6). */
export const DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Kurulum geneli üst sınır: `TAGPRESS_MAX_CONCURRENCY` ortam değişkeni, yoksa kurulum ayarı `install.maxConcurrency`,
 * yoksa 4. Geçersiz değer yok sayılır.
 */
export function installMaxConcurrency(settings: { getInstall<T>(key: string, fallback: T): T }, env: NodeJS.ProcessEnv = process.env): number {
  const valid = (v: unknown): number | null => {
    const n = typeof v === "string" ? Number(v.trim()) : typeof v === "number" ? v : Number.NaN;
    return Number.isInteger(n) && n >= 1 ? Math.min(n, 64) : null;
  };
  return valid(env.TAGPRESS_MAX_CONCURRENCY) ?? valid(settings.getInstall<unknown>(INSTALL_KEYS.maxConcurrency, null)) ?? DEFAULT_MAX_CONCURRENCY;
}

/** Bekleyen aday: firma, sıra anahtarı (küçük olan daha eski). */
export interface FairCandidate {
  orgId: string;
  /** Firmanın en eski bekleyen görevinin sıra anahtarı (oluşturulma zamanı ya da sıra numarası). */
  oldest: string | number;
}

/** Kurulum payı: `total` kurulumun yuva sayısı; `reserve` çok firmalı kurulum (başka firma her an iş gönderebilir). */
export interface FairShare {
  total: number;
  reserve: boolean;
}

/**
 * Adil seçim (kuyruk, şablon görevi, öğrenme, baskı çıktısı aynı kural): firma başına sınırı dolmamış adaylardan o an
 * en az işi çalışan firma; eşitse en eski görevi olan. Seçilecek yoksa null. Tek firmada bugünkü sıra (en eski) aynen.
 *
 * Kurulum payı (`share`): başka firmanın bekleyen işi varken en az çalışan seçildiği için bir firma en çok
 * ceil(toplam / bekleyen firma) yuva tutar. İş çalışırken kesilmez; bu yüzden çok firmalı kurulumda (`reserve`) tek
 * başına iş gönderen firma bir yuvayı boş bırakır: sonradan gelen firma beklemeden başlar. Tek firmalı kurulumda
 * (sahibin kurulumu) bütün yuvalar kullanılır; davranış değişmez.
 */
export function pickFair(candidates: readonly FairCandidate[], running: (orgId: string) => number, cap: (orgId: string) => number, share?: FairShare): FairCandidate | null {
  let best: FairCandidate | null = null;
  let bestRunning = Number.POSITIVE_INFINITY;
  const eligible = candidates.filter((c) => running(c.orgId) < Math.max(1, cap(c.orgId)));
  const alone = share?.reserve && share.total > 1 && eligible.length === 1 ? share.total - 1 : Number.POSITIVE_INFINITY;
  for (const c of eligible) {
    const n = running(c.orgId);
    if (n >= alone) continue;
    if (n < bestRunning || (n === bestRunning && best && (c.oldest < best.oldest || (c.oldest === best.oldest && c.orgId < best.orgId)))) {
      best = c;
      bestRunning = n;
    }
  }
  return best;
}

interface Pending {
  seq: number;
  orgId: string;
  run: () => Promise<void>;
  done: () => void;
}

/**
 * Bellek içi adil sıra (şablon görevleri, öğrenme koşuları, baskı çıktıları; bunlar yeniden başlatmada "kesildi" olur,
 * kalıcı sıraları yok). Kurulum genelinde en çok `maxTotal`, firma başına en çok `maxPerOrg` iş aynı anda çalışır.
 * Her iş kendi firmasının bağlamında (`runInOrg`) ve gönderenin çağrı yığınından sonra (mikro görevde) başlar:
 * isteğin bağlamını miras almaz.
 */
export class FairScheduler {
  private seq = 0;
  private readonly pending: Pending[] = [];
  private readonly running = new Map<string, number>();
  private total = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly opts: {
      maxTotal: () => number;
      maxPerOrg: (orgId: string) => number;
      /** Kurulumdaki açık firma sayısı (1'den çoksa tek başına çalışan firma bir yuvayı boş bırakır). */
      orgCount?: () => number;
    },
  ) {}

  /** İşi sıraya alır; iş bitince (hata da olsa) çözülür. İşin hatası burada yutulmaz: çalıştıran kendisi yakalar. */
  submit(orgId: string, run: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pending.push({ seq: this.seq++, orgId, run, done: resolve });
      queueMicrotask(() => this.pump());
    });
  }

  /** Çalışan ve bekleyen iş kalmayınca çözülür. */
  idle(): Promise<void> {
    if (!this.total && !this.pending.length) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  runningOf(orgId: string): number {
    return this.running.get(orgId) ?? 0;
  }

  private pump(): void {
    while (this.pending.length && this.total < Math.max(1, this.opts.maxTotal())) {
      const firsts = new Map<string, Pending>();
      for (const p of this.pending) if (!firsts.has(p.orgId)) firsts.set(p.orgId, p);
      const pick = pickFair(
        [...firsts.values()].map((p) => ({ orgId: p.orgId, oldest: p.seq })),
        (o) => this.runningOf(o),
        (o) => this.opts.maxPerOrg(o),
        { total: Math.max(1, this.opts.maxTotal()), reserve: (this.opts.orgCount?.() ?? 1) > 1 },
      );
      if (!pick) break;
      const item = firsts.get(pick.orgId)!;
      this.pending.splice(this.pending.indexOf(item), 1);
      this.start(item);
    }
    this.notifyIdle();
  }

  private start(item: Pending): void {
    this.total++;
    this.running.set(item.orgId, this.runningOf(item.orgId) + 1);
    const finish = () => {
      this.total--;
      const n = this.runningOf(item.orgId) - 1;
      if (n > 0) this.running.set(item.orgId, n);
      else this.running.delete(item.orgId);
      item.done();
      this.pump();
    };
    let p: Promise<void>;
    try {
      // Kapalı ya da kalıcı silinen firmanın işi başlatılmaz (platform kipi, `isOrgOpen`); sırası boşalır.
      p = isOrgOpen(item.orgId) ? runInOrg(item.orgId, () => item.run()) : Promise.resolve();
    } catch (err) {
      p = Promise.reject(err);
    }
    p.then(finish, finish);
  }

  private notifyIdle(): void {
    if (this.total || this.pending.length) return;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
  }
}
