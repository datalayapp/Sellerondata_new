import type { DatabaseSync } from "node:sqlite";

/** Göç ortamı: zaman ve kimlik (testte sabitlenebilir). */
export interface MigrationEnv {
  /** ISO zaman. */
  now(): string;
  /** Yeni kimlik (UUIDv7). */
  newId(): string;
}

/**
 * Göç: SQL metni ya da işlev (kimlik üretimi, veri taşıma gibi JavaScript isteyen işler). İkisi de çalıştırıcının
 * açtığı işlemin içinde çalışır; işlev eşzamanlıdır (await yok) ve hata fırlatırsa göç bütünüyle geri alınır.
 */
export type Migration = string | ((db: DatabaseSync, env: MigrationEnv) => void);
