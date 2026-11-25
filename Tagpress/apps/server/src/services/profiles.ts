import { randomUUID } from "node:crypto";
import { type Profile, type ProfileDiff, type ProfileRecord, ProfileSchema, type ProfileVersionSummary, upgradeProfileInput } from "@tagpress/domain";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import type { TenantDb } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import { fail, failFields, zodFields } from "../util/errors.ts";
import { assertLanguageInOrg } from "./languages.ts";

interface VersionRow {
  id: string;
  language_id: string;
  version: number;
  status: "draft" | "published";
  data: string;
  note: string;
  created_at: string;
  published_at: string | null;
}

/**
 * Profil sürümleri. Dil başına en çok bir taslak; yayınlanmış en yüksek sürüm ETKİNDİR.
 * Geri alma, eski sürümün verisiyle yeni bir yayınlanmış sürüm oluşturur (geçmiş silinmez).
 */
/**
 * Yeni etkin profil yayınlandı (taslak yayını, geri alma, doğrudan yayın). Aynı veritabanı işleminin içinde çağrılır:
 * kancada düşen hata yayını da geri alır. `before`: önceki etkin profil (yoksa null: dilin ilk sürümü).
 */
export type ProfilePublishedHook = (languageId: string, before: Profile | null, after: Profile) => void;

export class ProfileService {
  constructor(
    private readonly db: TenantDb,
    private readonly events: EventBus,
    private readonly clock: Clock,
    /** Kesim değişince onayların düşmesi (`context.ts`: `CutChangeService.onProfileCutChanged`). */
    private readonly onPublished?: ProfilePublishedHook,
  ) {}

  active(languageId: string): ProfileRecord | null {
    const row = this.db
      .prepare("SELECT * FROM profile_versions WHERE language_id = ? AND org_id = $org AND status = 'published' ORDER BY version DESC LIMIT 1")
      .get(languageId) as VersionRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** Etkin profil; yoksa 409 (dil yayınlanmış sürümsüz olamaz ama eski veride olabilir). */
  activeProfile(languageId: string): { profile: Profile; version: number } {
    const r = this.active(languageId);
    if (!r) throw fail("no-published-profile");
    return { profile: r.data, version: r.version };
  }

  draft(languageId: string): ProfileRecord | null {
    const row = this.db.prepare("SELECT * FROM profile_versions WHERE language_id = ? AND org_id = $org AND status = 'draft'").get(languageId) as VersionRow | undefined;
    return row ? toRecord(row) : null;
  }

  version(languageId: string, version: number): ProfileRecord {
    const row = this.db.prepare("SELECT * FROM profile_versions WHERE language_id = ? AND org_id = $org AND version = ?").get(languageId, version) as VersionRow | undefined;
    if (!row) throw fail("profile-version-not-found", { version });
    return toRecord(row);
  }

  versions(languageId: string): ProfileVersionSummary[] {
    const rows = this.db
      .prepare("SELECT version, status, note, created_at, published_at FROM profile_versions WHERE language_id = ? AND org_id = $org ORDER BY version DESC")
      .all(languageId) as unknown as VersionRow[];
    const active = this.active(languageId)?.version ?? null;
    return rows.map((r) => ({
      version: r.version,
      status: r.status,
      note: r.note,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      active: r.version === active,
    }));
  }

  /** Taslağı yazar; geçersizse kaydetmez, alan yollarıyla 400 döner. */
  saveDraft(languageId: string, data: unknown, note?: string): ProfileRecord {
    const parsed = ProfileSchema.safeParse(upgradeProfileInput(data));
    if (!parsed.success) throw failFields("profile-invalid", zodFields(parsed.error));
    const now = this.clock.now().toISOString();
    const existing = this.draft(languageId);
    if (existing) {
      this.db
        .prepare("UPDATE profile_versions SET data = ?, note = ?, created_at = ? WHERE id = ? AND org_id = $org")
        .run(JSON.stringify(parsed.data), note ?? existing.note, now, existing.id);
    } else {
      this.insert(languageId, this.maxVersion(languageId) + 1, "draft", parsed.data, note ?? "", now);
    }
    return this.draft(languageId)!;
  }

  discardDraft(languageId: string): void {
    this.db.prepare("DELETE FROM profile_versions WHERE language_id = ? AND org_id = $org AND status = 'draft'").run(languageId);
  }

  publish(languageId: string, note?: string): ProfileRecord {
    return this.db.tx(() => {
      const d = this.draft(languageId);
      if (!d) throw fail("no-draft");
      const before = this.active(languageId)?.data ?? null;
      // Taslak, aradaki geri almalardan sonra en yüksek numarayı almalı ki etkin olsun.
      const next = this.maxPublished(languageId) + 1;
      const version = Math.max(d.version, next);
      this.db
        .prepare("UPDATE profile_versions SET status = 'published', version = ?, note = ?, published_at = ? WHERE id = ? AND org_id = $org")
        .run(version, note ?? d.note, this.clock.now().toISOString(), d.id);
      const rec = this.version(languageId, version);
      this.onPublished?.(languageId, before, rec.data);
      this.events.emit({ type: "profile", languageId, version });
      return rec;
    });
  }

  /** Doğrudan yayınlanmış sürüm (ilk açılış, dil oluşturma, geri alma). */
  createPublished(languageId: string, data: unknown, note: string): ProfileRecord {
    const profile = ProfileSchema.parse(upgradeProfileInput(data));
    return this.db.tx(() => {
      const before = this.active(languageId)?.data ?? null;
      const draft = this.draft(languageId);
      const version = Math.max(this.maxPublished(languageId) + 1, draft ? draft.version + 1 : 1);
      const now = this.clock.now().toISOString();
      this.insert(languageId, version, "published", profile, note, now, now);
      const rec = this.version(languageId, version);
      this.onPublished?.(languageId, before, rec.data);
      this.events.emit({ type: "profile", languageId, version });
      return rec;
    });
  }

  revert(languageId: string, version: number, note?: string): ProfileRecord {
    const source = this.version(languageId, version);
    return this.createPublished(languageId, source.data, note ?? `Sürüm ${version}'e geri dönüldü`);
  }

  diff(languageId: string, from: number, to: number): ProfileDiff {
    const a = this.version(languageId, from).data;
    const b = this.version(languageId, to).data;
    return { from, to, changes: diffLeaves(a, b) };
  }

  private maxVersion(languageId: string): number {
    const r = this.db.prepare("SELECT MAX(version) AS v FROM profile_versions WHERE language_id = ? AND org_id = $org").get(languageId) as { v: number | null };
    return r.v ?? 0;
  }

  private maxPublished(languageId: string): number {
    const r = this.db.prepare("SELECT MAX(version) AS v FROM profile_versions WHERE language_id = ? AND org_id = $org AND status = 'published'").get(languageId) as {
      v: number | null;
    };
    return r.v ?? 0;
  }

  private insert(languageId: string, version: number, status: "draft" | "published", data: Profile, note: string, now: string, publishedAt: string | null = null) {
    assertLanguageInOrg(this.db, languageId);
    this.db
      .prepare("INSERT INTO profile_versions (org_id, id, language_id, version, status, data, note, created_at, published_at) VALUES ($org, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), languageId, version, status, JSON.stringify(data), note, now, publishedAt);
  }
}

function toRecord(r: VersionRow): ProfileRecord {
  return {
    id: r.id,
    languageId: r.language_id,
    version: r.version,
    status: r.status,
    data: ProfileSchema.parse(upgradeProfileInput(json(r.data, {}))),
    note: r.note,
    createdAt: r.created_at,
  };
}

/** Yaprak alan farkları ("sizing.fill": 0.9 → 0.85). Diziler tek değer sayılır. */
export function diffLeaves(a: unknown, b: unknown, path = ""): ProfileDiff["changes"] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffLeaves(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a ?? null, to: b ?? null }];
}
