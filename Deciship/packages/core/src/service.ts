/**
 * Hizmet adı karşılaştırması (KARARLAR "Karışık hizmet"): faturadaki satırın hizmeti tarifedeki hizmetten farklıysa o satırın
 * fiyat farkı kesin sayılmaz. Adlar serbest metindir ("FedEx Intl Priority", "International Economy", "Ekspres"); bu
 * yüzden yalnız hizmet sınıfını belirten sözcüklere bakılır. İki adın da en az bir sınıf sözcüğü varsa ve kümeler
 * farklıysa "farklı hizmet" denir. Sınıf sözcüğü taşımayan ad hakkında hüküm verilmez (farklı sayılmaz): yanlış alarm,
 * kaçan uyarıdan pahalıdır, çünkü farklı sayılan satır "İncele"ye düşer ve gerçek fark Fazla ödeme'den çıkar.
 *
 * İki tür sözcük vardır: ana sınıf (priority, economy, express…) ve niteleyici (saver, select, plus). Kurallar:
 * - "Express" başka bir ana sınıfla birlikteyse marka adıdır ("TNT Express Economy", "FedEx Express International
 *   Priority"), sınıf sayılmaz.
 * - İki adın ana sınıfı da varsa ve farklıysa: farklı hizmet.
 * - Ana sınıflar aynıysa ya da bir tarafta yoksa niteleyiciye bakılır: iki tarafta da niteleyici var ve ortak yoksa farklı;
 *   bir tarafta niteleyici yoksa hüküm verilmez ("UPS Saver" = "UPS Express Saver", "DHL Economy" = "DHL Economy Select").
 */

const CLASS_WORDS: Record<string, string> = {
  priority: 'priority',
  oncelikli: 'priority',
  economy: 'economy',
  ekonomi: 'economy',
  ekonomik: 'economy',
  eko: 'economy',
  express: 'express',
  ekspres: 'express',
  expres: 'express',
  standard: 'standard',
  standart: 'standard',
  saver: 'saver',
  plus: 'plus',
  expedited: 'expedited',
  first: 'first',
  ground: 'ground',
  connect: 'connect',
  select: 'select',
  freight: 'freight',
};

/**
 * Taşıyıcıların hizmet kısaltmaları (DENETIM-2 B1; tarife ekranındaki örnek "IE, IP, Standart…" bunları öneriyor): FedEx
 * IP/IE (International Priority/Economy), IPF/IEF (… Freight), DHL WPX/DOX (Express Worldwide paket/doküman).
 */
const ABBREVIATIONS: Record<string, readonly string[]> = {
  ip: ['priority'],
  ie: ['economy'],
  ipf: ['priority', 'freight'],
  ief: ['economy', 'freight'],
  wpx: ['express'],
  dox: ['express'],
};

const fold = (s: string) =>
  s
    .replace(/İ/g, 'i')
    .replace(/I/g, 'ı')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Hizmet adındaki sınıf sözcükleri, sıralı ve tekil ("FedEx Intl Priority Express" → ["express", "priority"]). */
export function serviceClassWords(service: string | null | undefined): string[] {
  if (!service) return [];
  const out = new Set<string>();
  for (const w of fold(service).split(/[^a-z0-9]+/)) {
    // kendi anahtarı olmayan sözcük ("constructor" gibi nesne özellikleri) sınıf sayılmaz
    if (Object.prototype.hasOwnProperty.call(CLASS_WORDS, w)) out.add(CLASS_WORDS[w]!);
    if (Object.prototype.hasOwnProperty.call(ABBREVIATIONS, w)) for (const a of ABBREVIATIONS[w]!) out.add(a);
  }
  return [...out].sort();
}

/** Satırın hizmeti tarifedeki hizmetten kesin olarak farklı mı? Biri boşsa ya da sınıf sözcüğü taşımıyorsa hayır. */
const MODIFIERS = new Set(['saver', 'select', 'plus']);

function split(service: string | null | undefined): { main: string[]; mod: string[] } {
  const words = serviceClassWords(service);
  let main = words.filter((w) => !MODIFIERS.has(w));
  if (main.length > 1) main = main.filter((w) => w !== 'express');
  return { main, mod: words.filter((w) => MODIFIERS.has(w)) };
}

export function serviceMismatch(lineService: string | null | undefined, tariffService: string | null | undefined): boolean {
  const a = split(lineService);
  const b = split(tariffService);
  if (a.main.length && b.main.length && a.main.join('|') !== b.main.join('|')) return true;
  if (a.mod.length && b.mod.length && !a.mod.some((w) => b.mod.includes(w))) return true;
  return false;
}
