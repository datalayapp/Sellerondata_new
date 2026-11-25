import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type KeyProtector, dpapiDecrypt, dpapiEncrypt, dpapiProtector, powershellPath } from "./services/dpapi.ts";
import {
  KEY_FILE_NAME,
  MASTER_KEY_DIR_ENV,
  MASTER_KEY_ENV,
  MASTER_KEY_OLD_ENV,
  SEALED_FORMAT,
  SecretKeyError,
  defaultKeyFile,
  defaultKeyProvider,
  envKeyProvider,
  fileKeyProvider,
  generateMasterKey,
  keyRing,
  open,
  parseMasterKey,
  pruneKeyFile,
  rotateKeyFile,
  seal,
} from "./services/secret-box.ts";
import { UnreadableKeyError } from "./services/secrets.ts";
import { type TestApp, makeApp } from "./test/helpers.ts";

const SECRET = "sk-ant-gizli-ğüş-1234567890";
/** Sahte koruyucu (platformdan bağımsız sarma denemesi): ters çevrilmiş base64. */
const fakeProtector: KeyProtector = {
  name: "sahte",
  protect: (s) => Buffer.from(s).toString("base64").split("").reverse().join(""),
  unprotect: (s) => Buffer.from(s.split("").reverse().join(""), "base64").toString("utf8"),
};
const plainFile = { protector: null };
const b64 = (k: { key: Buffer }) => k.key.toString("base64");

/** Beklenen hata kodu; mesajda gizli değer olmamalı. */
function expectSecretError(fn: () => unknown, code: string, ...mustNotContain: string[]) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SecretKeyError);
    expect((err as SecretKeyError).code).toBe(code);
    for (const s of mustNotContain) expect((err as Error).message).not.toContain(s);
    return;
  }
  throw new Error(`hata bekleniyordu: ${code}`);
}

describe("şifreleme (AES-256-GCM)", () => {
  const ring = keyRing(generateMasterKey());

  it("gidiş-dönüş; şifreli metin düz değeri içermez, her şifrelemede farklıdır", () => {
    const a = seal(ring, SECRET, "tagpress:key:anthropic");
    const b = seal(ring, SECRET, "tagpress:key:anthropic");
    expect(a).toMatchObject({ format: SEALED_FORMAT, kid: ring.current.id });
    expect(a.value).not.toBe(b.value);
    expect(JSON.stringify(a)).not.toContain("gizli");
    expect(Buffer.from(a.value, "base64").toString("utf8")).not.toContain("gizli");
    expect(open(ring, a, "tagpress:key:anthropic")).toBe(SECRET);
  });

  it("başka bağlamda (sağlayıcı), değiştirilmiş kayıtta ve yanlış ana anahtarda açık hata", () => {
    const s = seal(ring, SECRET, "tagpress:key:anthropic");
    expectSecretError(() => open(ring, s, "tagpress:key:gemini"), "secret-corrupt", SECRET);
    const buf = Buffer.from(s.value, "base64");
    buf.writeUInt8(buf.readUInt8(buf.length - 1) ^ 1, buf.length - 1);
    expectSecretError(() => open(ring, { ...s, value: buf.toString("base64") }, "tagpress:key:anthropic"), "secret-corrupt", SECRET);
    expectSecretError(() => open(keyRing(generateMasterKey()), s, "tagpress:key:anthropic"), "master-key-mismatch");
    // Aynı kimlikle sahte anahtar: doğrulama düşer.
    expectSecretError(() => open({ current: { id: ring.current.id, key: generateMasterKey().key }, previous: [] }, s, "tagpress:key:anthropic"), "secret-corrupt");
  });

  it("döndürmeden kalan eski anahtar çözer; yeni kayıt geçerli anahtarla şifrelenir", () => {
    const old = generateMasterKey();
    const s = seal(keyRing(old), SECRET, "x");
    const rotated = keyRing(generateMasterKey(), [old]);
    expect(open(rotated, s, "x")).toBe(SECRET);
    expect(seal(rotated, SECRET, "x").kid).toBe(rotated.current.id);
  });

  it("ana anahtar biçimi: base64 32 bayt; değilse değeri yazmayan açık hata", () => {
    const k = generateMasterKey();
    expect(parseMasterKey(`  ${b64(k)}\n`, "x").id).toBe(k.id);
    expectSecretError(() => parseMasterKey("kisa-deger-123", "x"), "master-key-invalid", "kisa-deger-123");
    expectSecretError(() => parseMasterKey(Buffer.alloc(16).toString("base64"), "x"), "master-key-invalid");
    expectSecretError(() => parseMasterKey("", "x"), "master-key-invalid");
  });
});

describe("ana anahtar kaynakları", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
  const tmp = () => (dir = mkdtempSync(path.join(os.tmpdir(), "anahtar-")));

  it("ortam değişkeni: yoksa kaynak yok; eski anahtarlar ikinci değişkende; bozuksa açık hata", async () => {
    expect(envKeyProvider({})).toBeNull();
    const cur = generateMasterKey();
    const old = generateMasterKey();
    const ring = await envKeyProvider({ [MASTER_KEY_ENV]: b64(cur), [MASTER_KEY_OLD_ENV]: ` ${b64(old)} ` })!.load();
    expect(ring!.current.id).toBe(cur.id);
    expect(ring!.previous.map((k) => k.id)).toEqual([old.id]);
    expect(envKeyProvider({ [MASTER_KEY_ENV]: b64(cur) })!.create).toBeUndefined();
    await expect(envKeyProvider({ [MASTER_KEY_ENV]: "yanlis" })!.load()).rejects.toMatchObject({ code: "master-key-invalid" });
    await expect(envKeyProvider({ [MASTER_KEY_ENV]: b64(cur), [MASTER_KEY_OLD_ENV]: "x" })!.load()).rejects.toMatchObject({ code: "master-key-invalid" });
  });

  it("tanımlı ama boş TAGPRESS_SECRET_KEY / _OLD açılışı durdurur (dosyaya düşülmez)", async () => {
    const cur = b64(generateMasterKey());
    const envs: NodeJS.ProcessEnv[] = [
      { [MASTER_KEY_ENV]: "" },
      { [MASTER_KEY_ENV]: "   " },
      { [MASTER_KEY_ENV]: cur, [MASTER_KEY_OLD_ENV]: "" },
      { [MASTER_KEY_ENV]: cur, [MASTER_KEY_OLD_ENV]: " , " },
      { [MASTER_KEY_ENV]: cur, [MASTER_KEY_OLD_ENV]: `${cur},` },
    ];
    const d = tmp();
    await fileKeyProvider(path.join(d, KEY_FILE_NAME), plainFile).create!(); // dosya olsa bile ona düşülmez
    for (const env of envs) {
      await expect(defaultKeyProvider(d, env, plainFile).load(), JSON.stringify(Object.keys(env))).rejects.toMatchObject({ name: "SecretKeyError", code: "master-key-invalid" });
    }
  });

  it("dosyanın yeri: Windows'ta veri klasörü; öteki sistemlerde veri klasörü dışı (XDG / ~/.config); TAGPRESS_SECRET_KEY_DIR ile değişir", () => {
    const data = path.resolve("/veri");
    expect(defaultKeyFile(data, {}, "win32")).toBe(path.join(data, KEY_FILE_NAME));
    // Kuruluma göre ayrı alt klasör (ayrıntı: secret-box-file.test.ts).
    expect(defaultKeyFile(data, { XDG_CONFIG_HOME: path.resolve("/xdg") }, "linux")).toMatch(/[\\/]xdg[\\/]tagpress[\\/][0-9a-f]{16}[\\/]ana-anahtar\.json$/);
    expect(defaultKeyFile(data, {}, "linux").startsWith(path.join(os.homedir(), ".config", "tagpress") + path.sep)).toBe(true);
    expect(defaultKeyFile(data, {}, "linux").startsWith(data + path.sep)).toBe(false);
    expect(defaultKeyFile(data, { [MASTER_KEY_DIR_ENV]: path.resolve("/gizli") }, "linux")).toBe(path.join(path.resolve("/gizli"), KEY_FILE_NAME));
    expect(defaultKeyFile(data, { [MASTER_KEY_DIR_ENV]: path.resolve("/gizli") }, "win32")).toBe(path.join(path.resolve("/gizli"), KEY_FILE_NAME));
  });

  it("sunucu kipinde (TAGPRESS_MODE=server / NODE_ENV=production) dosya okunmaz: TAGPRESS_SECRET_KEY zorunlu", async () => {
    const d = tmp();
    const file = path.join(d, KEY_FILE_NAME);
    await fileKeyProvider(file, plainFile).create!();
    for (const env of [{ TAGPRESS_MODE: "server" }, { NODE_ENV: "production" }]) {
      const p = defaultKeyProvider(d, env, { file, protector: null });
      expect(p.create).toBeUndefined();
      await expect(p.load()).rejects.toMatchObject({ name: "SecretKeyError", code: "master-key-missing" });
    }
    const k = generateMasterKey();
    const ok = await defaultKeyProvider(path.join(d, "yok"), { TAGPRESS_MODE: "server", [MASTER_KEY_ENV]: b64(k) }, plainFile).load();
    expect(ok!.current.id).toBe(k.id);
  });

  it("ortam değişkeni + anahtar dosyası: dosyadaki anahtarlar bir açılış boyunca eski anahtar (sunucu kipinde de), not düşülür", async () => {
    const d = tmp();
    const file = path.join(d, KEY_FILE_NAME);
    const fromFile = await fileKeyProvider(file, plainFile).create!();
    const k = generateMasterKey();
    for (const env of [{ [MASTER_KEY_ENV]: b64(k) }, { [MASTER_KEY_ENV]: b64(k), TAGPRESS_MODE: "server" }]) {
      const ring = (await defaultKeyProvider(d, env, { file, protector: null }).load())!;
      expect(ring.current.id).toBe(k.id);
      expect(ring.previous.map((x) => x.id)).toEqual([fromFile.current.id]);
      expect(ring.notes?.join(" ")).toMatch(/eski anahtar olarak yüklendi/);
    }
    rmSync(file);
    expect((await defaultKeyProvider(d, { [MASTER_KEY_ENV]: b64(k) }, { file, protector: null }).load())!.notes).toBeUndefined();
  });

  it("anahtar dosyası koruyucuyla sarılır; sarılmamış dosya ilk okumada sarılır; koruyucusuz açılmaz", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    const wrapped = fileKeyProvider(file, { protector: fakeProtector });
    const a = await wrapped.create!();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ format: "tagpress-ana-anahtar/v1", protection: "sahte", keys: expect.any(String) });
    expect(readFileSync(file, "utf8")).not.toContain(b64(a.current));
    expect((await wrapped.load())!.current.id).toBe(a.current.id);
    await expect(fileKeyProvider(file, plainFile).load()).rejects.toMatchObject({ code: "master-key-invalid" });
    await expect(fileKeyProvider(file, { protector: { ...fakeProtector, unprotect: () => "bozuk" } }).load()).rejects.toMatchObject({ code: "master-key-invalid" });
    // Sarılmamış dosya (yalnız kopya veride olur): koruyucuyla ilk okumada sarılır, anahtar aynı kalır.
    rmSync(file);
    const plain = await fileKeyProvider(file, plainFile).create!();
    expect(readFileSync(file, "utf8")).toContain(b64(plain.current));
    const loaded = (await wrapped.load())!;
    expect(loaded.current.id).toBe(plain.current.id);
    expect(loaded.notes?.join(" ")).toMatch(/sahte ile sarıldı/);
    expect(readFileSync(file, "utf8")).not.toContain(b64(plain.current));
    expect((await wrapped.load())!.notes).toBeUndefined();
    // Döndürme ve temizlik sarılı dosyada da çalışır.
    const r = rotateKeyFile(file, { protector: fakeProtector });
    expect(JSON.parse(readFileSync(file, "utf8")).protection).toBe("sahte");
    expect(pruneKeyFile(file, new Set(), { protector: fakeProtector })).toEqual([plain.current.id]);
    expect((await wrapped.load())!.current.id).toBe(r.current);
  });

  it("powershell.exe tam yoluyla çağrılır (PATH'teki aynı adlı dosya değil)", () => {
    expect(powershellPath({ SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toMatch(/^[A-Z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  });

  it("dosya: yoksa null; üretilir, var olanın üstüne yazılmaz; bozuksa açık hata", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    const p = fileKeyProvider(file, plainFile);
    expect(await p.load()).toBeNull();
    const a = await p.create!();
    const b = await p.create!();
    expect(b.current.id).toBe(a.current.id);
    expect((await p.load())!.current.id).toBe(a.current.id);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    writeFileSync(file, "{bozuk");
    await expect(p.load()).rejects.toMatchObject({ code: "master-key-invalid" });
    writeFileSync(file, JSON.stringify({ format: "baska", keys: [] }));
    await expect(p.load()).rejects.toMatchObject({ code: "master-key-invalid" });
  });

  it("dosya izni: Windows dışında başkalarınca okunabilir dosya reddedilir (Windows'ta profilin erişim listesine güvenilir)", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    const p = fileKeyProvider(file, plainFile);
    await p.create!();
    chmodSync(file, 0o644);
    if (process.platform === "win32") expect(await p.load()).not.toBeNull();
    else await expect(p.load()).rejects.toMatchObject({ code: "master-key-permissions" });
  });

  it("döndürme ve eski anahtarların temizliği (kullanımdaki eski anahtar kalır)", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    const p = fileKeyProvider(file, plainFile);
    const first = (await p.create!()).current.id;
    const r1 = rotateKeyFile(file, plainFile);
    const r2 = rotateKeyFile(file, plainFile);
    expect(r2.previous).toEqual([r1.current, first]);
    const ring = (await p.load())!;
    expect(ring.current.id).toBe(r2.current);
    expect(ring.previous.map((k) => k.id)).toEqual([r1.current, first]);
    expect(pruneKeyFile(file, new Set([first]), plainFile)).toEqual([r1.current]);
    expect((await p.load())!.previous.map((k) => k.id)).toEqual([first]);
    expect(pruneKeyFile(file, new Set(), plainFile)).toEqual([first]);
    expect((await p.load())!.previous).toEqual([]);
    expect(pruneKeyFile(file, new Set(), plainFile)).toEqual([]);
    expect(readdirSync(path.dirname(file)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("anahtar saklama (uygulama)", () => {
  let t: TestApp | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const keyFile = () => path.join(dir!, KEY_FILE_NAME);
  const row = (key = "key:anthropic") => (t!.raw.get("SELECT value FROM settings WHERE key = ?", key) as { value: string } | undefined)?.value;
  /** Aynı veri klasörüyle yeniden açılış. */
  async function restart(opts: Parameters<typeof makeApp>[0] = {}) {
    if (t) await t.app.close();
    t = await makeApp({ dir: dir!, ...opts });
    return t;
  }
  const fresh = async (opts: Parameters<typeof makeApp>[0] = {}) => {
    dir = mkdtempSync(path.join(os.tmpdir(), "anahtar-app-"));
    return restart(opts);
  };

  it("kayıt şifreli yazılır, yeniden açılışta çözülür; uyarı yok", async () => {
    await fresh();
    expect(t!.ctx.secretsReport).toMatchObject({ created: true, migrated: [], failed: [] });
    expect(existsSync(keyFile())).toBe(true);
    const put = await t!.api("PUT", "/api/settings/keys/anthropic", { apiKey: SECRET });
    expect(put.json).toMatchObject({ hasKey: true, encrypted: true });
    const stored = JSON.parse(row()!);
    expect(stored).toMatchObject({ format: SEALED_FORMAT, kid: expect.any(String) });
    expect(row()).not.toContain("gizli");
    for (const f of ["studio.db", "studio.db-wal"]) {
      const file = path.join(dir!, f);
      if (existsSync(file)) expect(readFileSync(file).toString("utf8")).not.toContain("gizli");
    }
    expect((await t!.api("GET", "/api/settings")).json.warnings).toEqual([]);
    await restart();
    expect(t!.ctx.secretsReport).toMatchObject({ created: false, migrated: [], rotated: [], failed: [] });
    expect(t!.ctx.secrets.get("anthropic")).toBe(SECRET);
  });

  it("ana anahtar dosyası kaybolursa yenisi üretilmez; açık hata, kayıt yerinde kalır", async () => {
    await fresh();
    t!.ctx.secrets.set("anthropic", SECRET);
    const before = row();
    rmSync(keyFile());
    await restart();
    expect(existsSync(keyFile())).toBe(false);
    expect(t!.ctx.secretsReport.failed).toEqual([{ provider: "anthropic", reason: expect.stringContaining("Ana anahtar bulunamadı") }]);
    expect(() => t!.ctx.secrets.get("anthropic")).toThrow(UnreadableKeyError);
    const warnings = (await t!.api("GET", "/api/settings")).json.warnings as string[];
    expect(warnings.join(" ")).toMatch(/çözülemiyor/);
    expect(warnings.join(" ")).toMatch(/Ana anahtar yok/);
    const put = await t!.api("PUT", "/api/settings/keys/gemini", { apiKey: "gm-yeni-1234" });
    expect(put.status).toBe(409);
    expect(put.json).toMatchObject({ code: "master-key-missing", params: { keys: expect.stringContaining(KEY_FILE_NAME) } });
    // İstemciye giden hiçbir metinde disk yolu yok (yol yalnız sunucu günlüğünde: `secretsReport.source`).
    const tmpRoot = path.dirname(dir!);
    const noPath = (v: unknown) => {
      const text = JSON.stringify(v);
      expect(text).not.toContain(tmpRoot);
      expect(text).not.toContain(JSON.stringify(tmpRoot).slice(1, -1));
    };
    noPath(put.json);
    noPath(warnings);
    let unreadable: unknown;
    try {
      t!.ctx.secrets.get("anthropic");
    } catch (e) {
      unreadable = e;
    }
    expect(unreadable).toMatchObject({ code: "key-unreadable" });
    noPath({ message: (unreadable as Error).message, params: (unreadable as { params?: unknown }).params });
    expect(t!.ctx.secretsReport.source).toContain(dir!);
    expect(row()).toBe(before);
    expect(row("key:gemini")).toBeUndefined();
  });

  it("yanlış ana anahtar: açık hata (409 key-unreadable); yeniden girilen anahtar kaydı onarır", async () => {
    await fresh();
    t!.ctx.secrets.set("anthropic", SECRET);
    const before = row();
    rmSync(keyFile());
    const other = generateMasterKey();
    writeFileSync(keyFile(), JSON.stringify({ format: "tagpress-ana-anahtar/v1", keys: [{ id: other.id, key: b64(other), createdAt: "2026-01-01T00:00:00.000Z" }] }), { mode: 0o600 });
    await restart();
    expect(t!.ctx.secretsReport.failed[0]).toMatchObject({ provider: "anthropic", reason: expect.stringContaining("başka bir ana anahtarla") });
    let err: unknown;
    try {
      t!.ctx.secrets.get("anthropic");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(UnreadableKeyError);
    expect(err).toMatchObject({ status: 409, code: "key-unreadable" });
    expect((err as Error).message).not.toContain("gizli");
    expect(row()).toBe(before);
    expect((await t!.api("PUT", "/api/settings/keys/anthropic", { apiKey: "sk-ant-yeni-anahtar" })).status).toBe(200);
    expect(t!.ctx.secrets.get("anthropic")).toBe("sk-ant-yeni-anahtar");
    expect((await t!.api("GET", "/api/settings")).json.warnings).toEqual([]);
  });

  it("bozuk ana anahtar dosyasında uygulama açılmaz (düz metne düşülmez)", async () => {
    await fresh();
    await t!.app.close();
    t = undefined;
    writeFileSync(keyFile(), "{bozuk");
    await expect(makeApp({ dir: dir! })).rejects.toMatchObject({ name: "SecretKeyError", code: "master-key-invalid" });
  });

  it("ortam değişkeninden ana anahtar: dosya yazılmaz; döndürmede eski anahtarla şifreli kayıt yeniden şifrelenir", async () => {
    const old = generateMasterKey();
    const cur = generateMasterKey();
    await fresh({ secretKeys: envKeyProvider({ [MASTER_KEY_ENV]: b64(old) })! });
    t!.ctx.secrets.set("gemini", SECRET);
    expect(existsSync(keyFile())).toBe(false);
    await restart({ secretKeys: envKeyProvider({ [MASTER_KEY_ENV]: b64(cur), [MASTER_KEY_OLD_ENV]: b64(old) })! });
    expect(t!.ctx.secretsReport.rotated).toEqual(["gemini"]);
    expect(JSON.parse(row("key:gemini")!).kid).toBe(cur.id);
    await restart({ secretKeys: envKeyProvider({ [MASTER_KEY_ENV]: b64(cur) })! });
    expect(t!.ctx.secretsReport).toMatchObject({ rotated: [], failed: [] });
    expect(t!.ctx.secrets.get("gemini")).toBe(SECRET);
  });

  it("dosyalı döndürme: açılışta yeniden şifrelenir, ardından eski anahtar silinebilir", async () => {
    await fresh();
    t!.ctx.secrets.set("anthropic", SECRET);
    const firstKid = JSON.parse(row()!).kid as string;
    const r = rotateKeyFile(keyFile(), plainFile);
    await restart();
    expect(t!.ctx.secretsReport.rotated).toEqual(["anthropic"]);
    expect(JSON.parse(row()!).kid).toBe(r.current);
    expect(pruneKeyFile(keyFile(), new Set([JSON.parse(row()!).kid]), plainFile)).toEqual([firstKid]);
    await restart();
    expect(t!.ctx.secrets.get("anthropic")).toBe(SECRET);
  });

  it("eski düz kayıt (Windows dışı eski sürüm) açılışta şifreli biçime taşınır", async () => {
    await fresh();
    t!.ctx.settings.setValue("key:anthropic", { format: "plain", value: SECRET, updatedAt: "2026-10-09T00:00:00.000Z" });
    await restart();
    expect(t!.ctx.secretsReport.migrated).toEqual(["anthropic"]);
    expect(JSON.parse(row()!)).toMatchObject({ format: SEALED_FORMAT, updatedAt: "2026-10-09T00:00:00.000Z" });
    expect(row()).not.toContain("gizli");
    expect(t!.ctx.secrets.get("anthropic")).toBe(SECRET);
  });

  it("eski DPAPI kaydı: çözücüyle taşınır; çözülemezse ya da bu platformda çözücü yoksa eski kayıt silinmez", async () => {
    const dpapi = { format: "dpapi", value: "ZXNraS1rYXlpdA==", updatedAt: "2026-10-09T19:40:27.737Z" };
    await fresh();
    t!.ctx.settings.setValue("key:anthropic", dpapi);
    t!.ctx.settings.setValue("key:gemini", dpapi);
    const before = row();
    // Çözücü düşerse (başka Windows kullanıcısı): kayıtlar aynen kalır, açık hata.
    await restart({
      legacyDpapi: () => {
        throw new Error("DPAPI kaydı çözülemedi.");
      },
    });
    expect(t!.ctx.secretsReport.failed.map((f) => f.provider)).toEqual(["anthropic", "gemini"]);
    expect(row()).toBe(before);
    expect(() => t!.ctx.secrets.get("anthropic")).toThrow(/DPAPI kaydı çözülemedi/);
    // Çözücü yok (Windows dışı): yine kayıt yerinde.
    await restart({ legacyDpapi: null });
    expect(t!.ctx.secretsReport.failed[0]!.reason).toMatch(/Windows DPAPI/);
    expect(row()).toBe(before);
    // Boş çözülen kayıt taşınmaz.
    await restart({ legacyDpapi: () => "  " });
    expect(t!.ctx.secretsReport.migrated).toEqual([]);
    expect(row()).toBe(before);
    // Çözücü çalışınca taşınır; ikinci açılışta iş kalmaz.
    await restart({ legacyDpapi: (s) => (s === dpapi.value ? SECRET : "") });
    expect(t!.ctx.secretsReport).toMatchObject({ migrated: ["anthropic", "gemini"], failed: [] });
    expect(JSON.parse(row()!)).toMatchObject({ format: SEALED_FORMAT, updatedAt: dpapi.updatedAt });
    await restart({ legacyDpapi: null });
    expect(t!.ctx.secretsReport).toMatchObject({ migrated: [], failed: [] });
    expect(t!.ctx.secrets.get("anthropic")).toBe(SECRET);
    expect(t!.ctx.secrets.get("gemini")).toBe(SECRET);
    // Açılış özeti ve uyarılar değer içermez.
    expect(JSON.stringify(t!.ctx.secretsReport)).not.toContain("gizli");
    expect(JSON.stringify(t!.ctx.secrets.warnings())).not.toContain("gizli");
  });
});

// Gerçek DPAPI yalnız Windows'ta vardır; eski kayıtlar yalnız orada oluştu ve orada taşınır. Öteki platformlarda bu
// yolun davranışı (çözücü yok → kayıt yerinde, açık hata) yukarıdaki platform bağımsız testte sahte çözücüyle denenir.
// eslint-disable-next-line no-restricted-properties -- DPAPI yalnız Windows'ta var (gerekçe yukarıda)
describe.runIf(process.platform === "win32")("DPAPI'den taşıma (Windows)", () => {
  it("DPAPI ile şifreli gerçek kayıt ilk açılışta yeni biçime taşınır", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "anahtar-dpapi-"));
    let t = await makeApp({ dir });
    try {
      const value = dpapiEncrypt(SECRET);
      expect(value).not.toContain("gizli");
      t.ctx.settings.setValue("key:anthropic", { format: "dpapi", value, updatedAt: "2026-10-09T19:40:27.737Z" });
      await t.app.close();
      t = await makeApp({ dir, legacyDpapi: dpapiDecrypt });
      expect(t.ctx.secretsReport).toMatchObject({ migrated: ["anthropic"], failed: [] });
      const stored = JSON.parse((t.raw.get("SELECT value FROM settings WHERE key = 'key:anthropic'") as { value: string }).value);
      expect(stored.format).toBe(SEALED_FORMAT);
      expect(t.ctx.secrets.get("anthropic")).toBe(SECRET);
    } finally {
      await t.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("ana anahtar dosyası DPAPI ile sarılır: dosyada anahtar görünmez, aynı kullanıcı açar; sarılmamış dosya sarılır", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "anahtar-dpapi-"));
    try {
      const file = path.join(dir, KEY_FILE_NAME);
      const ring = await fileKeyProvider(file, plainFile).create!();
      const loaded = (await defaultKeyProvider(dir, {}, { protector: dpapiProtector }).load())!;
      expect(loaded.current.id).toBe(ring.current.id);
      expect(loaded.notes?.join(" ")).toMatch(/dpapi ile sarıldı/);
      const text = readFileSync(file, "utf8");
      expect(JSON.parse(text)).toMatchObject({ protection: "dpapi" });
      expect(text).not.toContain(b64(ring.current));
      // Varsayılan (Windows) koruyucuyla da açılır.
      expect((await defaultKeyProvider(dir, {}).load())!.current.id).toBe(ring.current.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
