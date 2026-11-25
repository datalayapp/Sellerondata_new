/**
 * Grafem kümesi bilgisi (tek yer). Bir "karakter" kullanıcının gördüğü birimdir: aksanlı harf, bayrak 🇹🇷,
 * ten rengi 🙏🏽, ZWJ dizisi (aile, ateşli kuş), tuş kapağı 1️⃣ ve varyasyon seçicili ❤️ tek kümedir; satır bölme,
 * sayma, font seçimi ve çizim hep bu kümeler üzerinden yapılır (bir emoji asla ortadan bölünmez).
 * Tarayıcıda da çalışır (Node'a özgü bir şey kullanmaz).
 */

let segmenter: Intl.Segmenter | undefined;

/** Metnin grafem kümeleri (sıra korunur, birleşimleri metnin kendisidir). */
export function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

const VS15 = "\uFE0E";
const VS16 = "\uFE0F";
const ZWJ = "\u200D";
const KEYCAP = "\u20E3";

/**
 * Unicode'da varsayılanı metin olduğu hâlde kullanıcı metinlerinde emoji olarak beklenen karakterler (kullanıcı kararı
 * 2026-11-21: seçicisiz ❤ da renkli basılır). Liste bilerek küçük: ♥ ★ ✿ ☾ gibi süs sembolleri tek renk kalır.
 * Metin değişmez (seçici eklenmez); yalnız font seçimi kararıdır. Metin seçicisi (U+FE0E) yazılmışsa tek renk kalır.
 */
const EMOJI_BY_DEFAULT = new Set(["❤"]);

/**
 * Küme renkli emoji olarak mı görünmeli? Unicode sunum kuralları: metin seçicisi (U+FE0E) varsa hayır; emoji seçicisi
 * (U+FE0F), tuş kapağı, bayrak (bölge harfi çifti ya da etiket dizisi), ten rengi değiştiricisi, resimli ZWJ dizisi ya da
 * varsayılanı emoji olan karakter (😀) varsa evet. Varsayılanı metin olan sembol (♥, ★, ™) metindir; istisna `EMOJI_BY_DEFAULT` (❤).
 */
export function isEmojiGrapheme(g: string): boolean {
  if (g.includes(VS15)) return false;
  if (g.includes(VS16) || g.includes(KEYCAP)) return true;
  if (/\p{Regional_Indicator}/u.test(g) || /[\u{E0020}-\u{E007F}]/u.test(g)) return true;
  if (/\p{Emoji_Modifier}/u.test(g)) return true;
  if (g.includes(ZWJ) && /\p{Extended_Pictographic}/u.test(g)) return true;
  if (EMOJI_BY_DEFAULT.has(g)) return true;
  return /\p{Emoji_Presentation}/u.test(g);
}

/** Resimli sembol kümesi mi (emoji ya da ♥ ★ ✿ gibi Extended_Pictographic)? Satır bölmede noktalama gibi davranır. */
export function isPictographic(g: string): boolean {
  return isEmojiGrapheme(g) || /\p{Extended_Pictographic}/u.test(g);
}

/** Yarım kalmış (eşi olmayan) UTF-16 vekilleri: bozuk kopyalama ya da kesilmiş emoji. Boş dizi = sağlam. */
export function loneSurrogates(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = text.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) {
        i++;
        continue;
      }
      out.push(i);
    } else if (c >= 0xdc00 && c <= 0xdfff) out.push(i);
  }
  return out;
}
