/**
 * Günlük süzgeci: geçidin günlüğüne yazılan her satır buradan geçer (pino `hooks.streamWrite`). İki kat:
 * 1. Bilinen gizli değerler: süreçte açılmış ya da girilmiş sağlayıcı anahtarları ve araç jetonları (`registerSecret`).
 *    Düz ve JSON kaçışlı biçimiyle aranır.
 * 2. Sağlayıcı anahtarı biçimleri (Anthropic `sk-ant-…`, Google `AIza…`): henüz kayda girmemiş bir anahtar da düşmesin.
 * Asıl kural yazmamaktır (istek gövdesi, başlıklar ve sağlayıcı hata gövdesi hiç günlüğe gitmez); bu süzgeç ikinci kattır.
 */

const MASK = '[gizli]';
/** Kısa değer kaydedilmez: sıradan metni bozardı. */
const MIN_SECRET_LENGTH = 12;
const MAX_SECRETS = 64;

const PATTERNS = [/sk-ant-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{20,}/g];

const secrets = new Map<string, string[]>();

function variants(secret: string): string[] {
  const json = JSON.stringify(secret).slice(1, -1);
  return json === secret ? [secret] : [secret, json];
}

/** Değeri süzgece ekler (en çok `MAX_SECRETS`; en eskisi düşer). */
export function registerSecret(secret: string | null | undefined): void {
  if (!secret || secret.length < MIN_SECRET_LENGTH) return;
  secrets.delete(secret);
  secrets.set(secret, variants(secret));
  while (secrets.size > MAX_SECRETS) secrets.delete(secrets.keys().next().value as string);
}

export function scrubSecrets(text: string): string {
  let out = text;
  for (const list of secrets.values()) {
    for (const s of list) if (out.includes(s)) out = out.split(s).join(MASK);
  }
  for (const re of PATTERNS) out = out.replace(re, MASK);
  return out;
}

/** Yalnız test: süzgeci boşaltır. */
export function resetSecretsForTest(): void {
  secrets.clear();
}
