/** Profil yolu ("sizing.tiers.secondary") okuma/yazma. Yazma kopyalar; girdi değişmez. */

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split(".");
  const walk = (node: unknown, i: number): unknown => {
    const key = keys[i] as string;
    const base: Record<string, unknown> | unknown[] = Array.isArray(node)
      ? [...(node as unknown[])]
      : { ...((node as Record<string, unknown> | null | undefined) ?? {}) };
    const rec = base as Record<string, unknown>;
    rec[key] = i === keys.length - 1 ? value : walk(rec[key], i + 1);
    return base;
  };
  return walk(obj, 0) as T;
}

export interface LeafChange {
  path: string;
  from: unknown;
  to: unknown;
}

/** Yaprak alan farkları; diziler tek değer sayılır (sunucudaki `diffLeaves` ile aynı kural). */
export function diffLeaves(a: unknown, b: unknown, path = ""): LeafChange[] {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (isObj(a) && isObj(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((k) => diffLeaves(a[k], b[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a ?? null, to: b ?? null }];
}

/**
 * Bir düzenlemenin kayda değer olup olmadığını söyler. `cur` ekrandaki kopya, `active` yayınlanmış sürüm.
 * - "none": hiçbir alan gerçekten değişmedi (normalize, varsayılan doldurma, aynı değeri yazma) → kayıt yok.
 * - "revert": taslak yokken kopya yayınlanmışla aynı oldu → bekleyen kayıt iptal, taslak oluşmaz.
 * - "save": gerçek değişiklik → taslağa kaydedilir.
 */
export function planEdit<T>(
  cur: T,
  active: T | null,
  hasServerDraft: boolean,
  changes: Array<{ path: string; value: unknown }>,
): { kind: "none" | "revert" | "save"; next: T } {
  let next = cur;
  for (const c of changes) next = setPath(next, c.path, c.value);
  if (diffLeaves(cur, next).length === 0) return { kind: "none", next: cur };
  if (!hasServerDraft && active && diffLeaves(active, next).length === 0) return { kind: "revert", next };
  return { kind: "save", next };
}
