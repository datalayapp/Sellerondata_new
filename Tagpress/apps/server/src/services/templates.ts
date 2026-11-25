import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Template, type TemplateItem, TemplateSchema, type TemplateSyncResult, apiPath, API } from "@tagpress/domain";
import type { DataPaths } from "../config.ts";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import { type TenantDb, dialectSql } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail, failFields, zodFields } from "../util/errors.ts";
import { isPng, pngSize, sha1, writeAtomic } from "../util/files.ts";
import { PNG, isSafeRelative, safeJoin } from "../util/safe-path.ts";
import { fold } from "../util/text.ts";
import { assertLanguageInOrg } from "./languages.ts";

/** Kayıtta bilinmeyen alanlar da korunur (templates paketi yeni ölçüm alanları ekleyebilir). */
const StoredTemplateSchema = TemplateSchema.loose();
type StoredTemplate = Template & Record<string, unknown>;

/**
 * Kaldırılmış alanlar kayda yazılmaz (gevşek şema bilinmeyeni korur; eski dil paketi ya da `paket.json` getirse bile):
 * `figma` = eski Figma bağlantısı (göç 7 veriden de sildi).
 */
const DROPPED_FIELDS = ["figma"] as const;
function withoutDropped(t: Record<string, unknown>): Record<string, unknown> {
  const out = { ...t };
  for (const f of DROPPED_FIELDS) delete out[f];
  return out;
}

/** Değiştirilemeyen alanlar (dosyadan gelir ya da kimliktir). */
const IMMUTABLE = ["key", "languageId", "file", "hash", "width", "height"] as const;

interface TemplateRow {
  language_id: string;
  key: string;
  data: string;
  file_missing: number;
  updated_at: string;
}

/** Şablon PNG'sinin adından anahtar: küçük harf, harf/rakam/-/_ dışı tire. */
export function keyFromFileName(file: string): string {
  const ext = path.extname(file);
  return fold(/^\.[a-z0-9]{2,5}$/i.test(ext) ? path.basename(file, ext) : path.basename(file))
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const isValidKey = (key: string) => /^[a-z0-9][a-z0-9_-]{0,80}$/.test(key);

/**
 * Şablon kaydı yazıldı (güncelleme, tam yazım, yedekten dönüş, klasör eşitleme). `before`: yazımdan önceki kayıt (yeni
 * kayıtta null), `after`: yazılan kayıt. Önceki kayıt var ama şemayla okunamıyorsa kanca çağrılmaz (karşılaştırılamaz).
 */
export type TemplateSavedHook = (languageId: string, key: string, before: Template | null, after: Template) => void;

/**
 * Şablon kayıtları (dil başına) ve dosyaları. İlkeler:
 * - Güncelleme mevcut kayıtla DERİN birleştirilir ve tam şemayla doğrulanır; hiçbir alan sessizce düşmez.
 * - Dosyası klasörden kaybolan şablonun kaydı silinmez, `fileMissing` işaretlenir.
 * - Dosyanın üzerine yazmadan önce yedek alınır (firmanın kökünde `yedek/sablonlar/<dil>/`; sahibin eski kökünde `data/yedek/…`).
 */
export class TemplateService {
  constructor(
    private readonly db: TenantDb,
    private readonly paths: DataPaths,
    private readonly events: EventBus,
    private readonly clock: Clock,
    /** Kayıt yazıldı (kesim değişince onayların düşmesi: `context.ts`). Yazımla aynı veritabanı işleminde çağrılır. */
    private readonly onSaved?: TemplateSavedHook,
  ) {}

  list(languageId: string): TemplateItem[] {
    const rows = this.db.prepare(`SELECT * FROM templates WHERE language_id = ? AND org_id = $org ORDER BY ${this.byKey()}`).all(languageId) as unknown as TemplateRow[];
    return rows.map((r) => this.toItem(r));
  }

  keys(languageId: string): string[] {
    return (this.db.prepare(`SELECT key FROM templates WHERE language_id = ? AND org_id = $org ORDER BY ${this.byKey()}`).all(languageId) as { key: string }[]).map((r) => r.key);
  }

  /** Anahtar sırası iki veritabanında aynı: SQLite bayt sırası, Postgres `COLLATE "C"` (veritabanı dil sırası değil). */
  private byKey(): string {
    return dialectSql(this.db, { sqlite: "key", pg: 'key COLLATE "C"' });
  }

  find(languageId: string, key: string): StoredTemplate | null {
    const row = this.row(languageId, key);
    return row ? (StoredTemplateSchema.parse(json(row.data, {})) as StoredTemplate) : null;
  }

  get(languageId: string, key: string): TemplateItem {
    const row = this.row(languageId, key);
    if (!row) throw fail("template-key-not-found", { key });
    return this.toItem(row);
  }

  /**
   * Şablon görselinin yolu. Kayıttaki `file` yalnız dilin şablon klasöründeki PNG olabilir; kaçan değer (eski/kötü kayıt)
   * diske çevrilmez: `imageFile` null, `imagePath` 404 hatası.
   */
  imageFile(languageId: string, t: Pick<Template, "file">): string | null {
    return safeJoin(this.paths.templates(languageId), t.file, { ext: PNG });
  }

  imagePath(languageId: string, t: Pick<Template, "file">): string {
    const file = this.imageFile(languageId, t);
    if (!file) throw fail("template-image-not-found");
    return file;
  }

  /** Klasörü tarar: yeni dosya → kayıt; değişen dosya → özet/ölçü; kaybolan dosya → işaret. */
  async sync(languageId: string): Promise<TemplateSyncResult> {
    const dir = this.paths.templates(languageId);
    await mkdir(dir, { recursive: true });
    const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".png"));
    const records = this.list(languageId).map((i) => i.template as StoredTemplate);
    const byFile = new Map(records.map((t) => [t.file.toLowerCase(), t]));
    const result: TemplateSyncResult = { added: [], updated: [], missing: [] };
    const seen = new Set<string>();
    for (const file of files) {
      const buf = await readFile(path.join(dir, file));
      const size = pngSize(buf);
      if (!size) continue;
      const hash = sha1(buf);
      const existing = byFile.get(file.toLowerCase()) ?? records.find((t) => t.key === keyFromFileName(file));
      if (existing) {
        seen.add(existing.key);
        const wasMissing = !!this.row(languageId, existing.key)?.file_missing;
        if (existing.hash !== hash || existing.width !== size.width || existing.height !== size.height || existing.file !== file || wasMissing) {
          const prov = existing.hash && existing.hash !== hash ? [...existing.provenance, { field: "file", source: "auto" as const, at: this.now() }] : existing.provenance;
          this.write(languageId, { ...existing, file, hash, width: size.width, height: size.height, provenance: prov }, false);
          result.updated.push(existing.key);
        }
        continue;
      }
      const key = keyFromFileName(file);
      if (!isValidKey(key) || seen.has(key)) continue;
      seen.add(key);
      this.write(languageId, StoredTemplateSchema.parse({ key, languageId, file, hash, width: size.width, height: size.height }) as StoredTemplate, false);
      result.added.push(key);
    }
    for (const t of records) {
      if (seen.has(t.key)) continue;
      if (!this.row(languageId, t.key)?.file_missing) {
        this.db.prepare("UPDATE templates SET file_missing = 1, updated_at = ? WHERE language_id = ? AND key = ? AND org_id = $org").run(this.now(), languageId, t.key);
      }
      result.missing.push(t.key);
    }
    for (const key of [...result.added, ...result.updated]) this.events.emit({ type: "template", languageId, key });
    return result;
  }

  /** Kısmi güncelleme: derin birleştir → tam şema. Değiştirilemeyen alanlar reddedilir. */
  update(languageId: string, key: string, patch: Record<string, unknown>): TemplateItem {
    const { after } = this.merged(languageId, key, patch);
    this.write(languageId, after, !!this.row(languageId, key)?.file_missing);
    this.events.emit({ type: "template", languageId, key });
    return this.get(languageId, key);
  }

  /**
   * Yamanın kayda yazılacak hâli (yazmadan): `update` ile aynı derin birleştirme ve doğrulama. Kesim önizlemesi bunu
   * kullanır ki önizleme ile kayıt aynı sonucu görsün.
   */
  merged(languageId: string, key: string, patch: Record<string, unknown>): { before: StoredTemplate; after: StoredTemplate } {
    const current = this.find(languageId, key);
    if (!current) throw fail("template-key-not-found", { key });
    const bad = IMMUTABLE.filter((f) => f in patch && JSON.stringify(patch[f]) !== JSON.stringify(current[f]));
    if (bad.length) throw failFields("template-fields-readonly", bad.map((f) => ({ path: f, message: "Değiştirilemez." })));
    const merged = deepMerge(current, patch);
    const changed = Object.keys(patch).filter((f) => f !== "provenance" && JSON.stringify(current[f]) !== JSON.stringify(merged[f]));
    if (!("provenance" in patch) && changed.length) {
      merged.provenance = [...current.provenance, ...changed.map((field) => ({ field, source: "user" as const, at: this.now() }))];
    }
    const parsed = StoredTemplateSchema.safeParse(merged);
    if (!parsed.success) throw failFields("template-record-invalid", zodFields(parsed.error));
    return { before: current, after: parsed.data as StoredTemplate };
  }

  /** Kayıt ekler ya da tamamen yazar (ilk açılış aktarımı, üretilmiş şablon). */
  upsert(languageId: string, template: unknown): TemplateItem {
    const parsed = StoredTemplateSchema.safeParse({ ...(template as object), languageId });
    if (!parsed.success) throw failFields("template-record-invalid", zodFields(parsed.error));
    const t = parsed.data as StoredTemplate;
    if (!isValidKey(t.key)) throw fail("template-key-invalid", { key: t.key });
    if (!isSafeRelative(t.file, { ext: PNG }) || t.file.includes("/")) throw failFields("template-record-invalid", [{ path: "file", message: "Dosya adı şablon klasöründe bir PNG olmalı." }]);
    this.write(languageId, t, !existsSync(this.imagePath(languageId, t)));
    this.events.emit({ type: "template", languageId, key: t.key });
    return this.get(languageId, t.key);
  }

  /** PNG yükler (var olan dosya önce yedeklenir); kaydı oluşturur/günceller. Aynı özetse yazmaz. */
  async upload(languageId: string, input: { key?: string; fileName: string; png: Buffer; kind?: Template["kind"]; extra?: Record<string, unknown> }) {
    if (!isPng(input.png)) throw fail("not-png");
    const key = (input.key ?? keyFromFileName(input.fileName)).toLowerCase();
    if (!isValidKey(key)) throw fail("template-key-invalid", { key });
    const existing = this.find(languageId, key);
    const file = existing?.file ?? `${key}.png`;
    const target = this.imagePath(languageId, { file });
    const hash = sha1(input.png);
    if (existing && existing.hash === hash && existsSync(target)) {
      if (input.extra) this.update(languageId, key, input.extra);
      return { item: this.get(languageId, key), unchanged: true, backup: null as string | null };
    }
    const backup = existsSync(target) ? await this.backup(languageId, key) : null;
    await writeAtomic(target, input.png);
    await this.sync(languageId);
    const patch: Record<string, unknown> = { ...(input.extra ?? {}) };
    if (input.kind && input.kind !== this.find(languageId, key)?.kind) patch.kind = input.kind;
    if (Object.keys(patch).length) this.update(languageId, key, patch);
    return { item: this.get(languageId, key), unchanged: false, backup };
  }

  /**
   * Geçici şablonları (`gecici` etiketi, "Kalıcı yapma" ile üretilmiş) temizler: hiçbir varyasyon (yumuşak silinmiş olsa da,
   * çünkü geri alınabilir) ve hiçbir iş kullanmıyorsa kayıt ve dosya silinir. Üretimi süren iş için en az `minAgeMs` yaşında olmalı.
   */
  async purgeTemporary(minAgeMs: number): Promise<string[]> {
    const cutoff = new Date(this.clock.now().getTime() - minAgeMs).toISOString();
    const rows = this.db.prepare("SELECT * FROM templates WHERE org_id = $org AND created_at < ?").all(cutoff) as unknown as TemplateRow[];
    const snap = (k: string) => dialectSql(this.db, { sqlite: `json_extract(snapshot, '$.${k}')`, pg: `(snapshot::jsonb ->> '${k}')` });
    const used = this.db.prepare(
      `SELECT 1 FROM variants WHERE org_id = $org AND ${snap("templateKey")} = ? AND ${snap("languageId")} = ?
       UNION ALL SELECT 1 FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org WHERE j.org_id = $org AND j.template_key = ? AND b.language_id = ? LIMIT 1`,
    );
    const removed: string[] = [];
    for (const r of rows) {
      const t = StoredTemplateSchema.safeParse(json(r.data, {}));
      if (!t.success || !(t.data.tags ?? []).includes("gecici")) continue;
      if (used.get(r.key, r.language_id, r.key, r.language_id)) continue;
      this.db.prepare("DELETE FROM templates WHERE language_id = ? AND key = ? AND org_id = $org").run(r.language_id, r.key);
      const file = this.imageFile(r.language_id, t.data);
      if (file) await rm(file, { force: true });
      removed.push(r.key);
      this.events.emit({ type: "template", languageId: r.language_id, key: r.key });
    }
    return removed;
  }

  /** PNG + kayıt yedeği; yedek adını döner. */
  async backup(languageId: string, key: string): Promise<string | null> {
    const t = this.find(languageId, key);
    if (!t) return null;
    const src = this.imagePath(languageId, t);
    if (!existsSync(src)) return null;
    // Yedek adına anahtar katılır: yalnız geçerli anahtar (eski/kötü kayıt yedek klasörünün dışına yazamaz).
    if (!isValidKey(key)) throw fail("template-key-invalid", { key });
    const dir = this.backupDir(languageId);
    await mkdir(dir, { recursive: true });
    const name = `${key}-${this.now().replace(/[:.]/g, "-")}`;
    const png = safeJoin(dir, `${name}.png`, { ext: PNG });
    const rec = safeJoin(dir, `${name}.json`, { ext: [".json"] });
    if (!png || !rec) throw fail("template-key-invalid", { key });
    await copyFile(src, png);
    await writeFile(rec, JSON.stringify(t, null, 2));
    return name;
  }

  backups(languageId: string, key: string): string[] {
    const dir = this.backupDir(languageId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${key}-`) && f.endsWith(".png") && /^\d{4}-/.test(f.slice(key.length + 1)))
      .map((f) => f.slice(0, -4))
      .sort()
      .reverse();
  }

  /** Son yedeğe döner (o anki hâl de yedeklenir ki bu da geri alınabilsin). */
  async restore(languageId: string, key: string): Promise<{ restored: string }> {
    const latest = this.backups(languageId, key)[0];
    if (!latest) throw fail("template-backup-not-found", { key });
    const dir = this.backupDir(languageId);
    const pngFile = safeJoin(dir, `${latest}.png`, { ext: PNG });
    const recFile = safeJoin(dir, `${latest}.json`, { ext: [".json"] });
    if (!pngFile || !recFile) throw fail("template-backup-not-found", { key });
    const png = await readFile(pngFile);
    const rec = json<Record<string, unknown> | null>(existsSync(recFile) ? await readFile(recFile, "utf8") : "", null);
    const current = this.find(languageId, key);
    const file = current?.file ?? `${key}.png`;
    // Kayıttaki dosya adı şablon klasörünün dışına çıkamaz (`imagePath` kaçışta 404 verir); yedek ondan sonra alınır.
    const target = this.imagePath(languageId, { file });
    await this.backup(languageId, key);
    await writeAtomic(target, png);
    if (rec) this.write(languageId, StoredTemplateSchema.parse({ ...rec, file, hash: sha1(png) }) as StoredTemplate, false);
    await this.sync(languageId);
    return { restored: latest };
  }

  private backupDir(languageId: string): string {
    return this.paths.templateBackups(languageId);
  }

  private row(languageId: string, key: string): TemplateRow | undefined {
    return this.db.prepare("SELECT * FROM templates WHERE language_id = ? AND key = ? AND org_id = $org").get(languageId, key) as TemplateRow | undefined;
  }

  private write(languageId: string, t: StoredTemplate, fileMissing: boolean): void {
    assertLanguageInOrg(this.db, languageId);
    const now = this.now();
    this.db.tx(() => {
      // Önceki kayıt (kanca için): yoksa null; var ama okunamıyorsa kanca çağrılmaz.
      const prevRow = this.onSaved ? this.row(languageId, t.key) : undefined;
      const prev = prevRow ? StoredTemplateSchema.safeParse(json(prevRow.data, {})) : null;
      // Çakışan satır başka firmanınsa (dil kimliği kurulum genelinde tekil) güncellenmez: dil bu firmada yok.
      const r = this.db
        .prepare(
          `INSERT INTO templates (org_id, language_id, key, data, file_missing, created_at, updated_at) VALUES ($org, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(language_id, key) DO UPDATE SET data = excluded.data, file_missing = excluded.file_missing, updated_at = excluded.updated_at
           WHERE templates.org_id = $org`,
        )
        .run(languageId, t.key, JSON.stringify(withoutDropped({ ...t, languageId })), fileMissing ? 1 : 0, now, now);
      if (!Number(r.changes)) throw fail("language-not-found");
      if (this.onSaved && (!prev || prev.success)) this.onSaved(languageId, t.key, prev ? (prev.data as Template) : null, t);
    });
  }

  private toItem(r: TemplateRow): TemplateItem {
    const template = StoredTemplateSchema.parse(json(r.data, {}));
    const p = { lang: r.language_id, key: r.key };
    return {
      template,
      fileMissing: !!r.file_missing,
      imageUrl: `${apiPath(API.templateImage, p)}?h=${template.hash.slice(0, 8)}`,
      overlayUrl: `${apiPath(API.templateOverlay, p)}?h=${template.hash.slice(0, 8)}`,
      updatedAt: r.updated_at,
    };
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

/** Düz nesneleri derin birleştirir; diziler ve diğer değerler olduğu gibi değiştirilir. */
export function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T & Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k];
    const plain = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
    // Ayrımlı birleşimlerde (area.mode, shape.kind) tür değişirse eski alanlar taşınmamalı.
    const discriminant = plain(v) && plain(cur) && (("mode" in v && v.mode !== cur.mode) || ("kind" in v && v.kind !== cur.kind));
    out[k] = plain(v) && plain(cur) && !discriminant ? deepMerge(cur, v) : v;
  }
  return out as T & Record<string, unknown>;
}
