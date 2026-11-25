import { PROFILE_DOCS, type Profile, type RuleChange, profileDocKey } from "@tagpress/domain";
import { diffLeaves } from "../profiles.ts";
import type { StoredRevision } from "./store.ts";

/**
 * Revizyonlar ve değişen kurallar (SUNUCU-PLANI §4.2, §4.5). Revizyon 0 tabandır (oturumun `base_data`'sı); her
 * revizyon tam profili saklar. Geri dönüş eski verinin YENİ revizyon olarak yazılmasıdır (geçmiş silinmez).
 * Değişen kural yaprak düzeyindedir (`diffLeaves`), etiketi/grubu/birimi `PROFILE_DOCS`'tan.
 */

/** Yaprak yolun gösterimi; belgesi yoksa genel grup. */
export function ruleMeta(path: string): Pick<RuleChange, "group" | "label" | "unit"> {
  const key = profileDocKey(path) ?? path;
  const doc = PROFILE_DOCS[key];
  return { group: doc?.group ?? "genel", label: key, unit: doc?.unit ?? null };
}

/** İki profil arasındaki değişen kurallar; kaynağı `source` verir (yol başına). */
export function ruleChanges(from: Profile, to: Profile, source: (path: string) => RuleChange["source"]): RuleChange[] {
  return diffLeaves(from, to).map((c) => ({ path: c.path, ...ruleMeta(c.path), from: c.from, to: c.to, source: source(c.path) }));
}

/** Revizyonun profili: 0 taban, diğerleri kayıttan; yoksa null. */
export function profileAt(base: Profile, revisions: readonly StoredRevision[], rev: number): Profile | null {
  if (rev === 0) return base;
  return revisions.find((r) => r.rev === rev)?.profile ?? null;
}

/**
 * İki revizyon arasındaki fark (`diff?from=&to=`). İleri yönde (to > from) her yolun kaynağı, aradaki revizyonlardan
 * o yolu en son değiştirenin kaydıdır; bulunamazsa (ör. birbirini götüren değişiklikler) `manual`. Geri yönde kaynak
 * hedef revizyondur (`restore`).
 */
export function diffRevisions(base: Profile, revisions: readonly StoredRevision[], from: number, to: number): RuleChange[] | null {
  const a = profileAt(base, revisions, from);
  const b = profileAt(base, revisions, to);
  if (!a || !b) return null;
  if (to <= from) return ruleChanges(a, b, () => ({ kind: "restore", ref: String(to) }));
  const between = revisions.filter((r) => r.rev > from && r.rev <= to).sort((x, y) => y.rev - x.rev);
  return ruleChanges(a, b, (path) => {
    for (const r of between) {
      const c = r.changes.find((x) => x.path === path || path.startsWith(`${x.path}.`) || x.path.startsWith(`${path}.`));
      if (c) return c.source;
    }
    return { kind: "manual", ref: null };
  });
}

/** Revizyonun kısa notu (örnek etiketlerde "Tarih küçüldü"): sayısal değişimde yön, diğerlerinde "changed". */
export function changeDirection(c: Pick<RuleChange, "from" | "to">): "up" | "down" | "changed" {
  if (typeof c.from === "number" && typeof c.to === "number") return c.to > c.from ? "up" : c.to < c.from ? "down" : "changed";
  return "changed";
}
