import { PROFILE_DOCS, PROFILE_GROUPS } from "@tagpress/domain";
import { i18n } from "../../i18n/index.ts";

/**
 * Alan ve grup metinleri: önce sözlük (`profile:groups.<id>.{label,help}`, `profile:fields.<yol>.{label,help}`),
 * anahtar yoksa domain'deki (`PROFILE_DOCS`, `PROFILE_GROUPS`) Türkçe metin. Böylece sözlükte karşılığı henüz
 * olmayan yeni bir alan da ekranda görünür.
 */
function read(key: string, fallback: string): string {
  return i18n.exists(key) ? (i18n.t(key) as string) : fallback;
}

export function groupLabel(id: string): string {
  return read(`profile:groups.${id}.label`, PROFILE_GROUPS.find((g) => g.id === id)?.label ?? id);
}

export function groupHelp(id: string): string {
  return read(`profile:groups.${id}.help`, PROFILE_GROUPS.find((g) => g.id === id)?.help ?? "");
}

export function fieldLabel(path: string): string {
  return read(`profile:fields.${path}.label`, PROFILE_DOCS[path]?.label ?? path);
}

export function fieldHelp(path: string): string {
  return read(`profile:fields.${path}.help`, PROFILE_DOCS[path]?.help ?? "");
}
