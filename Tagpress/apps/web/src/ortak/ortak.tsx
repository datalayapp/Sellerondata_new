import { API, type JobStatus, type TemplateItem } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, path } from "../lib/api.ts";
// Yeni kodda tasarım dili kancası bu adla (kodda "language" = tasarım dili, "locale" = arayüz dili).
import { useLanguage as useDesignLanguage } from "../lib/language.tsx";
import { type DotTone, StatusDot } from "../tezgah/durum/durum.tsx";
import { SearchField } from "../tezgah/form/form.tsx";
import { Icon } from "../tezgah/ikon/Icon.tsx";
import { Popover, type TriggerProps } from "../tezgah/katman/Popover.tsx";
import { ListRow } from "../tezgah/yerlesim/yerlesim.tsx";
import "./ortak.css";

/**
 * Ortak alan bileşenleri. Ekranlar bunları `src/ortak/index.ts`'ten alır (sözleşme ARAYUZ-PLANI §3.3).
 * Elle ekleme penceresi `ElleEkle.tsx`'te.
 */

/** Şablon küçük resmi: beyaz kâğıtta; görsel yoksa (sticker sayfası, eksik dosya) ikonlu boş kutu. */
export function TemplateThumb({ url, size }: { url: string; size: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <span className="or-thumb" style={{ width: size, height: size }}>
      {url && !failed ? <img src={url} alt="" width={size} height={size} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} /> : <Icon name="img" size={size >= 36 ? 15 : 12} />}
    </span>
  );
}

/** Şablon görselinin adresi (TemplateThumb için). Sticker sayfalarının görseli yoktur. */
export function templateImageUrl(languageId: string | null | undefined, key: string | null | undefined): string {
  return languageId && key && !key.startsWith("sticker-") ? path(API.templateImage, { lang: languageId, key }) : "";
}

export interface TemplatePickerProps {
  languageId: string | null | undefined;
  /** Seçilebilir anahtarlar. Verilmezse dilin şablonları sunucudan okunur. */
  keys?: readonly string[];
  value: string | null;
  /** `null` = şablonsuz bırak (yalnızca `allowClear` iken). */
  onChange: (key: string | null) => void;
  /** Listenin üstünde "Önerilen" olarak gösterilir. */
  suggestions?: readonly string[];
  allowClear?: boolean;
  trigger: (p: TriggerProps) => ReactNode;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** Aranabilir şablon seçici: yaz, ↑/↓ ile gez, Enter seç. Öneriler üstte. */
export function TemplatePicker({ languageId, keys, value, onChange, suggestions = [], allowClear, trigger, align = "start", open, onOpenChange }: TemplatePickerProps) {
  return (
    <Popover trigger={trigger} align={align} width={340} open={open} onOpenChange={onOpenChange}>
      {(close) => (
        <PickerPanel
          languageId={languageId}
          keys={keys}
          value={value}
          suggestions={suggestions}
          allowClear={!!allowClear}
          onPick={(k) => {
            onChange(k);
            close();
          }}
        />
      )}
    </Popover>
  );
}

interface Entry {
  key: string | null;
  group: "clear" | "suggested" | "all";
  missing?: boolean;
}

/** Çok uzun listede ilk bu kadarı çizilir; daraltmak için yazılır. */
const LIMIT = 200;

function PickerPanel({
  languageId,
  keys,
  value,
  suggestions,
  allowClear,
  onPick,
}: {
  languageId: string | null | undefined;
  keys?: readonly string[];
  value: string | null;
  suggestions: readonly string[];
  allowClear: boolean;
  onPick: (k: string | null) => void;
}) {
  const { t } = useTranslation("shared");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const remote = useQuery({
    queryKey: ["templates", languageId],
    queryFn: () => api.get<{ templates: TemplateItem[] }>(path(API.templates, { lang: languageId ?? "" })),
    enabled: !keys && !!languageId,
    staleTime: 30_000,
  });
  const missing = useMemo(() => new Set((remote.data?.templates ?? []).filter((x) => x.fileMissing).map((x) => x.template.key)), [remote.data]);
  const allKeys = useMemo(
    () => [...(keys ?? remote.data?.templates.map((x) => x.template.key) ?? [])].sort((a, b) => a.localeCompare(b, "tr", { numeric: true })),
    [keys, remote.data],
  );

  const { entries, truncated } = useMemo(() => {
    const term = q.trim().toLocaleLowerCase("tr");
    const match = (k: string) => !term || k.toLocaleLowerCase("tr").includes(term);
    const out: Entry[] = [];
    if (allowClear && !term) out.push({ key: null, group: "clear" });
    const sugg = suggestions.filter(match);
    for (const k of sugg) out.push({ key: k, group: "suggested", missing: missing.has(k) });
    const rest = allKeys.filter((k) => match(k) && !sugg.includes(k));
    for (const k of rest.slice(0, LIMIT)) out.push({ key: k, group: "all", missing: missing.has(k) });
    return { entries: out, truncated: rest.length > LIMIT };
  }, [q, allowClear, suggestions, allKeys, missing]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const loading = !keys && remote.isLoading;
  const label = t("templatePicker.label");
  return (
    <div className="or-tp">
      <SearchField
        value={q}
        onChange={setQ}
        placeholder={t("templatePicker.search")}
        aria-label={t("templatePicker.search")}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(entries.length - 1, a + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(0, a - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const it = entries[active];
            if (it) onPick(it.key);
          }
        }}
      />
      <div ref={listRef} role="listbox" aria-label={label} className="or-tp-list">
        {loading && <p className="or-tp-empty">{t("templatePicker.loading")}</p>}
        {!loading && entries.length === 0 && <p className="or-tp-empty">{q ? t("templatePicker.noMatch", { q }) : t("templatePicker.empty")}</p>}
        {entries.map((it, i) => (
          <div key={`${it.group}:${it.key}`}>
            {(i === 0 || entries[i - 1]?.group !== it.group) && it.group !== "clear" && <p className="or-tp-h">{it.group === "suggested" ? t("templatePicker.suggested") : t("templatePicker.all")}</p>}
            <div role="option" aria-selected={it.key === value} data-i={i}>
              <ListRow
                current={i === active}
                leading={
                  it.key === null ? (
                    <span className="or-thumb or-thumb--none" style={{ width: 32, height: 32 }}>
                      <Icon name="x" size={12} />
                    </span>
                  ) : (
                    <TemplateThumb url={templateImageUrl(languageId, it.key)} size={32} />
                  )
                }
                title={it.key === null ? t("templatePicker.none") : it.key}
                sub={it.missing ? t("templatePicker.fileMissing") : undefined}
                trailing={it.key === value ? <Icon name="check" size={15} /> : undefined}
                onClick={() => onPick(it.key)}
              />
            </div>
          </div>
        ))}
        {truncated && <p className="or-tp-empty">{t("templatePicker.truncated", { n: LIMIT })}</p>}
      </div>
    </div>
  );
}

/**
 * Etiket görseli, gerçek oranında. Tuvalin dünya katmanında 1 birim = 1 mm (`--tz-mm`), dışında gerçek mm.
 * `children`: görselin üstüne bindirme (seçim, sorun işareti).
 */
export function LabelImage({ src, widthMm, heightMm, alt, dimmed, children }: { src: string; widthMm: number; heightMm: number; alt: string; dimmed?: boolean; children?: ReactNode }) {
  return (
    <span className={dimmed ? "or-label is-dim" : "or-label"} style={{ width: `calc(${widthMm} * var(--tz-mm))`, height: `calc(${heightMm} * var(--tz-mm))` }}>
      <img src={src} alt={alt} draggable={false} />
      {children}
    </span>
  );
}

/**
 * İş durumu → nokta tonu (eski `ui/proof` eşlemesiyle aynı gruplar: bekliyor sönük, sırada ve üretiliyor süren iş,
 * hazır, hata, onaylı). "Hazır" koyu nötr `ready`: mor durum göstermez (ARAYUZ-PLANI §12.5).
 */
export const JOB_TONE: Record<JobStatus, DotTone> = {
  new: "idle",
  queued: "busy",
  generating: "busy",
  ready: "ready",
  failed: "error",
  approved: "ok",
};

/** İş durumu noktası. `withLabel`: yanında durum adı; yoksa ad ipucunda ve ekran okuyucuda. */
export function JobStatusDot({ status, withLabel }: { status: JobStatus; withLabel?: boolean }) {
  const { t } = useTranslation("shared");
  const label = t(`jobStatus.${status}`);
  return withLabel ? (
    <StatusDot tone={JOB_TONE[status]} label={label} />
  ) : (
    <span title={label} role="img" aria-label={label}>
      <StatusDot tone={JOB_TONE[status]} />
    </span>
  );
}

/** Üst satırdaki tasarım dili seçici (firma düğmesinin yerinde, aynı biçimde). */
export function DesignLanguageSwitcher() {
  const { t } = useTranslation("shared");
  const { languages, current, setCurrent } = useDesignLanguage();
  if (!current) return null;
  return (
    <Popover
      align="end"
      role="menu"
      trigger={(p) => (
        <button type="button" className="or-dls" {...p} aria-label={`${t("designLanguage.label")}: ${current.name}`}>
          <Icon name="book" size={15} />
          <span className="or-dls-n">{current.name}</span>
          {/* Menü tek dilde de açılır (seçili dil işaretli); ok her zaman görünür (maket .firm). */}
          <Icon name="chev" size={15} />
        </button>
      )}
    >
      {(close) => (
        <div role="menu" className="or-dls-m" aria-label={t("designLanguage.label")}>
          {languages.map((l) => (
            <button
              key={l.id}
              type="button"
              role="menuitemradio"
              aria-checked={l.id === current.id}
              onClick={() => {
                setCurrent(l.id);
                close();
              }}
            >
              <span>{l.name}</span>
              {l.id === current.id && <Icon name="check" size={15} />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  );
}

export { useDesignLanguage };
