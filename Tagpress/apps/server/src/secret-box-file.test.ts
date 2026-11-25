import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { KeyProtector } from "./services/dpapi.ts";
import { KEY_FILE_NAME, MASTER_KEY_DIR_ENV, MASTER_KEY_ENV, defaultKeyFile, defaultKeyProvider, fileKeyProvider, generateMasterKey, pruneKeyFile, rotateKeyFile } from "./services/secret-box.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const tmpFiles = (dir: string) => readdirSync(dir).filter((n) => n.endsWith(".tmp"));
const fake: KeyProtector = {
  name: "sahte",
  protect: (s) => Buffer.from(s).toString("base64").split("").reverse().join(""),
  unprotect: (s) => Buffer.from(s.split("").reverse().join(""), "base64").toString("utf8"),
};
const plain = { protector: null };

let dir: string;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
const tmp = () => (dir = mkdtempSync(path.join(os.tmpdir(), "anahtar-dosya-")));

describe("sarılmış içerik yazılmadan önce doğrulanır", () => {
  it("geri açılan içerik bellektekiyle tutmazsa yazılmaz, eski dosya kalır, geçici dosya kalmaz", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    await fileKeyProvider(file, { protector: fake }).create!();
    rotateKeyFile(file, { protector: fake }); // temizlikte silinecek eski anahtar olsun
    const before = sha(file);
    // Bozuk koruyucu: sarar ama geri açınca başka anahtar çıkar (ör. DPAPI'nin sessizce yanlış çıktı vermesi).
    const other = generateMasterKey().key.toString("base64");
    const liar: KeyProtector = { ...fake, protect: (s) => fake.protect(s.replace(/"key":"[^"]+"/, `"key":"${other}"`)) };
    expect(() => rotateKeyFile(file, { protector: liar })).toThrow(/doğrulanamadı/);
    expect(sha(file)).toBe(before);
    expect(() => pruneKeyFile(file, new Set(), { protector: { ...fake, protect: () => "bozuk" } })).toThrow(/doğrulanamadı/);
    expect(sha(file)).toBe(before);
    expect(tmpFiles(dir)).toEqual([]);
    // İlk üretimde de: doğrulanamayan içerik dosya olmaz.
    const file2 = path.join(dir, "ikinci.json");
    await expect(fileKeyProvider(file2, { protector: { ...fake, protect: () => "bozuk" } }).create!()).rejects.toThrow(/doğrulanamadı/);
    expect(existsSync(file2)).toBe(false);
    expect(tmpFiles(dir)).toEqual([]);
  });
});

describe("salt okuma dosyayı değiştirmez", () => {
  it("readOnly: sarılmamış dosya sarılmaz (sha aynı); uygulama yolu (readOnly değil) sarar", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    const ring = await fileKeyProvider(file, plain).create!();
    const before = sha(file);
    const ro = (await fileKeyProvider(file, { protector: fake, readOnly: true }).load())!;
    expect(ro.current.id).toBe(ring.current.id);
    expect(ro.notes).toBeUndefined();
    expect(sha(file)).toBe(before);
    expect((await defaultKeyProvider(dir, { [MASTER_KEY_DIR_ENV]: dir }, { protector: fake, readOnly: true }).load())!.current.id).toBe(ring.current.id);
    expect(sha(file)).toBe(before);
    const app = (await defaultKeyProvider(dir, { [MASTER_KEY_DIR_ENV]: dir }, { protector: fake }).load())!;
    expect(app.notes?.join(" ")).toMatch(/sarıldı/);
    expect(sha(file)).not.toBe(before);
  });

  it("betik: `ana-anahtar.mjs durum` dosyayı yazmaz; `dondur` yazar (Windows'ta DPAPI ile sarar)", async () => {
    const d = tmp();
    const file = path.join(d, KEY_FILE_NAME);
    await fileKeyProvider(file, plain).create!();
    const env: NodeJS.ProcessEnv = { ...process.env, TAGPRESS_DATA_DIR: d, [MASTER_KEY_DIR_ENV]: d, TAGPRESS_MODE: "", NODE_ENV: "" };
    delete env[MASTER_KEY_ENV];
    const run = (cmd: string) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "ana-anahtar.mjs"), cmd], { env, encoding: "utf8", timeout: 60_000 });
    const before = sha(file);
    const st = run("durum");
    expect(st.status, st.stderr).toBe(0);
    expect(st.stdout).toMatch(/Geçerli: [0-9a-f]{16}/);
    expect(sha(file)).toBe(before);
    const ro = run("dondur");
    expect(ro.status, ro.stderr).toBe(0);
    expect(sha(file)).not.toBe(before);
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (process.platform === "win32") expect(data.protection).toBe("dpapi");
    else expect(Array.isArray(data.keys)).toBe(true);
    expect(tmpFiles(d)).toEqual([]);
  }, 60_000);
});

describe("Windows dışı: anahtar dosyası veri klasörüne göre ayrı", () => {
  it("yol veri klasörünün gerçek yolunun sha256 ilk 16 hanesini taşır; iki kurulum ayrı dosya; KEY_DIR aynen", () => {
    const xdg = path.join(tmp(), "xdg");
    const a = path.join(dir, "veri-a");
    const b = path.join(dir, "veri-b");
    mkdirSync(a);
    mkdirSync(b);
    const id = (p: string) => createHash("sha256").update(realpathSync.native(p)).digest("hex").slice(0, 16);
    expect(defaultKeyFile(a, { XDG_CONFIG_HOME: xdg }, "linux")).toBe(path.join(xdg, "tagpress", id(a), KEY_FILE_NAME));
    expect(defaultKeyFile(b, { XDG_CONFIG_HOME: xdg }, "linux")).not.toBe(defaultKeyFile(a, { XDG_CONFIG_HOME: xdg }, "linux"));
    expect(defaultKeyFile(a, {}, "linux")).toBe(path.join(os.homedir(), ".config", "tagpress", id(a), KEY_FILE_NAME));
    expect(defaultKeyFile(a, { [MASTER_KEY_DIR_ENV]: path.join(dir, "kd") }, "linux")).toBe(path.join(dir, "kd", KEY_FILE_NAME));
    expect(defaultKeyFile(a, {}, "win32")).toBe(path.join(a, KEY_FILE_NAME));
  });

  it("eski ortak konumdaki dosya ilk açılışta yeni konuma KOPYALANIR (silinmez, günlüğe not); salt okuma kopyalamaz ama okur", async () => {
    const xdg = path.join(tmp(), "xdg");
    const data = path.join(dir, "veri");
    mkdirSync(data);
    const shared = path.join(xdg, "tagpress", KEY_FILE_NAME);
    const ring = await fileKeyProvider(shared, plain).create!();
    const env = { XDG_CONFIG_HOME: xdg };
    const target = defaultKeyFile(data, env, "linux");
    const ro = (await defaultKeyProvider(data, env, { protector: null, readOnly: true, platform: "linux" }).load())!;
    expect(ro.current.id).toBe(ring.current.id);
    expect(existsSync(target)).toBe(false);
    const first = (await defaultKeyProvider(data, env, { protector: null, platform: "linux" }).load())!;
    expect(first.current.id).toBe(ring.current.id);
    expect(first.notes?.join(" ")).toMatch(/kopyalandı/);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(shared)).toBe(true);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    const second = (await defaultKeyProvider(data, env, { protector: null, platform: "linux" }).load())!;
    expect(second.notes).toBeUndefined();
    // KEY_DIR verilince eski ortak konuma bakılmaz.
    const kd = path.join(dir, "kd");
    expect(await defaultKeyProvider(data, { ...env, [MASTER_KEY_DIR_ENV]: kd }, { protector: null, platform: "linux" }).load()).toBeNull();
  });
});

describe("açılamayan dosya: çıkış adımları; ortam değişkeni varken açılış durmaz", () => {
  it("DPAPI (koruyucu) açamazsa mesaj çıkış adımlarını söyler", async () => {
    const file = path.join(tmp(), KEY_FILE_NAME);
    await fileKeyProvider(file, { protector: fake }).create!();
    for (const p of [{ protector: null }, { protector: { ...fake, unprotect: () => "bozuk" } }]) {
      const err = await fileKeyProvider(file, p).load().catch((e: Error) => e);
      expect(err).toMatchObject({ code: "master-key-invalid" });
      expect((err as Error).message).toMatch(/kaldırın/);
      expect((err as Error).message).toMatch(/yeniden girin/);
    }
  });

  it("TAGPRESS_SECRET_KEY geçerliyken eski dosya açılamazsa uyarı notuyla devam edilir", async () => {
    const d = tmp();
    const file = path.join(d, KEY_FILE_NAME);
    await fileKeyProvider(file, { protector: fake }).create!();
    const k = generateMasterKey();
    const env = { [MASTER_KEY_ENV]: k.key.toString("base64") };
    for (const content of [null, "{bozuk"]) {
      if (content) writeFileSync(file, content);
      const ring = (await defaultKeyProvider(d, env, { file, protector: null }).load())!;
      expect(ring.current.id).toBe(k.id);
      expect(ring.previous).toEqual([]);
      expect(ring.notes?.join(" ")).toMatch(/açılamadı/);
    }
  });
});
