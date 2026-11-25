import { describe, expect, it } from "vitest";
import { checkTextPreserved, graphemes, isEmojiGrapheme, loneSurrogates, styledUnicodeChars, toPlainLetters } from "./index.ts";

const ZWJ = "\u200D";
const FAMILY = `👨${ZWJ}👩${ZWJ}👧`;

describe("grafem kümeleri: emoji tek parça", () => {
  it("ZWJ dizisi, ten rengi, bayrak, tuş kapağı ve seçicili kalp tek küme", () => {
    expect(graphemes(`Aile ${FAMILY}`)).toEqual(["A", "i", "l", "e", " ", FAMILY]);
    expect(graphemes("🙏🏽✨")).toEqual(["🙏🏽", "✨"]);
    expect(graphemes("🇹🇷1️⃣❤️")).toEqual(["🇹🇷", "1️⃣", "❤️"]);
  });

  it("emoji sunumu: seçici, tuş kapağı, bayrak, ten rengi, ZWJ; metin sembolü emoji değildir", () => {
    for (const g of ["❤️", "1️⃣", "🇹🇷", "🙏🏽", FAMILY, "😀", "🏴󠁧󠁢󠁳󠁣󠁴󠁿"]) expect(isEmojiGrapheme(g), g).toBe(true);
    for (const g of ["♥", "★", "✿", "☾", "™", "©", "❤︎", "☺︎", "A", "ş"]) expect(isEmojiGrapheme(g), g).toBe(false);
  });

  it("seçicisiz kalp (❤, U+2764) emoji sayılır (kullanıcı kararı); metin seçicili (❤︎) ve süs sembolleri sayılmaz", () => {
    expect(isEmojiGrapheme("❤")).toBe(true);
    expect(isEmojiGrapheme("❤︎")).toBe(false);
    for (const g of ["♥", "♡", "★", "✿", "☾"]) expect(isEmojiGrapheme(g), g).toBe(false);
  });

  it("yarım vekil bulunur", () => {
    expect(loneSurrogates("Elif ❤️ 🎂")).toEqual([]);
    expect(loneSurrogates("Elif \uD83C")).toEqual([5]);
    expect(loneSurrogates("\uDF82 x")).toEqual([0]);
  });
});

describe("satır bölme: emoji yanında boşluksuz bölme, emoji ortasında asla", () => {
  it("boşluksuz yazılmış emojinin önünden/arkasından bölünebilir", () => {
    const t = "Doğum günün kutlu olsun🎂İyi ki doğdun";
    expect(checkTextPreserved(["Doğum günün kutlu olsun🎂", "İyi ki doğdun"], t).ok).toBe(true);
    expect(checkTextPreserved(["Elif", "❤️Kerem"], "Elif❤️Kerem").ok).toBe(true);
  });

  it("emojinin içinden bölme ve emojiyi değiştirme reddedilir", () => {
    expect(checkTextPreserved([`Aile 👨${ZWJ}`, `👩${ZWJ}👧`], `Aile ${FAMILY}`).ok).toBe(false);
    expect(checkTextPreserved(["Teşekkürler 🙏", "🏽"], "Teşekkürler 🙏🏽").ok).toBe(false);
    expect(checkTextPreserved(["Elif ❤ Kerem"], "Elif ❤️ Kerem").ok).toBe(false);
    // Harfler arasında (emoji yokken) boşluksuz bölme yine yasak.
    expect(checkTextPreserved(["Ali", "Can"], "AliCan").ok).toBe(false);
  });
});

describe("süslü yazı: düz harfe çevirme (yalnız kullanıcı isteyince)", () => {
  it("matematiksel, tam genişlikli, daire içi, negatif kare, küçük büyük harf ve üstü çizili algılanır", () => {
    expect(styledUnicodeChars("𝓔𝓵𝓲𝓯 𝐊𝐞𝐫𝐞𝐦").length).toBe(9);
    expect(styledUnicodeChars("Ａｙｓｅ").length).toBe(4);
    expect(styledUnicodeChars("Ⓐⓨ").length).toBe(2);
    expect(styledUnicodeChars("🅴🅻🅸🅵").length).toBe(4);
    expect(styledUnicodeChars("ᴇʟɪꜰ").length).toBe(4);
    expect(styledUnicodeChars("E̶l̶i̶f̶")).toEqual(["E̶", "l̶", "i̶", "f̶"]);
  });

  it("emoji, Türkçe harf ve normal semboller süslü sayılmaz", () => {
    expect(styledUnicodeChars("Elif ❤️ Kerem 🇹🇷 1️⃣ Ⓜ️ 🅰️ ★ ™ © ① ² İıŞşĞğ")).toEqual([]);
  });

  it("çeviri yalnız süslü harflere dokunur: Türkçe harfler, emoji ve semboller korunur", () => {
    expect(toPlainLetters("𝘈𝘺ş𝘦 İpek ılık")).toBe("Ayşe İpek ılık");
    expect(toPlainLetters("𝓔𝓵𝓲𝓯 ❤️ 𝐊𝐞𝐫𝐞𝐦 🇹🇷")).toBe("Elif ❤️ Kerem 🇹🇷");
    expect(toPlainLetters("Ｔｅşｅｋｋüｒｌｅｒ")).toBe("Teşekkürler");
    expect(toPlainLetters("Ⓜ️ 𝓐nna Ⓐⓨ")).toBe("Ⓜ️ Anna Ay");
    expect(toPlainLetters("🅴🅻🅸🅵 🅰️")).toBe("ELIF 🅰️");
    expect(toPlainLetters("ᴇʟɪꜰ ᴋᴇʀᴇᴍ")).toBe("elif kerem");
    expect(toPlainLetters("E̶l̶i̶f̶ A̲l̲i̲")).toBe("Elif Ali");
    // Süslü harfe eklenmiş Türkçe işaret düz harfle birleşir (NFC): 𝐒 + çengel → Ş.
    expect(toPlainLetters("𝐒̧ule")).toBe("Şule");
    expect(toPlainLetters(`Aile ${FAMILY} ★ © ① m²`)).toBe(`Aile ${FAMILY} ★ © ① m²`);
  });
});
