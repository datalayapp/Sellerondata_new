import { mkdirSync } from "node:fs";
import { type CreateLanguage, type Language, emptyProfile } from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import type { EventBus } from "../events.ts";
import { requireFeature } from "../features/service.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail } from "../util/errors.ts";
import { isUuidv7, uuidv7 } from "../util/ids.ts";
import type { ProfileService } from "./profiles.ts";
import type { SettingsService } from "./settings.ts";

interface LanguageRow {
  id: string;
  name: string;
  created_at: string;
  active_version: number | null;
  has_draft: number;
  template_count: number;
}

/**
 * Çocuk satır (profil sürümü, şablon, referans, öneri, oturum) yazmadan önce: dil GEÇERLİ FİRMADA var mı (silinmiş de
 * sayılır; yumuşak silme geri alınabilir). Yoksa `language-not-found` (404). Anahtarlar kurulum genelinde tekil olduğundan
 * başka firmanın dil kimliğiyle satır açılmasını bu engeller.
 */
export function assertLanguageInOrg(db: TenantDb, languageId: string): void {
  if (!db.prepare("SELECT 1 FROM languages WHERE id = ? AND org_id = $org").get(languageId)) throw fail("language-not-found");
}

/** Elle verilen dil kimliğinin biçimi (eski diller ve paketler: `benim-tarzim`); UUID de bu biçime uyar. */
const LANGUAGE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/**
 * Tasarım dilleri (profil + şablonlar + fontlar), geçerli firmanın. Silme yumuşaktır (geri alınabilir).
 * Kimlik: yeni dil UUIDv7 alır (addan türetilmez: firmalar birbirinin dil adlarını kimlikten çıkaramaz). Elle verilen
 * kimlik (eski sistemden aktarım, dil paketi) firmada doluysa `-2`, `-3` … eklenir; `languages.id` bütün kurulumda
 * tekil olduğundan başka bir firmada doluysa yeni UUIDv7 verilir.
 */
export class LanguageService {
  constructor(
    private readonly db: TenantDb,
    private readonly paths: DataPaths,
    private readonly profiles: ProfileService,
    private readonly settings: SettingsService,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  list(): Language[] {
    const rows = this.db
      .prepare(
        `SELECT l.id, l.name, l.created_at,
           (SELECT MAX(version) FROM profile_versions p WHERE p.language_id = l.id AND p.org_id = $org AND p.status = 'published') AS active_version,
           (SELECT COUNT(*) FROM profile_versions p WHERE p.language_id = l.id AND p.org_id = $org AND p.status = 'draft') AS has_draft,
           (SELECT COUNT(*) FROM templates t WHERE t.language_id = l.id AND t.org_id = $org) AS template_count
         FROM languages l WHERE l.org_id = $org AND l.deleted_at IS NULL ORDER BY l.created_at`,
      )
      .all() as unknown as LanguageRow[];
    const def = this.defaultId();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      activeVersion: r.active_version,
      hasDraft: r.has_draft > 0,
      templateCount: r.template_count,
      isDefault: r.id === def,
      createdAt: r.created_at,
    }));
  }

  get(id: string): Language {
    const l = this.list().find((x) => x.id === id);
    if (!l) throw fail("language-not-found");
    return l;
  }

  exists(id: string, includeDeleted = false): boolean {
    const sql = `SELECT 1 FROM languages WHERE id = ? AND org_id = $org ${includeDeleted ? "" : "AND deleted_at IS NULL"}`;
    return !!this.db.prepare(sql).get(id);
  }

  /** Varsayılan dil: ayardaki (silinmemişse), yoksa ilk dil. */
  defaultId(): string | null {
    const id = this.settings.get().defaultLanguageId;
    if (id && this.exists(id)) return id;
    const first = this.db.prepare("SELECT id FROM languages WHERE org_id = $org AND deleted_at IS NULL ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    return first?.id ?? null;
  }

  /** İstekteki dil ya da varsayılan; hiç dil yoksa 409. */
  resolve(id?: string | null): string {
    if (id) {
      if (!this.exists(id)) throw fail("language-not-found");
      return id;
    }
    const def = this.defaultId();
    if (!def) throw fail("no-language");
    return def;
  }

  /**
   * Yeni dil: v1 profil yayınlanmış olarak (boş ya da başka dilden kopya). İstekten gelen `id` YOK SAYILIR, kimlik her
   * zaman UUIDv7'dir: kimlik yanıtta döndüğü için "istenen kimlik başka firmada dolu mu" farkı (yeni UUID ya da istenen)
   * başka firmanın dil kimliğinin varlığını ele verirdi. Okunabilir kimlik yalnız `createWithTrustedId` ile.
   */
  create(input: CreateLanguage & { profile?: unknown; note?: string }): Language {
    return this.createAs(uuidv7(), input);
  }

  /**
   * Kimliği korunan yeni dil: YALNIZ sunucu içi güvenilir yollar (sahibin aktarım paketi, betikler, testler); API'den
   * gelen kimlik buraya verilmez. Kimlik firmada doluysa sonek (UUID'de yenisi), başka firmada doluysa yeni UUIDv7.
   */
  createWithTrustedId(input: CreateLanguage & { id: string; profile?: unknown; note?: string }): Language {
    return this.createAs(this.uniqueId(input.id), input);
  }

  private createAs(wanted: string, input: CreateLanguage & { profile?: unknown; note?: string }): Language {
    if (this.defaultId()) requireFeature(this.settings, "language.multi"); // ikinci dil (yeni, kopya ya da paket)
    // Kopya kaynağı satır yazılmadan ÖNCE çözülür (bilinmeyen dil 404, yayınlanmış sürümü yoksa 409): yarım dil kalmaz.
    let data: unknown = input.profile ?? emptyProfile(input.name);
    if (input.copyFrom) data = { ...this.profiles.activeProfile(this.resolve(input.copyFrom)).profile, name: input.name };
    // Dil satırı, ilk profil sürümü ve varsayılan dil tek işlemde: bir adım düşerse hiçbiri kalmaz.
    const id = this.db.tx(() => {
      const newId = this.insert(wanted, input.name);
      this.profiles.createPublished(newId, data, input.note ?? (input.copyFrom ? `${input.copyFrom} dilinden kopyalandı` : "Başlangıç"));
      if (!this.settings.get().defaultLanguageId) this.settings.update({ defaultLanguageId: newId });
      return newId;
    });
    for (const dir of [this.paths.templates(id), this.paths.fonts(id)]) mkdirSync(dir, { recursive: true });
    this.events.emit({ type: "language", languageId: id });
    return this.get(id);
  }

  rename(id: string, name: string): Language {
    this.get(id);
    this.db.prepare("UPDATE languages SET name = ? WHERE id = ? AND org_id = $org").run(name, id);
    this.events.emit({ type: "language", languageId: id });
    return this.get(id);
  }

  setDefault(id: string): Language {
    this.get(id);
    this.settings.update({ defaultLanguageId: id });
    this.events.emit({ type: "language", languageId: id });
    return this.get(id);
  }

  softDelete(id: string): void {
    this.get(id);
    this.db.prepare("UPDATE languages SET deleted_at = ? WHERE id = ? AND org_id = $org").run(this.clock.now().toISOString(), id);
    if (this.settings.get().defaultLanguageId === id) this.settings.update({ defaultLanguageId: null });
    this.events.emit({ type: "language", languageId: id });
  }

  restore(ids: string[]): number {
    let n = 0;
    for (const id of ids) n += Number(this.db.prepare("UPDATE languages SET deleted_at = NULL WHERE id = ? AND org_id = $org AND deleted_at IS NOT NULL").run(id).changes);
    return n;
  }

  /** Elle verilen kimlik: firmada doluysa sonek (UUID'ye sonek eklenmez, yenisi verilir). */
  private uniqueId(base: string): string {
    if (!LANGUAGE_ID.test(base)) throw fail("language-id-invalid");
    if (!this.exists(base, true)) return base;
    if (isUuidv7(base as unknown)) return uuidv7();
    let id = base;
    for (let i = 2; this.exists(id, true); i++) id = `${base}-${i}`;
    return id;
  }

  /** Satırı yazar; kimlik başka bir firmada doluysa (kurulum geneli birincil anahtar) yeni UUIDv7 ile. */
  private insert(id: string, name: string): string {
    const stmt = this.db.prepare("INSERT INTO languages (org_id, id, name, created_at) VALUES ($org, ?, ?, ?)");
    const now = this.clock.now().toISOString();
    try {
      stmt.run(id, name, now);
      return id;
    } catch (err) {
      if (!isIdTaken(err)) throw err;
    }
    const fresh = uuidv7();
    stmt.run(fresh, name, now);
    return fresh;
  }
}

/** `languages.id` birincil anahtar çakışması (node:sqlite: SQLITE_CONSTRAINT_PRIMARYKEY = 1555). */
function isIdTaken(err: unknown): boolean {
  const e = err as { errcode?: unknown; message?: unknown } | null;
  return !!e && (e.errcode === 1555 || (typeof e.message === "string" && /UNIQUE constraint failed: languages\.id/.test(e.message)));
}
