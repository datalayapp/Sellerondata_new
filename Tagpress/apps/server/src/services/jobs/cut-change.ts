import { type Issue, type Profile, type TemplateCutInput, TemplateCutSchema, effectiveCut, issueMsg, normalizeCut } from "@tagpress/domain";
import { json, placeholders } from "../../db/database.ts";
import type { EventBus } from "../../events.ts";
import { type TenantDb, dialectSql } from "../../org/tenant-db.ts";
import type { Clock } from "../../util/clock.ts";
import { effectiveTemplateKeySql, templateCutSql } from "../print/shelf.ts";
import type { ProfilePublishedHook } from "../profiles.ts";
import type { TemplateSavedHook } from "../templates.ts";
import { issueLevel } from "./mapping.ts";

/**
 * Kesim değişince onayın düşmesi (kullanıcı kararı 2026-11-21): bir şablonun ETKİN kesimi (kendi kesimi; yoksa
 * tasarım dilinin `output.cut`'ı) sonradan değişirse o şablonla onaylanmış, henüz BASILMAMIŞ etiket işlerinin onayı
 * kalkar ("ready", varyasyonlar silinmez) ve işe `template-cut-changed` uyarısı eklenir. Basılmış (arşiv) işlere
 * dokunulmaz. Bütün SQL geçerli firmanın kapsamındadır (`TenantDb` + `$org`): başka firmanın aynı anahtarlı şablonu
 * etkilenmez.
 *
 * - "O şablonla onaylanmış" = onaylı varyasyonun ETKİN şablonu (`effectiveTemplateKeySql`: varyasyon başka şablonda
 *   üretildiyse `snapshot.templateKey`, yoksa işin şablonu); baskı da bu şablonla çizer.
 * - Silinmiş (geri alınabilir) işlerin onayı da düşer: geri alınınca eski kesimle onaylı dönmesin. Önizleme sayısı
 *   (`approvals`) yalnız görünen (silinmemiş) işleri sayar; silinmişler kullanıcıya sorulmadan sessizce "ready" olur.
 * - Taslak baskı oturumunun bayatlığı burada YAZILMAZ (plan sürümüne dokunulmaz): oturum, onayı düşmüş işi içerdikçe
 *   `plan-stale` alır (`PrintSessionService.notices`); basılırsa plan sürümü doğru kalır.
 *
 * Bağlantı noktaları (`context.ts` kurar):
 * - Şablon kaydı (`TemplateService` yazımı: `update`, `upsert`, yedekten dönüş, eşitleme): kaydetmeden önce arayüz
 *   `POST …/templates/:key/cut-preview` ile `preview(...)` sayısını sorar; yazımla aynı işlemde `templateSavedHook`
 *   → `onTemplateSaved(languageId, önceki, sonraki, etkin profil)`.
 * - Tasarım dili yayını (`ProfileService.publish` / `createPublished`, geri alma dahil): `profilePublishedHook`
 *   → `onProfileCutChanged(languageId, önceki profil, yeni profil)` (yalnız kesimsiz şablonların işleri).
 */

type CutHolder = { cut?: TemplateCutInput | null } | null | undefined;

/** Etkin kesimin imzası: tasarım px şekli + (varsa) mm ölçüsü. */
export function cutSignature(template: CutHolder, profile: Pick<Profile, "output">): string {
  const eff = effectiveCut(template, profile);
  return JSON.stringify([eff.shape, profile.output.designFramePx, template?.cut ? normalizeCut(template.cut) : null]);
}

/** Etkin kesim gerçekten değişti mi (aynı profille iki şablon hâli ya da aynı şablonla iki profil)? */
export function cutChanged(before: CutHolder, after: CutHolder, profileBefore: Pick<Profile, "output">, profileAfter = profileBefore): boolean {
  return cutSignature(before, profileBefore) !== cutSignature(after, profileAfter);
}

/** Onaylı iş ve onaylı varyasyonunun etkin şablon anahtarı. */
interface ApprovedRow {
  id: string;
  key: string;
}

/** İş basılmış bir oturumda değil (arşiv işlerine dokunulmaz). `j` = jobs takma adı. */
const NOT_PRINTED = `NOT EXISTS (SELECT 1 FROM print_items i JOIN print_pages p ON p.id = i.page_id AND p.org_id = $org
             JOIN print_sessions s ON s.id = p.session_id AND s.org_id = $org
             WHERE i.org_id = $org AND i.job_id = j.id AND s.status = 'printed' AND s.deleted_at IS NULL AND p.deleted_at IS NULL)`;

export class CutChangeService {
  constructor(
    private readonly db: TenantDb,
    private readonly clock: Clock,
    /** Düşen onaylar arayüze bildirilir (`job`, taslak oturum varsa `print`); yoksa sessiz. */
    private readonly events?: EventBus,
  ) {}

  /**
   * `TemplateService` kancası: kaydın etkin kesimi (dilin ETKİN profiliyle) değiştiyse onayları düşürür. Dilin
   * yayınlanmış profili yoksa (eski veri) karşılaştırılamaz, hiçbir şey yapılmaz.
   */
  templateSavedHook(activeProfile: (languageId: string) => Pick<Profile, "output"> | null): TemplateSavedHook {
    return (languageId, key, before, after) => {
      const profile = activeProfile(languageId);
      if (profile) this.onTemplateSaved(languageId, key, before, after, profile);
    };
  }

  /** `ProfileService` kancası: önceki etkin profil varsa (dilin ilk sürümü değilse) kesim farkına bakar. */
  profilePublishedHook(): ProfilePublishedHook {
    return (languageId, before, after) => {
      if (before) this.onProfileCutChanged(languageId, before, after);
    };
  }

  /**
   * Bu şablonların kesimi değişirse onayı düşecek işler: onaylı, basılmamış etiket işleri; onaylı varyasyonun ETKİN
   * şablonu listede. `includeDeleted`: silinmiş (geri alınabilir) iş ve partiler de (kayıtta düşürülür, sayılmaz).
   */
  approvedJobs(languageId: string, templateKeys: readonly string[]): string[] {
    return this.approvedRows(languageId, templateKeys, false).map((r) => r.id);
  }

  private approvedRows(languageId: string, templateKeys: readonly string[], includeDeleted: boolean): ApprovedRow[] {
    if (!templateKeys.length) return [];
    const key = effectiveTemplateKeySql(this.db, "j", "v");
    return this.db
      .prepare(
        `SELECT j.id, ${key} AS key FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org
         LEFT JOIN variants v ON v.id = j.approved_variant_id AND v.org_id = $org
         WHERE j.org_id = $org AND b.language_id = ? AND j.kind = 'label' AND j.status = 'approved'
           ${includeDeleted ? "" : "AND j.deleted_at IS NULL AND b.deleted_at IS NULL"}
           AND ${key} IN (${placeholders(templateKeys.length)})
           AND ${NOT_PRINTED}
         ORDER BY j.created_at, j.seq`,
      )
      .all(languageId, ...templateKeys) as unknown as ApprovedRow[];
  }

  /** Kaydetmeden önce: bu kayıt onay düşürür mü, kaç (görünen) iş (arayüz onay sorar)? */
  preview(languageId: string, key: string, before: CutHolder, after: CutHolder, profile: Pick<Profile, "output">): { changed: boolean; jobIds: string[] } {
    if (!cutChanged(before, after, profile)) return { changed: false, jobIds: [] };
    return { changed: true, jobIds: this.approvedJobs(languageId, [key]) };
  }

  /** Şablon kaydedildikten sonra: etkin kesim değiştiyse onayları düşürür. Düşen GÖRÜNEN iş kimlikleri (= önizleme). */
  onTemplateSaved(languageId: string, key: string, before: CutHolder, after: CutHolder, profile: Pick<Profile, "output">): string[] {
    if (!cutChanged(before, after, profile)) return [];
    return this.drop(this.approvedRows(languageId, [key], true));
  }

  /** Tasarım dilinin kesimi değişen yayında: kendi kesimi OLMAYAN şablonların işleri (kesimli şablonlar etkilenmez). */
  previewProfile(languageId: string, before: Pick<Profile, "output">, after: Pick<Profile, "output">): { changed: boolean; jobIds: string[]; keys: string[] } {
    if (!cutChanged(null, null, before, after)) return { changed: false, jobIds: [], keys: [] };
    const keys = this.cutlessKeys(languageId);
    return { changed: true, jobIds: this.approvedJobs(languageId, keys), keys };
  }

  onProfileCutChanged(languageId: string, before: Pick<Profile, "output">, after: Pick<Profile, "output">): string[] {
    if (!cutChanged(null, null, before, after)) return [];
    return this.drop(this.approvedRows(languageId, this.cutlessKeys(languageId), true));
  }

  /**
   * Geri alma (`UndoService`) için: işin şu varyasyonla onayının BUGÜNKÜ etkin kesimi (imza + etkin şablon anahtarı).
   * Varyasyon silinirken imza saklanır; geri almada farklıysa onay geri gelmez (`dropApprovals`). Etiket işi değilse,
   * iş basılmışsa ya da dilin etkin profili yoksa null (karşılaştırılmaz, bugünkü davranış).
   */
  approvalCut(jobId: string, variantId: string, activeProfile: (languageId: string) => Pick<Profile, "output"> | null): { key: string; signature: string } | null {
    const key = effectiveTemplateKeySql(this.db, "j", "v");
    const r = this.db
      .prepare(
        `SELECT b.language_id, ${key} AS key, ${templateCutSql(this.db)} AS cut FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org
         LEFT JOIN variants v ON v.id = ? AND v.job_id = j.id AND v.org_id = $org
         LEFT JOIN templates tp ON tp.org_id = $org AND tp.language_id = b.language_id AND tp.key = ${key}
         WHERE j.id = ? AND j.org_id = $org AND j.kind = 'label' AND ${NOT_PRINTED}`,
      )
      .get(variantId, jobId) as { language_id: string; key: string; cut: string | null } | undefined;
    if (!r) return null;
    const profile = activeProfile(r.language_id);
    if (!profile) return null;
    // Bozuk saklı kesim yok sayılır (baskıdaki gibi tasarım dilinin kesimi geçer).
    const parsed = r.cut ? TemplateCutSchema.safeParse(json<unknown>(r.cut, null)) : null;
    return { key: r.key, signature: cutSignature({ cut: parsed?.success ? parsed.data : null }, profile) };
  }

  /** Bu onaylı işlerin onayını düşürür ve uyarıyı ekler (geri almada kesimi değişmiş onay). Dönen: düşen görünen işler. */
  dropApprovals(rows: readonly ApprovedRow[]): string[] {
    return this.drop(rows);
  }

  private cutlessKeys(languageId: string): string[] {
    return (
      this.db
        .prepare(
          dialectSql(this.db, {
            sqlite: "SELECT key FROM templates WHERE org_id = $org AND language_id = ? AND json_extract(data, '$.cut') IS NULL",
            pg: "SELECT key FROM templates WHERE org_id = $org AND language_id = ? AND (data::jsonb ->> 'cut') IS NULL",
          }),
        )
        .all(languageId) as { key: string }[]
    ).map((r) => r.key);
  }

  /**
   * Onayı kaldırır ve uyarıyı (etkin şablonun anahtarıyla) ekler (tek işlemde). Taslak oturumlar bayatlığı işlerin
   * durumundan okur; açık masalar `print` olayıyla yenilenir. Dönen: düşen görünen (silinmemiş) işler.
   */
  private drop(rows: readonly ApprovedRow[]): string[] {
    if (!rows.length) return [];
    const now = this.clock.now().toISOString();
    const keyOf = new Map(rows.map((r) => [r.id, r.key]));
    const ids = [...keyOf.keys()];
    const dropped: string[] = [];
    const visible: string[] = [];
    let staleLanguages: string[] = [];
    this.db.tx(() => {
      const cur = this.db
        .prepare(
          `SELECT j.id, j.issues, j.run_issues, (j.deleted_at IS NULL AND b.deleted_at IS NULL) AS live FROM jobs j JOIN batches b ON b.id = j.batch_id AND b.org_id = $org
           WHERE j.org_id = $org AND j.id IN (${placeholders(ids.length)})`,
        )
        .all(...ids) as { id: string; issues: string; run_issues: string; live: number }[];
      const upd = this.db.prepare(
        "UPDATE jobs SET approved_variant_id = NULL, status = 'ready', run_issues = ?, issue_level = ?, updated_at = ? WHERE id = ? AND org_id = $org AND status = 'approved'",
      );
      for (const r of cur) {
        const issue: Issue = { ...issueMsg("template-cut-changed", { template: keyOf.get(r.id)! }), severity: "warning", fixes: [] };
        const run = [...json<Issue[]>(r.run_issues, []).filter((i) => i.code !== "template-cut-changed"), issue];
        if (!Number(upd.run(JSON.stringify(run), issueLevel([...json<Issue[]>(r.issues, []), ...run]), now, r.id).changes)) continue;
        dropped.push(r.id);
        if (Number(r.live)) visible.push(r.id);
      }
      if (!dropped.length) return;
      staleLanguages = (
        this.db
          .prepare(
            `SELECT DISTINCT s.language_id FROM print_sessions s JOIN print_pages p ON p.session_id = s.id AND p.org_id = $org JOIN print_items i ON i.page_id = p.id AND i.org_id = $org
             WHERE s.org_id = $org AND s.status = 'draft' AND s.deleted_at IS NULL AND p.deleted_at IS NULL AND i.job_id IN (${placeholders(dropped.length)})`,
          )
          .all(...dropped) as { language_id: string }[]
      ).map((r) => r.language_id);
    });
    for (const id of dropped) this.events?.emit({ type: "job", jobId: id, status: "ready" });
    for (const languageId of staleLanguages) this.events?.emit({ type: "print", languageId, sessionId: null });
    return visible;
  }
}
