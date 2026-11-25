import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Reference } from "@tagpress/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localOrg, runInOrg } from "./org/context.ts";
import type { OrgResolver } from "./org/resolver.ts";
import { RETENTION_DAYS } from "./services/undo.ts";
import { type TestApp, call, makeApp, png } from "./test/helpers.ts";
import { DAY_MS } from "./util/clock.ts";
import { isUuidv7 } from "./util/ids.ts";

/**
 * A1 servislerinin firma kapsamı (iki firma, servis düzeyinde): A'nın kaydı B'nin bağlamında görünmez (liste boş,
 * kimlikle okuma 404), B'nin eklemesi B'ye yazılır, A'nın kimliğiyle B'de yazmak A'nın satırını değiştirmez.
 * Uçların tamamı A4'ün izolasyon takımında; burada yalnız iki örnek uç (dil, referans görseli).
 */

const ref = (languageId: string, over: Partial<Reference> = {}): Omit<Reference, "id" | "createdAt"> & { id?: string } => ({
  languageId,
  source: "migrated",
  orderNo: "1",
  quantity: 1,
  templateKey: "a1",
  labelFramePx: 440,
  text: "Anna",
  user: [{ text: "Anna", family: "Great Vibes", style: "Regular", sizePx: 30, segments: [], ink: { x: 1, y: 2, w: 3, h: 4 } }],
  program: null,
  programMeta: null,
  image: null,
  split: "train",
  ...over,
});

/** Satırın firması (bakım kapsamında, kapsamsız okuma). */
const orgOf = (t: TestApp, table: "languages" | "refs" | "learn_proposals" | "ai_calls" | "templates" | "profile_versions" | "design_sessions", where: string, ...args: string[]) =>
  t.raw.all(`SELECT org_id FROM ${table} WHERE ${where}`, ...args).map((r) => r.org_id);

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

let t: TestApp;
let A: string;
let B: string;
/** A'nın dili (şablon + yayınlanmış profil) ve B'nin kendi dili. */
let langA: string;
let langB: string;
const inA = <T>(fn: () => T) => runInOrg(A, fn);
const inB = <T>(fn: () => T) => runInOrg(B, fn);

beforeEach(async () => {
  t = await makeApp({ resolver: { resolve: (req) => localOrg(String(req.headers["x-test-org"] ?? A)) } satisfies OrgResolver });
  A = t.ctx.orgs.defaultOrgId()!;
  B = t.ctx.orgs.create({ name: "B" }).id;
  langA = inA(() => t.ctx.languages.create({ name: "A dili" }).id);
  langB = inB(() => t.ctx.languages.create({ name: "B dili" }).id);
  const dir = inA(() => t.ctx.paths.templates(langA));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "a1.png"), await png(40, 40));
  await inA(() => t.ctx.templates.sync(langA));
});
afterEach(() => t.close());

describe("diller", () => {
  it("A'nın dili B'de yok; B'nin eklemesi B'ye yazılır; yeni kimlik UUIDv7", () => {
    expect(isUuidv7(langA) && isUuidv7(langB)).toBe(true);
    expect(inA(() => t.ctx.languages.list().map((l) => l.id))).toEqual([langA]);
    expect(inB(() => t.ctx.languages.list().map((l) => l.id))).toEqual([langB]);
    expect(orgOf(t, "languages", "id = ?", langB)).toEqual([B]);
    inB(() => {
      expect(t.ctx.languages.exists(langA, true)).toBe(false);
      expect(code(() => t.ctx.languages.get(langA))).toBe("language-not-found");
      expect(code(() => t.ctx.languages.rename(langA, "x"))).toBe("language-not-found");
      expect(code(() => t.ctx.languages.softDelete(langA))).toBe("language-not-found");
      expect(code(() => t.ctx.languages.resolve(langA))).toBe("language-not-found");
      expect(t.ctx.languages.restore([langA])).toBe(0);
      // Varsayılan dil firmaya göre.
      expect(t.ctx.languages.defaultId()).toBe(langB);
    });
    expect(inA(() => t.ctx.languages.get(langA).name)).toBe("A dili");
  });

  it("güvenilir yolla (sahibin aktarım paketi) verilen kimlik: başka firmada doluysa yeni UUIDv7 (A'nın satırı değişmez); kendi firmasında sonek", () => {
    inA(() => t.ctx.languages.createWithTrustedId({ name: "Benim tarzım", id: "benim-tarzim" }));
    const inBId = inB(() => t.ctx.languages.createWithTrustedId({ name: "Benim tarzım (B)", id: "benim-tarzim" }).id);
    expect(isUuidv7(inBId)).toBe(true);
    expect(inA(() => t.ctx.languages.get("benim-tarzim").name)).toBe("Benim tarzım");
    expect(orgOf(t, "languages", "id = 'benim-tarzim'")).toEqual([A]);
    expect(inA(() => t.ctx.languages.createWithTrustedId({ name: "Benim tarzım", id: "benim-tarzim" }).id)).toBe("benim-tarzim-2");
    // UUID kimlik firmada doluysa sonek değil yeni UUID.
    const again = inA(() => t.ctx.languages.createWithTrustedId({ name: "Kopya", id: langA }).id);
    expect(isUuidv7(again) && again !== langA).toBe(true);
    // API yolu (create) kimliği hiç kullanmaz: boş kimlik de UUIDv7 olur (dolu/boş farkı yanıttan okunamaz).
    const viaApi = inB(() => t.ctx.languages.create({ name: "API", id: "bos-kimlik" }).id);
    expect(isUuidv7(viaApi)).toBe(true);
  });

  it("uç: B'nin isteğinde A'nın dili 404, liste yalnız B'ninki", async () => {
    const b = { "x-test-org": B };
    expect((await t.api("GET", `/api/languages/${langA}/profile`, undefined, b)).status).toBe(404);
    expect((await t.api("PATCH", `/api/languages/${langA}`, { name: "x" }, b)).status).toBe(404);
    expect((await t.api("GET", "/api/languages", undefined, b)).json.languages.map((l: { id: string }) => l.id)).toEqual([langB]);
    expect((await t.api("GET", `/api/languages/${langA}/profile`)).status).toBe(200);
  });
});

describe("profiller", () => {
  it("B, A'nın dilinin sürümlerini görmez ve taslak yazamaz", () => {
    inB(() => {
      expect(t.ctx.profiles.active(langA)).toBeNull();
      expect(t.ctx.profiles.versions(langA)).toEqual([]);
      expect(code(() => t.ctx.profiles.activeProfile(langA))).toBe("no-published-profile");
      expect(code(() => t.ctx.profiles.version(langA, 1))).toBe("profile-version-not-found");
      expect(code(() => t.ctx.profiles.saveDraft(langA, { name: "B'den" }))).toBe("language-not-found");
      expect(code(() => t.ctx.profiles.createPublished(langA, { name: "B'den" }, "x"))).toBe("language-not-found");
      t.ctx.profiles.discardDraft(langA);
      t.ctx.profiles.saveDraft(langB, { name: "B taslak" });
    });
    expect(inA(() => t.ctx.profiles.versions(langA).map((v) => v.version))).toEqual([1]);
    expect(inA(() => t.ctx.profiles.draft(langA))).toBeNull();
    expect(orgOf(t, "profile_versions", "language_id = ?", langB)).toEqual([B, B]);
  });
});

describe("şablonlar", () => {
  it("B, A'nın şablonunu görmez, yazamaz; A'nın kaydı değişmez", () => {
    inB(() => {
      expect(t.ctx.templates.list(langA)).toEqual([]);
      expect(t.ctx.templates.keys(langA)).toEqual([]);
      expect(t.ctx.templates.find(langA, "a1")).toBeNull();
      expect(code(() => t.ctx.templates.get(langA, "a1"))).toBe("template-key-not-found");
      expect(code(() => t.ctx.templates.update(langA, "a1", { notes: "B" }))).toBe("template-key-not-found");
      expect(code(() => t.ctx.templates.upsert(langA, { key: "a1", file: "a1.png", hash: "x", width: 1, height: 1, notes: "B" }))).toBe("language-not-found");
      t.ctx.templates.upsert(langB, { key: "b1", file: "b1.png", hash: "x", width: 1, height: 1 });
    });
    expect(inA(() => t.ctx.templates.find(langA, "a1")?.notes ?? "")).not.toBe("B");
    expect(orgOf(t, "templates", "language_id = ?", langA)).toEqual([A]);
    expect(orgOf(t, "templates", "language_id = ?", langB)).toEqual([B]);
  });

  it("geçici şablon temizliği yalnız geçerli firmanın kayıtlarına bakar", async () => {
    inA(() => t.ctx.templates.update(langA, "a1", { tags: ["gecici"] }));
    t.clock.advance(2 * DAY_MS);
    expect(await inB(() => t.ctx.templates.purgeTemporary(DAY_MS))).toEqual([]);
    expect(inA(() => t.ctx.templates.keys(langA))).toEqual(["a1"]);
    expect(await inA(() => t.ctx.templates.purgeTemporary(DAY_MS))).toEqual(["a1"]);
  });
});

describe("fontlar", () => {
  it("dosyalar firmanın kökünde: A'nın yüklediği font B'de (aynı dil kimliğiyle de) görünmez", async () => {
    const font = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60)]);
    const profile = inA(() => t.ctx.profiles.activeProfile(langA).profile);
    await inA(() => t.ctx.fonts.upload(langA, "Yazi.ttf", font));
    expect((await inA(() => t.ctx.fonts.list(langA, profile))).files.map((f) => f.file)).toEqual(["Yazi.ttf"]);
    expect((await inB(() => t.ctx.fonts.list(langA, profile))).files).toEqual([]);
    expect(code(() => inB(() => t.ctx.fonts.file(langA, "language", "Yazi.ttf")))).toBe("font-file-not-found");
  });
});

describe("referanslar ve öğrenme önerileri", () => {
  it("A'nın referansı B'de yok; A'nın kimliğiyle B'de kayıt A'nınkini değiştirmez (yeni kimlik)", () => {
    const r = inA(() => t.ctx.references.save(ref(langA)));
    inB(() => {
      expect(t.ctx.references.list()).toEqual([]);
      expect(t.ctx.references.list({ languageId: langA })).toEqual([]);
      expect(code(() => t.ctx.references.get(r.id))).toBe("reference-not-found");
      expect(code(() => t.ctx.references.update(r.id, { text: "B" }))).toBe("reference-not-found");
      expect(code(() => t.ctx.references.remove(r.id))).toBe("reference-not-found");
      expect(t.ctx.references.breakExamples(langA)).toEqual([]);
      expect(code(() => t.ctx.references.save(ref(langA)))).toBe("language-not-found");
      const mine = t.ctx.references.save({ ...ref(langB, { text: "B metni" }), id: r.id });
      expect(mine.id).not.toBe(r.id);
      expect(t.ctx.references.list().map((x) => x.text)).toEqual(["B metni"]);
    });
    expect(inA(() => t.ctx.references.get(r.id).text)).toBe("Anna");
    expect(orgOf(t, "refs", "id = ?", r.id)).toEqual([A]);
  });

  it("uç: referans görseli firmanın kökünden; B'nin isteğinde A'nın referansı 404", async () => {
    const dir = inA(() => t.ctx.paths.references(langA));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "r.png"), await png(8, 8));
    const r = inA(() => t.ctx.references.save(ref(langA, { image: `referanslar/${langA}/r.png` })));
    expect((await t.api("GET", `/api/references/${r.id}/image.png`)).status).toBe(200);
    expect((await t.api("GET", `/api/references/${r.id}/image.png`, undefined, { "x-test-org": B })).status).toBe(404);
    expect((await t.api("GET", `/api/references/${r.id}`, undefined, { "x-test-org": B })).status).toBe(404);
  });

  it("öneriler firmaya göre", () => {
    const p = inA(() => t.ctx.learn.create({ languageId: langA, title: "A önerisi", summary: "", patch: null, evidence: null }));
    inB(() => {
      expect(t.ctx.learn.list()).toEqual([]);
      expect(code(() => t.ctx.learn.get(p.id))).toBe("proposal-not-found");
      expect(code(() => t.ctx.learn.update(p.id, { status: "rejected" }))).toBe("proposal-not-found");
      expect(code(() => t.ctx.learn.remove(p.id))).toBe("proposal-not-found");
      expect(code(() => t.ctx.learn.create({ languageId: langA, title: "x", summary: "", patch: null, evidence: null }))).toBe("language-not-found");
      t.ctx.learn.create({ languageId: langB, title: "B önerisi", summary: "", patch: null, evidence: null });
    });
    expect(inA(() => t.ctx.learn.get(p.id).status)).toBe("open");
    expect(orgOf(t, "learn_proposals", "language_id = ?", langB)).toEqual([B]);
  });
});

describe("tasarım oturumu", () => {
  it("A'nın oturumu B'de görünmez; B, A'nın dilinde oturum açamaz", () => {
    inA(() => t.ctx.designSessions.add(langA, { kind: "question", text: "Soru?" }));
    inB(() => {
      expect(t.ctx.designSessions.current(langA)).toMatchObject({ id: null, status: "idle", entries: [] });
      expect(code(() => t.ctx.designSessions.start(langA))).toBe("language-not-found");
      expect(code(() => t.ctx.designSessions.add(langA, { kind: "note", text: "B" }))).toBe("language-not-found");
      t.ctx.designSessions.add(langB, { kind: "note", text: "B notu" });
    });
    expect(inA(() => t.ctx.designSessions.current(langA).entries.map((e) => e.text))).toEqual(["Soru?"]);
    expect(orgOf(t, "design_sessions", "language_id = ?", langB)).toEqual([B]);
  });
});

describe("maliyet", () => {
  it("çağrılar ve özet firmaya göre", () => {
    const a = inA(() => t.ctx.costs.record(call("design"), { jobId: "is-a", languageId: langA }));
    inB(() => {
      expect(t.ctx.costs.summary()).toMatchObject({ totalUsd: 0, byPurpose: [], byModel: [], unpricedCalls: 0 });
      expect(t.ctx.costs.forJob("is-a")).toEqual([]);
      expect(code(() => t.ctx.costs.get(a.id))).toBe("ai-call-not-found");
      t.ctx.costs.record(call("pick"), { languageId: langB });
      expect(t.ctx.costs.summary().byPurpose.map((x) => x.purpose)).toEqual(["pick"]);
    });
    expect(inA(() => t.ctx.costs.summary().byPurpose.map((x) => [x.purpose, x.calls]))).toEqual([["design", 1]]);
    expect(orgOf(t, "ai_calls", "id = ?", a.id)).toEqual([A]);
  });
});

describe("geri alma ve kalıcı temizlik", () => {
  it("A'nın geri alma anahtarı B'de bulunamaz; B'nin temizliği A'nın satırlarına dokunmaz", async () => {
    const token = inA(() => {
      t.ctx.languages.softDelete(langA);
      return t.ctx.undo.languageDeleted(langA).undoToken;
    });
    expect(code(() => inB(() => t.ctx.undo.undo(token)))).toBe("undo-not-found");
    expect(inA(() => t.ctx.languages.list())).toEqual([]);
    expect(inA(() => t.ctx.undo.undo(token).ok)).toBe(true);
    expect(inA(() => t.ctx.languages.list().map((l) => l.id))).toEqual([langA]);
    expect(code(() => inB(() => t.ctx.undo.deleteVariant("yok")))).toBe("variant-not-found");
    expect(code(() => inB(() => t.ctx.undo.deleteJobs(["yok"])))).toBe("jobs-to-delete-not-found");

    // Süresi dolan silinmiş referans: yalnız kendi firmasının temizliğinde gider.
    const r = inA(() => t.ctx.references.save(ref(langA)));
    inA(() => t.ctx.references.remove(r.id));
    t.clock.advance((RETENTION_DAYS + 1) * DAY_MS);
    await inB(() => t.ctx.undo.purge());
    expect(orgOf(t, "refs", "id = ?", r.id)).toEqual([A]);
    await inA(() => t.ctx.undo.purge());
    expect(orgOf(t, "refs", "id = ?", r.id)).toEqual([]);
  });
});

describe("dil paketi", () => {
  it("B, A'nın dilini dışa aktaramaz; A'nın paketini B'ye almak B'de yeni dil açar (A'nınki değişmez)", async () => {
    const pkg = await inA(() => t.ctx.languagePackages.export(langA));
    await expect(inB(() => t.ctx.languagePackages.export(langA))).rejects.toMatchObject({ code: "language-not-found" });
    const imp = await inB(() => t.ctx.languagePackages.import({ ...pkg, name: "B kopyası" }));
    expect(imp.language.id).not.toBe(langA);
    expect(isUuidv7(imp.language.id)).toBe(true);
    expect(imp.templates).toBe(1);
    expect(inB(() => t.ctx.templates.keys(imp.language.id))).toEqual(["a1"]);
    expect(inA(() => t.ctx.languages.get(langA).name)).toBe("A dili");
    expect(orgOf(t, "templates", "language_id = ?", langA)).toEqual([A]);
  });
});
