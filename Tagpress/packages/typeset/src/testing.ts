import path from "node:path";

/**
 * YALNIZCA TESTLER İÇİN: depodaki açık lisanslı font fikstürü (`packages/typeset/test-fonts`, kaynak ve lisanslar
 * `KAYNAKLAR.txt`). Her makinede aynıdır; kullanıcının ya da tasarım dillerinin fontlarına bağlı değildir.
 */
export const TEST_FONTS_DIR = path.resolve(import.meta.dirname, "..", "test-fonts");

/** Fikstürün ortak yedek klasörü (Noto Naskh Arabic, Twemoji Mozilla alt kümesi). */
export const TEST_FALLBACK_FONTS_DIR = path.join(TEST_FONTS_DIR, "yedek");
