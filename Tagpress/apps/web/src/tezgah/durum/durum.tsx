import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../cx.ts";
import { Icon, type IconName } from "../ikon/Icon.tsx";
import "./durum.css";

export type DotTone = "ok" | "warn" | "error" | "busy" | "ready" | "idle" | "info";

/** Durum noktası + görünür kısa metin (renk tek başına anlam taşımaz). Metin verilmezse ekran okuyucuya tonun adı. */
export function StatusDot({ tone, label }: { tone: DotTone; label?: string }) {
  const { t } = useTranslation("common");
  return (
    <span className={cx("tz-dot-w", `tz-dot-w--${tone}`)}>
      <span className={cx("tz-dot", `tz-dot--${tone}`)} aria-hidden="true" />
      {label ? <span>{label}</span> : <span className="tz-sr">{t(`status.${tone}`)}</span>}
    </span>
  );
}

/** Sorun rozeti: yalnız sorun için (kırmızı hata, turuncu uyarı). */
export function IssueBadge({ tone, children }: { tone: "error" | "warn"; children: ReactNode }) {
  return (
    <span className={cx("tz-tag", tone === "error" ? "tz-tag--error" : "tz-tag--warn")}>
      <Icon name={tone === "error" ? "err" : "warn"} size={12} />
      {children}
    </span>
  );
}

/** Bilgi etiketi (durum değil): nötr, mor vurgu ("AI 1. sıra"), mavi bilgi. */
export function Tag({ tone = "neutral", children }: { tone?: "neutral" | "accent" | "info"; children: ReactNode }) {
  return <span className={cx("tz-tag", `tz-tag--${tone}`)}>{children}</span>;
}

export type IssueTone = "error" | "warn" | "ok" | "info";

const ISSUE_ICON: Record<IssueTone, IconName> = { error: "err", warn: "warn", ok: "okc", info: "info" };

/** Sorun kutusu: ikon, cümle, altında düzeltme düğmeleri. `info`: mavi bilgi notu (sorun değil). */
export function IssueBox({ tone, children, fixes }: { tone: IssueTone; children: ReactNode; fixes?: ReactNode }) {
  return (
    <div className={cx("tz-issue", `tz-issue--${tone}`)} role={tone === "ok" ? undefined : "note"}>
      <Icon name={ISSUE_ICON[tone]} size={15} className="tz-issue-i" />
      <div className="tz-issue-t">{children}</div>
      {fixes && <div className="tz-issue-fx">{fixes}</div>}
    </div>
  );
}

export function ProgressBar({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className="tz-prog" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <i style={{ width: `${pct}%` }} />
    </span>
  );
}

/** Boş durum: arayüzü öğretir; isteğe bağlı kısa açıklama; tek eylem. */
export function EmptyState({ icon, title, body, action }: { icon?: IconName; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="tz-empty">
      {icon && <Icon name={icon} />}
      <p className="tz-empty-t">{title}</p>
      {body && <div className="tz-empty-b">{body}</div>}
      {action && <div className="tz-empty-a">{action}</div>}
    </div>
  );
}
