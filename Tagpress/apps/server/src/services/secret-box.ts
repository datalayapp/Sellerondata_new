/**
 * Gizli değerlerin (API anahtarları) diskte şifrelenmesi: AES-256-GCM, her platformda aynı.
 *
 * Ana anahtar (32 bayt) şu sırayla aranır (`defaultKeyProvider`):
 * 1. `TAGPRESS_SECRET_KEY` ortam değişkeni (base64). Sunucu kurulumunun yolu: gizli anahtar yönetimi (systemd
 *    `EnvironmentFile`, Docker/K8s gizlisi, kasa aracı) değeri sürece verir; diske yazılmaz. Döndürmede eski anahtarlar
 *    bir açılış boyunca `TAGPRESS_SECRET_KEY_OLD` içinde (virgülle) verilir.
 *    Tanımlı ama boşsa açılış durur. Değişken verilmişken anahtar dosyası da varsa dosyadaki anahtarlar bir açılış
 *    boyunca eski anahtar olarak yüklenir (dosyadan ortama geçiş; sunucu kipinde de, günlüğe yazılır).
 * 2. Sunucu kipinde (`TAGPRESS_MODE=server` ya da `NODE_ENV=production`) başka kaynak yoktur: değişken zorunlu.
 * 3. Yerelde `ana-anahtar.json` (`defaultKeyFile`): Windows'ta veri klasöründe ve içeriği DPAPI ile sarılı (veri
 *    klasörünün kopyası tek başına anahtarları açmaz); öteki sistemlerde veri klasörü DIŞINDA
 *    (`$XDG_CONFIG_HOME/tagpress`, yoksa `~/.config/tagpress`; `TAGPRESS_SECRET_KEY_DIR` ile değişir), izni 600 ve
 *    daha açık izinli dosya reddedilir (ssh gibi). Yoksa ilk açılışta üretilir.
 * Ana anahtar yoksa ya da bozuksa düz metne DÜŞÜLMEZ: açık hata (`SecretKeyError`).
 *
 * 2. aşamada başka bir kaynak (ör. bulut anahtar yönetimi) `MasterKeyProvider` uygulanarak bağlanır.
 *
 * Bu dosya yalnız Node yerleşiklerini kullanır ve silinebilir TS sözdizimiyle yazılır: `scripts/*.mjs` betikleri onu
 * doğrudan (`node`, derlemesiz) içe aktarır.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, constants, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { type KeyProtector, defaultKeyProtector } from "./dpapi.ts";

/** Şifreli kaydın biçimi. Değer: base64(iv 12 bayt | etiket 16 bayt | şifreli metin). */
export const SEALED_FORMAT = "aes-256-gcm/v1";
export const KEY_FILE_FORMAT = "tagpress-ana-anahtar/v1";
export const KEY_FILE_NAME = "ana-anahtar.json";
export const MASTER_KEY_ENV = "TAGPRESS_SECRET_KEY";
export const MASTER_KEY_OLD_ENV = "TAGPRESS_SECRET_KEY_OLD";
export const MASTER_KEY_DIR_ENV = "TAGPRESS_SECRET_KEY_DIR";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const GENERATE_HINT = `Üretmek için: node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`;

export type SecretKeyErrorCode =
  /** Ortamdaki ya da dosyadaki ana anahtar okunamıyor (biçim, uzunluk, bozuk dosya). */
  | "master-key-invalid"
  /** Anahtar dosyası başkalarınca okunabilir (Windows dışı). */
  | "master-key-permissions"
  /** Şifreli kayıt var ama ana anahtar yok. */
  | "master-key-missing"
  /** Kayıt, eldeki ana anahtarlardan biriyle şifrelenmemiş (yanlış anahtar). */
  | "master-key-mismatch"
  /** Kayıt doğrulanamadı (bozuk ya da değiştirilmiş). */
  | "secret-corrupt";

/** Ana anahtar ya da şifreli kayıt sorunu. Mesajda ASLA anahtar ya da gizli değer bulunmaz. */
export class SecretKeyError extends Error {
  readonly code: SecretKeyErrorCode;
  constructor(code: SecretKeyErrorCode, message: string) {
    super(message);
    this.name = "SecretKeyError";
    this.code = code;
  }
}

export interface MasterKey {
  /** Anahtardan türetilen kısa kimlik (kayıtta durur; anahtarı açığa vurmaz). */
  readonly id: string;
  readonly key: Buffer;
}

/** Geçerli anahtar (yeni kayıtlar) + döndürmeden kalan eski anahtarlar (yalnız çözmek için). */
export interface KeyRing {
  readonly current: MasterKey;
  readonly previous: readonly MasterKey[];
  /** Yükleme sırasında olanlar (günlük için; değer içermez): dosya sarıldı, dosyadan ortama geçiş… */
  readonly notes?: readonly string[];
}

export interface Sealed {
  format: typeof SEALED_FORMAT;
  kid: string;
  value: string;
}

/** Ana anahtarın kaynağı. */
export interface MasterKeyProvider {
  /** Sunucu günlüğünde gösterilecek kaynak adı (değer değil; disk yolu olabilir). */
  readonly description: string;
  /** İstemciye giden yanıtlarda kullanılan ad: disk yolu İÇERMEZ. */
  readonly label: string;
  /** Anahtar halkası; kaynakta anahtar yoksa null. Kaynak bozuksa `SecretKeyError` fırlatır. */
  load(): Promise<KeyRing | null>;
  /** İlk kurulumda yeni anahtar üretip saklar. Yalnız okunur kaynaklarda (ortam, gizli yönetimi) yoktur. */
  create?(): Promise<KeyRing>;
}

export function keyId(key: Buffer): string {
  return createHash("sha256").update("tagpress-ana-anahtar-kimligi\0").update(key).digest("hex").slice(0, 16);
}

function masterKey(key: Buffer): MasterKey {
  return { id: keyId(key), key };
}

export function generateMasterKey(): MasterKey {
  return masterKey(randomBytes(KEY_BYTES));
}

/** base64 32 bayt; değilse hata (değer mesaja yazılmaz). */
export function parseMasterKey(text: string, where: string): MasterKey {
  const t = text.trim();
  const buf = /^[A-Za-z0-9+/]+={0,2}$/.test(t) ? Buffer.from(t, "base64") : Buffer.alloc(0);
  if (buf.length !== KEY_BYTES) {
    throw new SecretKeyError("master-key-invalid", `${where}: ana anahtar base64 biçiminde 32 bayt olmalı. ${GENERATE_HINT}`);
  }
  return masterKey(buf);
}

export function keyRing(current: MasterKey, previous: readonly MasterKey[] = [], notes?: readonly string[]): KeyRing {
  const seen = new Set([current.id]);
  const prev = previous.filter((k) => !seen.has(k.id) && !!seen.add(k.id));
  return { current, previous: prev, ...(notes?.length ? { notes } : {}) };
}

function findKey(ring: KeyRing, kid: string): MasterKey | undefined {
  return ring.current.id === kid ? ring.current : ring.previous.find((k) => k.id === kid);
}

/** Şifreler. `context` (ör. "tagpress:key:anthropic") doğrulanan ek veridir: kayıt başka bir yere taşınırsa çözülmez. */
export function seal(ring: KeyRing, plain: string, context: string): Sealed {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", ring.current.key, iv);
  c.setAAD(Buffer.from(context, "utf8"));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { format: SEALED_FORMAT, kid: ring.current.id, value: Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64") };
}

/** Çözer. Anahtar halkasında kaydın anahtarı yoksa ya da kayıt doğrulanamazsa `SecretKeyError`. */
export function open(ring: KeyRing, sealed: Sealed, context: string): string {
  if (sealed.format !== SEALED_FORMAT) throw new SecretKeyError("secret-corrupt", `Bilinmeyen şifreleme biçimi: ${String(sealed.format)}.`);
  const k = findKey(ring, sealed.kid);
  if (!k) throw new SecretKeyError("master-key-mismatch", "Kayıt başka bir ana anahtarla şifrelenmiş (ana anahtar değişmiş ya da yanlış).");
  const buf = Buffer.from(String(sealed.value), "base64");
  if (buf.length < IV_BYTES + TAG_BYTES) throw new SecretKeyError("secret-corrupt", "Şifreli kayıt bozuk.");
  try {
    const d = createDecipheriv("aes-256-gcm", k.key, buf.subarray(0, IV_BYTES));
    d.setAAD(Buffer.from(context, "utf8"));
    d.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([d.update(buf.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString("utf8");
  } catch {
    throw new SecretKeyError("secret-corrupt", "Şifreli kayıt doğrulanamadı (bozuk ya da değiştirilmiş).");
  }
}

export function isSealed(v: unknown): v is Sealed {
  const o = v as Partial<Sealed> | null;
  return !!o && typeof o === "object" && o.format === SEALED_FORMAT && typeof o.kid === "string" && typeof o.value === "string";
}

// ---------------------------------------------------------------- kaynaklar

/** Sunucu kipi: anahtar dosyası okunmaz, `TAGPRESS_SECRET_KEY` zorunludur. */
export function isServerMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TAGPRESS_MODE === "server" || env.NODE_ENV === "production";
}

const ENV_LABEL = `ortam değişkeni ${MASTER_KEY_ENV}`;

/**
 * `TAGPRESS_SECRET_KEY` (+ döndürmede `TAGPRESS_SECRET_KEY_OLD`). Değişken tanımlı değilse null. Tanımlı ama boşsa
 * (ya da eski anahtar listesinde boş değer varsa) `load` açık hata verir: açılış durur.
 */
export function envKeyProvider(env: NodeJS.ProcessEnv = process.env): MasterKeyProvider | null {
  const raw = env[MASTER_KEY_ENV];
  if (raw === undefined) return null;
  return {
    description: ENV_LABEL,
    label: ENV_LABEL,
    load: async () => {
      if (!raw.trim()) throw new SecretKeyError("master-key-invalid", `${MASTER_KEY_ENV} tanımlı ama boş. ${GENERATE_HINT}`);
      const current = parseMasterKey(raw, MASTER_KEY_ENV);
      const oldRaw = env[MASTER_KEY_OLD_ENV];
      const old: MasterKey[] = [];
      if (oldRaw !== undefined) {
        const parts = oldRaw.split(",").map((s) => s.trim());
        if (parts.some((s) => !s)) throw new SecretKeyError("master-key-invalid", `${MASTER_KEY_OLD_ENV} tanımlı ama boş ya da boş değer içeriyor (değerler virgülle ayrılır).`);
        parts.forEach((s, i) => old.push(parseMasterKey(s, `${MASTER_KEY_OLD_ENV} (${i + 1}. değer)`)));
      }
      return keyRing(current, old);
    },
  };
}

interface KeyEntry {
  id: string;
  key: string;
  createdAt: string;
}

/** Dosya biçimi. `protection` varsa `keys` koruyucuyla (DPAPI) sarılmış JSON metnidir. */
interface KeyFile {
  format: typeof KEY_FILE_FORMAT;
  protection?: string;
  /** İlki geçerli anahtardır; gerisi döndürmeden kalan eski anahtarlar. */
  keys: KeyEntry[] | string;
}

export interface KeyFileOptions {
  /** Dosya içeriğinin koruyucusu. Varsayılan: Windows'ta DPAPI, başka yerde yok. */
  protector?: KeyProtector | null;
  /**
   * Salt okuma (`ana-anahtar.mjs durum`, aktarım betikleri): dosya hiç yazılmaz; sarılmamış dosya sarılmaz, eski ortak
   * konumdaki dosya kopyalanmaz, yeni anahtar üretilmez. Uygulama açılışı ve yazan komutlar bunu vermez.
   */
  readOnly?: boolean;
}

/** DPAPI/koruyucu dosyayı açamadığında kullanıcının yapacakları (kaybedilen yalnız yeniden girilebilir API anahtarları). */
const EXIT_STEPS =
  "Çıkış: bu dosyayı kaldırın (kenara alın); uygulamayı açın, Ayarlar → Bağlantılar'da çözülemeyen API anahtarlarını silin ve uygulamayı yeniden başlatın (yeni ana anahtar üretilir); sonra API anahtarlarını yeniden girin. Kaybedilen yalnız yeniden girilebilen API anahtarlarıdır.";

const isPosix = () => process.platform !== "win32";
const protectorOf = (o: KeyFileOptions) => (o.protector === undefined ? defaultKeyProtector() : o.protector);

/** Dosyayı okur: anahtar girdileri ve dosyanın sarılı olup olmadığı. */
function readKeyFile(file: string, protector: KeyProtector | null): { keys: KeyEntry[]; wrapped: boolean } {
  if (isPosix() && (statSync(file).mode & 0o077) !== 0) {
    throw new SecretKeyError("master-key-permissions", `${file}: ana anahtar dosyası başkalarınca okunabilir. Düzeltmek için: chmod 600 "${file}"`);
  }
  let data: KeyFile;
  try {
    data = JSON.parse(readFileSync(file, "utf8")) as KeyFile;
  } catch {
    throw new SecretKeyError("master-key-invalid", `${file}: ana anahtar dosyası okunamıyor (bozuk). Yedekten geri koyun.`);
  }
  if (data?.format !== KEY_FILE_FORMAT) throw new SecretKeyError("master-key-invalid", `${file}: ana anahtar dosyasının biçimi tanınmıyor. Yedekten geri koyun.`);
  let keys: unknown = data.keys;
  if (data.protection !== undefined) {
    if (!protector || protector.name !== data.protection || typeof data.keys !== "string") {
      throw new SecretKeyError("master-key-invalid", `${file}: ana anahtar dosyası ${String(data.protection)} ile sarılı; yalnız onu oluşturan Windows kullanıcısında açılır. ${EXIT_STEPS}`);
    }
    try {
      keys = JSON.parse(protector.unprotect(data.keys));
    } catch {
      throw new SecretKeyError("master-key-invalid", `${file}: ana anahtar dosyası açılamadı (${protector.name}; başka bir Windows hesabında ya da başka bir kurulumda oluşturulmuş olabilir). ${EXIT_STEPS}`);
    }
  }
  if (!Array.isArray(keys) || keys.length === 0) throw new SecretKeyError("master-key-invalid", `${file}: ana anahtar dosyasında anahtar yok. Yedekten geri koyun.`);
  for (const [i, k] of (keys as KeyEntry[]).entries()) {
    const parsed = parseMasterKey(String(k?.key ?? ""), `${file} (${i + 1}. anahtar)`);
    if (k.id !== parsed.id) throw new SecretKeyError("master-key-invalid", `${file}: ${i + 1}. anahtarın kimliği tutmuyor (dosya bozuk).`);
  }
  return { keys: keys as KeyEntry[], wrapped: data.protection !== undefined };
}

function ringOf(keys: KeyEntry[], notes?: string[]): KeyRing {
  const list = keys.map((k) => masterKey(Buffer.from(k.key, "base64")));
  return keyRing(list[0]!, list.slice(1), notes);
}

function fileEntry(k: MasterKey, now: Date): KeyEntry {
  return { id: k.id, key: k.key.toString("base64"), createdAt: now.toISOString() };
}

function tempPath(file: string): string {
  return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
}

/**
 * Geçici dosyaya yazar (600; koruyucu varsa içerik sarılır) ve yolunu döner. Yazılan dosya geri okunup (sarılıysa geri
 * açılıp) bellekteki anahtarlarla karşılaştırılır; tutmazsa geçici dosya silinir ve açık hata: asıl dosyaya dokunulmaz.
 */
function writeTemp(file: string, keys: KeyEntry[], protector: KeyProtector | null): string {
  const data: KeyFile = protector
    ? { format: KEY_FILE_FORMAT, protection: protector.name, keys: protector.protect(JSON.stringify(keys)) }
    : { format: KEY_FILE_FORMAT, keys };
  const tmp = tempPath(file);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  let same = false;
  try {
    same = JSON.stringify(readKeyFile(tmp, protector).keys) === JSON.stringify(keys);
  } catch {
    same = false;
  }
  if (!same) {
    unlinkSync(tmp);
    throw new SecretKeyError("master-key-invalid", `${file}: ana anahtar dosyası yazılmadan önce doğrulanamadı (yazılan içerik geri açılınca tutmadı); dosya değiştirilmedi.`);
  }
  return tmp;
}

/** Var olan dosyanın yerine atomik yazar; taşıma düşerse geçici dosya silinir. */
function replaceKeyFile(file: string, keys: KeyEntry[], protector: KeyProtector | null): void {
  const tmp = writeTemp(file, keys, protector);
  try {
    renameSync(tmp, file);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

/**
 * Anahtar dosyası. `create` var olan dosyanın üstüne ASLA yazmaz (yarışta kazananınki okunur). Koruyucu varken
 * sarılmamış dosya bulunursa (yalnız kopya veride olur) uygulama açılışında sarılır; `readOnly` ise dosyaya dokunulmaz.
 */
export function fileKeyProvider(file: string, opts: KeyFileOptions = {}): MasterKeyProvider {
  const protector = protectorOf(opts);
  const load = (): KeyRing => {
    const { keys, wrapped } = readKeyFile(file, protector);
    if (protector && !wrapped && !opts.readOnly) {
      replaceKeyFile(file, keys, protector);
      return ringOf(keys, [`Ana anahtar dosyası ${protector.name} ile sarıldı: ${file}`]);
    }
    return ringOf(keys);
  };
  return {
    description: `dosya ${file}`,
    label: `ana anahtar dosyası (${KEY_FILE_NAME})`,
    load: async () => (existsSync(file) ? load() : null),
    ...(opts.readOnly ? {} : { create: async () => {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const k = generateMasterKey();
      const tmp = writeTemp(file, [fileEntry(k, new Date())], protector);
      try {
        try {
          linkSync(tmp, file); // atomik ve dışlayıcı: dosya varsa EEXIST
        } catch (err) {
          // Sabit bağlantı desteklenmiyorsa (FAT, bazı ağ sürücüleri) dışlayıcı kopya.
          if (!["EPERM", "ENOTSUP", "ENOSYS", "EXDEV"].includes(String((err as NodeJS.ErrnoException).code))) throw err;
          copyFileSync(tmp, file, constants.COPYFILE_EXCL);
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      } finally {
        unlinkSync(tmp);
      }
      return load();
    } }),
  };
}

const configRoot = (env: NodeJS.ProcessEnv) => path.join(env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config"), "tagpress");

/** Veri klasörünün kimliği: gerçek yolunun sha256'sının ilk 16 hanesi (klasör yoksa çözülmüş yol). */
export function dataDirId(dataDir: string): string {
  const real = existsSync(dataDir) ? realpathSync.native(dataDir) : path.resolve(dataDir);
  return createHash("sha256").update(real).digest("hex").slice(0, 16);
}

/**
 * Yerel anahtar dosyasının yeri: `TAGPRESS_SECRET_KEY_DIR` (aynen), yoksa Windows'ta veri klasörü (içerik DPAPI ile
 * sarılı), öteki sistemlerde veri klasörü dışında ve kuruluma göre ayrı:
 * `$XDG_CONFIG_HOME/tagpress/<dataDirId>/` ya da `~/.config/tagpress/<dataDirId>/` (bir kurulumun `temizle`'si
 * öbürünün anahtarını silemesin).
 */
export function defaultKeyFile(dataDir: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const dir = env[MASTER_KEY_DIR_ENV]?.trim();
  if (dir) return path.join(path.resolve(dir), KEY_FILE_NAME);
  if (platform === "win32") return path.join(dataDir, KEY_FILE_NAME);
  return path.join(configRoot(env), dataDirId(dataDir), KEY_FILE_NAME);
}

/** Önceki sürümün bütün kurulumlarca paylaşılan konumu (Windows dışı, `TAGPRESS_SECRET_KEY_DIR` yokken). */
function legacySharedKeyFile(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | null {
  if (env[MASTER_KEY_DIR_ENV]?.trim() || platform === "win32") return null;
  return path.join(configRoot(env), KEY_FILE_NAME);
}

/**
 * Yerel dosya kaynağı + eski ortak konumdan geçiş: yeni konumda dosya yoksa ve eski ortak konumda varsa, uygulama
 * açılışında yeni konuma KOPYALANIR (eskisi silinmez; başka kurulumlar da kullanıyor olabilir) ve not düşülür.
 * Salt okumada kopyalanmaz, eski dosyadan okunur.
 */
function localKeyProvider(file: string, legacy: string | null, opts: KeyFileOptions): MasterKeyProvider {
  const base = fileKeyProvider(file, opts);
  if (!legacy) return base;
  return {
    ...base,
    load: async () => {
      if (existsSync(file) || !existsSync(legacy)) return base.load();
      if (opts.readOnly) return fileKeyProvider(legacy, opts).load();
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      try {
        copyFileSync(legacy, file, constants.COPYFILE_EXCL);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      chmodSync(file, 0o600);
      const ring = (await base.load())!;
      return keyRing(ring.current, ring.previous, [
        ...(ring.notes ?? []),
        `Eski ortak konumdaki ana anahtar dosyası bu kuruluma kopyalandı: ${legacy} → ${file} (eski dosya silinmedi; başka kurulum kullanmıyorsa kaldırılabilir).`,
      ]);
    },
  };
}

/**
 * Varsayılan kaynak: ortam değişkeni (dosya da varsa onun anahtarları bir açılış boyunca eski anahtar olur), yoksa
 * sunucu kipinde açık hata, yoksa yerel anahtar dosyası.
 */
export function defaultKeyProvider(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: KeyFileOptions & { file?: string; platform?: NodeJS.Platform } = {},
): MasterKeyProvider {
  const platform = opts.platform ?? process.platform;
  const file = opts.file ?? defaultKeyFile(dataDir, env, platform);
  const local = localKeyProvider(file, opts.file ? null : legacySharedKeyFile(env, platform), opts);
  const fromEnv = envKeyProvider(env);
  if (fromEnv) {
    return {
      description: fromEnv.description,
      label: fromEnv.label,
      load: async () => {
        const ring = (await fromEnv.load())!;
        let old: KeyRing | null;
        try {
          old = await local.load();
        } catch (err) {
          // Ortam değişkeni geçerli: eski dosya açılamıyor diye açılış durmaz (o dosyayla şifreli kayıtlar kayıt bazında uyarı verir).
          return keyRing(ring.current, ring.previous, [`Eski ana anahtar dosyası açılamadı, yok sayıldı (${file}): ${err instanceof Error ? err.message : String(err)}`]);
        }
        if (!old) return ring;
        return keyRing(ring.current, [...ring.previous, old.current, ...old.previous], [
          ...(old.notes ?? []),
          `${MASTER_KEY_ENV} verildi ama ana anahtar dosyası da var (${file}): dosyadaki anahtarlar bu açılışta eski anahtar olarak yüklendi, kayıtlar yeni anahtarla yeniden şifrelenir. Ardından dosyayı kaldırın.`,
        ]);
      },
    };
  }
  if (isServerMode(env)) {
    const label = `${ENV_LABEL} (sunucu kipi)`;
    return {
      description: label,
      label,
      load: async () => {
        throw new SecretKeyError("master-key-missing", `Sunucu kipinde (TAGPRESS_MODE=server ya da NODE_ENV=production) ${MASTER_KEY_ENV} zorunlu; anahtar dosyası okunmaz. ${GENERATE_HINT}`);
      },
    };
  }
  return local;
}

/**
 * Döndürme (dosya kaynağı): yeni anahtar geçerli olur, eskiler çözmek için dosyada kalır. Uygulama sonraki açılışta
 * kayıtları yeni anahtarla yeniden şifreler; ardından `pruneKeyFile` ile eskiler silinebilir.
 */
export function rotateKeyFile(file: string, opts: KeyFileOptions = {}): { current: string; previous: string[] } {
  const protector = protectorOf(opts);
  const { keys } = readKeyFile(file, protector);
  const k = generateMasterKey();
  replaceKeyFile(file, [fileEntry(k, new Date()), ...keys], protector);
  return { current: k.id, previous: keys.map((e) => e.id) };
}

/** Geçerli anahtar dışındaki, `inUse` içinde olmayan eski anahtarları siler. Silinen kimlikleri döner. */
export function pruneKeyFile(file: string, inUse: ReadonlySet<string>, opts: KeyFileOptions = {}): string[] {
  const protector = protectorOf(opts);
  const { keys } = readKeyFile(file, protector);
  const [current, ...rest] = keys;
  const keep = rest.filter((e) => inUse.has(e.id));
  const removed = rest.filter((e) => !inUse.has(e.id)).map((e) => e.id);
  if (removed.length) replaceKeyFile(file, [current!, ...keep], protector);
  return removed;
}
