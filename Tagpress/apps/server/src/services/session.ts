import { randomUUID } from "node:crypto";
import type { DesignSession, DesignSessionEntry, DesignSessionEntryInput, ProfileRecord } from "@tagpress/domain";
import { json } from "../db/database.ts";
import type { EventBus } from "../events.ts";
import { type TenantDb, insertOrder } from "../org/tenant-db.ts";
import type { Clock } from "../util/clock.ts";
import type { ProfileService } from "./profiles.ts";
import { diffLeaves } from "./profiles.ts";
import { assertLanguageInOrg } from "./languages.ts";

/**
 * Tasarım dili oluşturma oturumu (Claude Code'daki "tasarım dili" becerisi + MCP sunucusu). Beceri soruları,
 * yöneticinin cevaplarını, taslak yazımlarını ve denemeleri buraya kaydeder; arayüz "Oluştur" bölümünde canlı gösterir.
 * Uygulama aboneliği hiç çağırmaz: yalnızca günlük tutar.
 */

type Status = DesignSession["status"];

interface SessionRow {
  id: string;
  language_id: string;
  title: string;
  status: Status;
  started_at: string;
  updated_at: string;
}

interface EntryRow {
  id: number;
  session_id: string;
  at: string;
  kind: DesignSessionEntry["kind"];
  grp: string | null;
  text: string;
  paths: string | null;
}

/** Girdi türünden oturum durumu (not durumu değiştirmez). */
const STATUS_OF: Record<DesignSessionEntry["kind"], Status | null> = {
  question: "asking",
  answer: "asking",
  "draft-write": "drafting",
  trial: "trying",
  note: null,
};

/** Son oturumda en çok kaç girdi döner (arayüz 4 sn'de bir sorgular). */
const MAX_ENTRIES = 500;

export class DesignSessionService {
  constructor(
    private readonly db: TenantDb,
    private readonly profiles: ProfileService,
    private readonly events: EventBus,
    private readonly clock: Clock,
  ) {}

  /** Son oturum ve girdileri; hiç oturum yoksa boş ("idle"). */
  current(languageId: string): DesignSession {
    const s = this.latest(languageId);
    if (!s) return { id: null, title: "", status: "idle", startedAt: null, updatedAt: null, entries: [] };
    const rows = this.db
      .prepare("SELECT * FROM (SELECT * FROM design_session_entries WHERE session_id = ? AND org_id = $org ORDER BY id DESC LIMIT ?) ORDER BY id")
      .all(s.id, MAX_ENTRIES) as unknown as EntryRow[];
    return { id: s.id, title: s.title, status: s.status, startedAt: s.started_at, updatedAt: s.updated_at, entries: rows.map(toEntry) };
  }

  /** Yeni oturum başlatır (öncekiler silinmez). */
  start(languageId: string, title = ""): DesignSession {
    assertLanguageInOrg(this.db, languageId);
    const now = this.now();
    this.db
      .prepare("INSERT INTO design_sessions (org_id, id, language_id, title, status, started_at, updated_at) VALUES ($org, ?, ?, ?, 'idle', ?, ?)")
      .run(randomUUID(), languageId, title, now, now);
    this.emit(languageId);
    return this.current(languageId);
  }

  /** Girdi ekler. Oturum yoksa ya da son oturum bitmişse ("done") yenisi açılır. */
  add(languageId: string, input: DesignSessionEntryInput): DesignSessionEntry {
    const entry = this.db.tx(() => {
      let s = this.latest(languageId);
      if (!s || s.status === "done") {
        this.start(languageId);
        s = this.latest(languageId)!;
      }
      const now = this.now();
      const r = this.db
        .prepare("INSERT INTO design_session_entries (org_id, session_id, at, kind, grp, text, paths) VALUES ($org, ?, ?, ?, ?, ?, ?)")
        .run(s.id, now, input.kind, input.group ?? null, input.text, input.paths?.length ? JSON.stringify(input.paths) : null);
      const status = input.status ?? STATUS_OF[input.kind] ?? s.status;
      this.db.prepare("UPDATE design_sessions SET status = ?, updated_at = ? WHERE id = ? AND org_id = $org").run(status, now, s.id);
      return toEntry(this.db.prepare("SELECT * FROM design_session_entries WHERE id = ? AND org_id = $org").get(Number(r.lastInsertRowid)) as unknown as EntryRow);
    });
    this.emit(languageId);
    return entry;
  }

  /**
   * Taslağa kısmi yama yazar (derin birleştirme; diziler bütün olarak değişir). Taban: varsa taslak, yoksa yayınlanmış
   * profil. Geçersizse ProfileService alan yollarıyla 400 döner ve hiçbir şey kaydedilmez. Başarılıysa oturuma
   * "draft-write" girdisi düşer (değişen alan yolları).
   */
  writeDraft(languageId: string, patch: Record<string, unknown>, note?: string): { draft: ProfileRecord; changes: Array<{ path: string; from: unknown; to: unknown }> } {
    const base = this.profiles.draft(languageId) ?? this.profiles.active(languageId);
    const baseData = base?.data ?? {};
    const merged = mergePatch(baseData as Record<string, unknown>, patch);
    const draft = this.profiles.saveDraft(languageId, merged, note);
    const changes = diffLeaves(baseData, draft.data);
    this.events.emit({ type: "profile", languageId, version: draft.version });
    const paths = changes.map((c) => c.path);
    this.add(languageId, {
      kind: "draft-write",
      text: note?.trim() || (paths.length ? `Taslakta ${paths.length} alan değişti.` : "Taslak yazıldı (değişiklik yok)."),
      paths,
    });
    return { draft, changes };
  }

  private latest(languageId: string): SessionRow | null {
    // Yalnız MCP oturumları (göç 13): sitedeki oluşturucu oturumları (`mode = 'site'`) aynı tabloda, kendi servisinde.
    return (
      (this.db.prepare(`SELECT * FROM design_sessions WHERE language_id = ? AND org_id = $org AND mode = 'mcp' ORDER BY started_at DESC, ${insertOrder(this.db)} DESC LIMIT 1`).get(languageId) as
        | SessionRow
        | undefined) ?? null
    );
  }

  private emit(languageId: string): void {
    this.events.emit({ type: "session", languageId });
  }

  private now(): string {
    return this.clock.now().toISOString();
  }
}

function toEntry(r: EntryRow): DesignSessionEntry {
  const paths = json<string[] | null>(r.paths, null);
  return { id: r.id, at: r.at, kind: r.kind, text: r.text, group: r.grp, ...(paths ? { paths } : {}) };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Yama birleştirme: nesneler derin, diziler ve diğer değerler olduğu gibi; `null` alanı varsayılana bırakır (siler). */
export function mergePatch(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = isObj(v) && isObj(out[k]) ? mergePatch(out[k] as Record<string, unknown>, v) : v;
  }
  return out;
}
