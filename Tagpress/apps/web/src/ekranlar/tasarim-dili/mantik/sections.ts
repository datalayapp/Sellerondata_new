import { PROFILE_GROUPS, type ProfileGroup } from "@tagpress/domain";
import { tt } from "../dil.ts";

export type SectionId = "ozet" | "kurallar" | "dene" | "ornekler" | "ogren" | "surumler" | "olustur";

const section = (id: SectionId) => ({
  id,
  /** Sekme adı, okunduğu anda etkin dile göre (`designLanguage:tabs.<bölüm>`). */
  get label() {
    return tt(`designLanguage:tabs.${id}`);
  },
});

export const SECTIONS: Array<{ id: SectionId; label: string }> = (["ozet", "kurallar", "dene", "ornekler", "ogren", "surumler", "olustur"] as const).map(section);

export const DEFAULT_GROUP: ProfileGroup = "genel";

/** `#/tasarim-dili/<bölüm>[/<grup>]` */
export function parseSection(rest: string[]): { section: SectionId; group: ProfileGroup } {
  const section = SECTIONS.find((s) => s.id === rest[0])?.id ?? "ozet";
  const group = PROFILE_GROUPS.find((g) => g.id === rest[1])?.id ?? DEFAULT_GROUP;
  return { section, group };
}

export function sectionPath(section: SectionId, group?: ProfileGroup): string[] {
  return section === "kurallar" && group ? [section, group] : [section];
}
