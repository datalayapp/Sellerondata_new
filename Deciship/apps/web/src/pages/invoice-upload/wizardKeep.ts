// Yükleme sihirbazı kullanıcının yaptığını sessizce kaybetmez (Mesaj 5: 10-B5, 10-B9). Saf kararlar; `test/wizard-keep.test.ts` sınar.
// Önizleme (okunan satırlar, eşleme, düzeltmeler) yeni okuma başarıyla uygulanana kadar ekranda kalır; 1. adıma dönmek
// ondan vazgeçmek değildir. Yeniden okuma yalnız dosya ya da taşıyıcı gerçekten değişince başlar, düzeltme varsa önce sorulur.

/** Dosyanın kimliği: ad, boyut ve değişme zamanı aynıysa aynı dosyadır (yeniden seçilmiş olsa da). */
export interface FileKey {
  name: string;
  size: number;
  lastModified?: number;
}

export const sameFile = (a: FileKey, b: FileKey): boolean =>
  a.name === b.name && a.size === b.size && (a.lastModified ?? 0) === (b.lastModified ?? 0);

/**
 * Ekrandaki önizlemenin okunduğu dosya ve taşıyıcı. `file: null`: sürdürme bandından açıldı, yerel dosya yok.
 * `pdf`: PDF okuması taşıyıcıya bağlı değil (okuma işinin girdisinde taşıyıcı yok): taşıyıcı değişince yeniden okunmaz.
 */
export interface PreviewSource {
  file: FileKey | null;
  carrierId: string;
  pdf?: boolean;
}

/** 1. adımda "Devam": önizleme seçili taşıyıcıyla okunmuşsa ve okuma sürmüyorsa. */
export function canContinue(src: PreviewSource | null, carrierId: string, busy: boolean): boolean {
  return src !== null && !busy && src.carrierId === carrierId;
}

/**
 * 1. adımda taşıyıcı ya da dosya seçilince ne olur.
 * - `none`: hiçbir şey değişmez (aynı taşıyıcıya tıklandı).
 * - `set`: yalnız seçim değişir, okuma yok (dosya henüz yok ya da sürdürülen önizlemenin yerel dosyası yok).
 * - `back`: seçim ekrandaki önizlemenin taşıyıcısına döndü: süren başka okuma bırakılır, önizleme "Devam" ile açılır.
 * - `retarget`: PDF önizlemesi: yalnız taşıyıcı değişir, okuma ve soru yok; önizleme yeni taşıyıcıyla "Devam" eder.
 * - `show`: aynı dosya aynı taşıyıcıyla yeniden seçildi: okumadan önizlemeye geçilir.
 * - `read`: okunur. `keepOld`: aynı dosya, eski önizleme yenisi uygulanana kadar kalır (düşerse geri gelir);
 *   değilse eski önizleme hemen bırakılır ve dosyası silinir. `ask`: düzeltme var, önce sorulur.
 */
export type PickPlan =
  | { do: "none" }
  | { do: "set" }
  | { do: "back" }
  | { do: "retarget" }
  | { do: "show" }
  | { do: "read"; keepOld: boolean; ask: boolean };

export function planCarrierPick(o: {
  picked: string;
  current: string;
  file: FileKey | null;
  src: PreviewSource | null;
  edited: boolean;
}): PickPlan {
  if (o.picked === o.current) return { do: "none" };
  if (o.src?.pdf) return { do: "retarget" };
  if (o.src && o.src.carrierId === o.picked) return { do: "back" };
  if (!o.file || !o.picked) return { do: "set" };
  const keepOld = o.src !== null && o.src.file !== null && sameFile(o.src.file, o.file);
  return { do: "read", keepOld, ask: o.src !== null && o.edited };
}

export function planFilePick(o: {
  file: FileKey;
  carrierId: string;
  src: PreviewSource | null;
  edited: boolean;
}): PickPlan {
  const same = o.src !== null && o.src.file !== null && sameFile(o.src.file, o.file);
  if (same && o.src!.carrierId === o.carrierId) return { do: "show" };
  // Taşıyıcı seçilmemişse sayfa okumayı başlatmaz (taşıyıcı seçilince başlar); karar yine aynı.
  return { do: "read", keepOld: same, ask: o.src !== null && o.edited };
}

/** Okunan hâl: satırlar (PDF, ekrandaki rastgele `key` hariç), eşleme (tablo) ve elle yazılan fatura bilgisi. */
export interface WorkState {
  rows: string;
  mapping: string;
  metaEdited: boolean;
}

export const rowsKey = (rows: readonly { key: string }[]): string =>
  JSON.stringify(rows.map(({ key: _key, ...r }) => r));

/** Okumadan sonra ekranda bir şey değişti mi (yeniden okuma bunu siler). */
export function isEdited(base: WorkState | null, cur: WorkState): boolean {
  if (!base) return false;
  return cur.metaEdited || cur.rows !== base.rows || cur.mapping !== base.mapping;
}

/**
 * Taşıyıcı değişince seçilen tarife: bırakılan taşıyıcının tarifesi hatırlanır, geri dönülünce geri gelir (A→B→A seçimi
 * sessizce sıfırlamaz). Hiç seçilmemişse "" (taşıyıcının varsayılanı önseçilir).
 */
export function switchTariff(
  memo: Readonly<Record<string, string>>,
  from: string,
  tariffId: string,
  to: string,
): { memo: Record<string, string>; tariffId: string } {
  const next = from ? { ...memo, [from]: tariffId } : { ...memo };
  return { memo: next, tariffId: next[to] ?? "" };
}

/**
 * "Yeniden oku" `fresh` ile mi gitsin. Önceki "Yeniden oku"nun işi başladı ama sonucu uygulanmadıysa (düştü, durduruldu)
 * hayır: o işin okuyup ücretlediği parçalar önbellekte en yeni kayıttır, yeni `fresh` iş onları kullanmaz (`cacheNotBefore`)
 * ve ikinci kez ücretlerdi. `retryFresh` ile aynı gerekçe; bu "Devam" ile satırlara dönüp yeniden "Yeniden oku"ya basma yolu.
 * `freshUnapplied`: `fresh` bir işin başladığı, ondan sonra hiçbir okumanın uygulanmadığı.
 */
export function rereadFresh(freshUnapplied: boolean): boolean {
  return !freshUnapplied;
}
