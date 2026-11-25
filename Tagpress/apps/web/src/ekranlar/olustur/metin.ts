import type { BuildError, RuleChange, ShowcaseItem } from "@tagpress/domain";
import { formatMm, formatUsd } from "../../i18n/bicim.ts";
import { i18n } from "../../i18n/index.ts";
import { serverText } from "../../i18n/sunucu.ts";
import { ApiFailure } from "../../lib/api.ts";
import { labelFor } from "../tasarim-dili/mantik/diffView.ts";
import type { StreamStep } from "./useOlustur.ts";

/**
 * Oluştur ekranının sözlükten kurulan cümleleri (`builder:*`). Sunucu kod + parametre gönderir; cümleyi burada kurarız.
 * Sözlükte karşılığı olmayan kodda genel metin (oluşturucu hata kodları `errors` sözlüğüne girene kadar burada).
 */
const t = (key: string, o?: Record<string, unknown>) => i18n.t(key, o) as string;
const has = (key: string) => i18n.exists(key);

/** HTTP hatası → cümle: önce `builder:httpError.<kod>` (oluşturucunun kodları), yoksa genel sunucu metni. */
export function hataMetni(e: unknown): string {
  if (e instanceof ApiFailure && e.body.code && has(`builder:httpError.${e.body.code}`)) return t(`builder:httpError.${e.body.code}`, { ...e.body.params });
  return serverText(e);
}

/** Oturuma yazılan hata (`Build.error` ya da akışın `error` girdisi). */
export function oturumHatasi(err: Pick<BuildError, "code" | "params"> | { code: string; params?: Record<string, string | number> }): string {
  return has(`builder:error.${err.code}`) ? t(`builder:error.${err.code}`, { ...err.params }) : t("builder:error.unknown");
}

/** Sistem bildirimi (`notice` girdisi). Tutarlar USD olarak biçimlenir. */
export function bildirimMetni(code: string, params: Record<string, string | number>): string {
  if (!has(`builder:notice.${code}`)) return t("builder:notice.unknown");
  const money = (k: string) => (typeof params[k] === "number" ? formatUsd(params[k] as number) : params[k]);
  const paths =
    typeof params.paths === "string"
      ? params.paths
          .split(",")
          .map((p) => labelFor(p.trim()))
          .join(", ")
      : undefined;
  return t(`builder:notice.${code}`, {
    ...params,
    limitUsd: money("limitUsd"),
    monthUsd: money("monthUsd"),
    usedUsd: money("usedUsd"),
    paths,
    s: typeof params.waitMs === "number" ? Math.ceil(params.waitMs / 1000) : undefined,
  });
}

/** Örnek etiketin altındaki not: "Üçüncül satır küçüldü · Kontur kalınlığı büyüdü". */
export function notMetni(note: ShowcaseItem["note"]): string {
  return note.map((n) => t(`builder:note.${n.direction}`, { label: labelFor(n.label) })).join(" · ");
}

/** Ölçü: "Ø 38 mm", "63,5 × 38,1 mm". */
export function olcuMetni(s: ShowcaseItem["sizeMm"]): string | null {
  if (!s) return null;
  if (s.shape === "circle" && s.w === s.h) return t("builder:size.circle", { d: formatMm(s.w) });
  return t("builder:size.rect", { w: formatMm(s.w), h: formatMm(s.h) });
}

/** Değişikliğin kaynağı: "ölçüm · 6 örnek", "cevabınız", "düzeltmeniz"… */
export function kaynakMetni(c: RuleChange): string {
  const k = c.source.kind;
  if (k === "measurement") return c.source.n !== undefined ? t("builder:source.measurementN", { count: c.source.n }) : t("builder:source.measurement");
  return t(`builder:source.${k}`);
}

/** Akıştaki adım: "Örnekler ölçülüyor", "Kurallar yazılıyor", "Yeniden denenecek (5 sn)". */
export function adimMetni(s: Pick<StreamStep, "step" | "waitMs" | "attempt">): string {
  if (s.step === "retry-wait") return t("builder:step.retry-wait", { s: Math.ceil((s.waitMs ?? 0) / 1000), attempt: s.attempt ?? 1 });
  return has(`builder:step.${s.step}`) ? t(`builder:step.${s.step}`) : t("builder:step.working");
}
