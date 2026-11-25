import { intlLocale } from "../../i18n/bicim.ts";
import { tt } from "./dil.ts";

/** "Bugün 14:05", "Dün 09:30", "3 Kas 14:05" (dile göre); geçersizse boş. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const loc = intlLocale();
  const today = new Date();
  const y = new Date(today.getTime() - 86_400_000);
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return tt("designLanguage:date.today", { time });
  if (d.toDateString() === y.toDateString()) return tt("designLanguage:date.yesterday", { time });
  const day = d.toLocaleDateString(loc, { day: "numeric", month: "short", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
  return `${day} ${time}`;
}
