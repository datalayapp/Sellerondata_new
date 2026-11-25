/**
 * Sürümlü göçler. `PRAGMA user_version` uygulanmış göç sayısıdır; yeni göç yalnızca SONA eklenir, eskisi asla
 * değiştirilmez. Her göç kendi dosyasındadır (`NNNN-ad.ts`, `migration` dışa aktarır); numaraları orkestratör verir
 * (8 profil alanı, 9 firma, 10 sıkı firma kipi, 11 özellikler ve kurulum, 12 baskı ölçüleri, 13 oluşturucu, 14 üye izi). Esnek alanlar JSON metin sütunlarındadır.
 * Çalıştırıcı: `db/database.ts` `migrate` (bekleyen göç varsa önce yedek: `openDatabase`).
 */
import { migration as m1 } from "./0001-baslangic.ts";
import { migration as m2 } from "./0002-tasarim-oturumu.ts";
import { migration as m3 } from "./0003-hafif-duzeltme.ts";
import { migration as m4 } from "./0004-arka-plan-gorevleri.ts";
import { migration as m5 } from "./0005-baski-masasi.ts";
import { migration as m6 } from "./0006-baski-anlik-kopya.ts";
import { migration as m7 } from "./0007-figma-temizligi.ts";
import { migration as m8 } from "./0008-profil-figma.ts";
import { migration as m9 } from "./0009-firma.ts";
import { migration as m10 } from "./0010-siki-kip.ts";
import { migration as m11 } from "./0011-ozellikler.ts";
import { migration as m12 } from "./0012-baski-olculeri.ts";
import { migration as m13 } from "./0013-olusturucu.ts";
import { migration as m14 } from "./0014-uye-izi.ts";
import type { Migration } from "./types.ts";

export type { Migration, MigrationEnv } from "./types.ts";

export const MIGRATIONS: readonly Migration[] = [m1, m2, m3, m4, m5, m6, m7, m8, m9, m10, m11, m12, m13, m14];
