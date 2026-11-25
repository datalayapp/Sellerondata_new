/**
 * Windows DPAPI (kullanıcı hesabına bağlı şifreleme), iki iş için:
 * - Windows'ta ana anahtar dosyasının içeriğini sarmak (`secret-box.ts`): `data/` kopyası tek başına anahtarları açmaz.
 * - Eski biçimde (DPAPI ile) saklanmış API anahtarlarını TAŞIMAK için okumak (`SecretService.init`, `anahtar-yukle.mjs`).
 * Windows dışında yoktur. Yalnız Node yerleşiklerini kullanır: betikler doğrudan içe aktarır.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export type LegacyDecrypt = (stored: string) => string;

/** Ana anahtar dosyasını saran koruyucu (Windows'ta DPAPI; testlerde sahte). */
export interface KeyProtector {
  /** Gösterilecek ad ("dpapi"). Dosyada `protection` alanına yazılır. */
  readonly name: string;
  protect(plain: string): string;
  unprotect(stored: string): string;
}

/** `powershell.exe` tam yolu: PATH'teki aynı adlı bir dosya çalıştırılmaz. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const PS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const PS_PRELUDE = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s = [Console]::In.ReadToEnd();";

/** Gizli değer komut satırına değil, standart girdiye verilir (süreç listesinde görünmez). */
function powershell(script: string, input: string): string {
  try {
    return execFileSync(powershellPath(), [...PS, `${PS_PRELUDE} ${script}`], { input, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  } catch {
    // Hata nesnesi standart girdiyi ve çıktıyı taşıyabilir: günlüğe yalnız genel mesaj gider.
    throw new Error("DPAPI kaydı çözülemedi (başka bir Windows kullanıcısında şifrelenmiş olabilir).");
  }
}

const UNPROTECT =
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($s.Trim()), $null, 'CurrentUser')))";
const PROTECT = "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($s), $null, 'CurrentUser')))";

export const dpapiDecrypt: LegacyDecrypt = (stored) => powershell(UNPROTECT, stored).trim();
export const dpapiEncrypt = (plain: string): string => powershell(PROTECT, plain).trim();

export const dpapiProtector: KeyProtector = { name: "dpapi", protect: dpapiEncrypt, unprotect: dpapiDecrypt };

const isWindows = () => process.platform === "win32";

/** Bu platformda eski DPAPI kayıtları çözülebiliyor mu: Windows'ta çözücü, başka yerde null. */
export function legacyDpapi(): LegacyDecrypt | null {
  return isWindows() ? dpapiDecrypt : null;
}

/** Ana anahtar dosyasının koruyucusu: Windows'ta DPAPI, başka yerde yok (dosya veri klasörü dışında, izni 600). */
export function defaultKeyProtector(): KeyProtector | null {
  return isWindows() ? dpapiProtector : null;
}
