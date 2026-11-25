import { API, type CostSummary, type GenerateRequest, type JobSummary, type VariantKind } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatUsd } from "../../i18n/bicim.ts";
import { api as http, withQuery } from "../../lib/api.ts";
import { useAccess } from "../../lib/access.ts";
import { useLanguage } from "../../lib/language.tsx";
import { type SortChoice, SORT_CHOICES, shownVariant } from "./mantik/jobs.ts";
import { Button, IconButton, Menu, Switch, TextArea, Tooltip } from "../../tezgah/index.ts";

/** Üretim ekranının küçük ortak parçaları: sıralama, iş küçük resmi, AI notu ve görselle üret formları, günün maliyeti. */

export const KIND_KEY: Record<VariantKind, string> = { text: "kind.text", "image-on-template": "kind.imageOnTemplate", "generated-template": "kind.generatedTemplate" };

export function SortMenu({ value, onChange }: { value: SortChoice; onChange(s: SortChoice): void }) {
  const { t } = useTranslation("production");
  return (
    <Menu
      align="end"
      trigger={(p) => <IconButton {...p} icon="sort" label={`${t("tools.sort")}: ${value.label}`} />}
      items={SORT_CHOICES.map((s) => ({ label: s.label, icon: s.id === value.id ? ("check" as const) : undefined, onSelect: () => onChange(s) }))}
    />
  );
}

// ---------------------------------------------------------------- iş küçük resmi

/** Kartın önizlemesi: gösterilecek seçenek; henüz üretilmemiş işte şablon soluk, şablonsuzda soru işareti. */
export function JobThumb({ job, templateImage, size }: { job: JobSummary; templateImage?: string; size: "s" | "l" | "m" }) {
  const shown = shownVariant(job);
  const src = shown?.previewUrl ?? (shown ? undefined : templateImage);
  return (
    <span className={`ur-thumb ur-thumb--${size}${!shown && src ? " is-dim" : ""}${!src ? " is-none" : ""}`} aria-hidden="true">
      {src ? <img src={src} alt="" loading="lazy" decoding="async" draggable={false} /> : <b>?</b>}
    </span>
  );
}

// ---------------------------------------------------------------- AI notu

/** AI notu: seçili işlerin notu bu metinle değişir (boş bırakmak notu temizler). */
export function AiNoteForm({ count, initial, onSave }: { count: number; initial: string; onSave(note: string): void }) {
  const { t } = useTranslation("production");
  const [note, setNote] = useState(initial);
  const id = useId();
  return (
    <form
      className="ur-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(note.trim());
      }}
    >
      <label htmlFor={id} className="ur-form-l">
        {count > 1 ? t("aiNote.titleMany", { count }) : t("aiNote.title")}
      </label>
      <TextArea id={id} rows={3} value={note} onChange={setNote} placeholder={t("aiNote.placeholder")} maxLength={2000} data-autofocus="" />
      <p className="ur-hint">{t("aiNote.hint")}</p>
      <div className="ur-form-a">
        {initial && (
          <Button variant="quiet" size="mini" icon="reset" onClick={() => setNote("")}>
            {t("aiNote.clear")}
          </Button>
        )}
        <Button type="submit" size="mini">
          {t("aiNote.apply")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- görselle üret (ücretli; bugünkü gibi onaysız, anahtar yoksa bildirim)

type ImageMode = "image-on-template" | "generated-template";
export type ImageOpts = Pick<GenerateRequest, "mode" | "theme" | "keepTemplate">;

/** "Görselle üret": şablona yaz (şablon hiç değişmez) ya da temadan yeni şablon. */
export function ImageForm({ count, onRun }: { count: number; onRun(o: ImageOpts): void }) {
  const { t } = useTranslation("production");
  const [mode, setMode] = useState<ImageMode>("image-on-template");
  const [theme, setTheme] = useState("");
  const [keep, setKeep] = useState(true);
  const name = useId();
  const themeId = useId();
  const needsTheme = mode === "generated-template";
  const ok = !needsTheme || theme.trim().length > 0;
  const options: Array<{ value: ImageMode; title: string; body: string }> = [
    { value: "image-on-template", title: t("image.onTemplate"), body: t("image.onTemplateBody") },
    { value: "generated-template", title: t("image.generated"), body: t("image.generatedBody") },
  ];
  return (
    <form
      className="ur-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onRun({ mode, theme: needsTheme ? theme.trim() : undefined, keepTemplate: keep });
      }}
    >
      <fieldset className="ur-radios">
        <legend className="tz-sr">{t("image.mode")}</legend>
        {options.map((o) => (
          <label key={o.value} className="ur-radio">
            <input type="radio" name={name} checked={mode === o.value} onChange={() => setMode(o.value)} />
            <span>
              <b>{o.title}</b>
              <small>{o.body}</small>
            </span>
          </label>
        ))}
      </fieldset>
      {needsTheme && (
        <>
          <label htmlFor={themeId} className="ur-form-l">
            {t("image.theme")}
          </label>
          <TextArea id={themeId} rows={3} value={theme} onChange={setTheme} placeholder={t("image.themePlaceholder")} />
          <span className="ur-switch">
            <Switch checked={keep} onChange={setKeep} label={t("image.keep")} />
            <span>
              {t("image.keep")}
              <small>{t("image.keepHint")}</small>
            </span>
          </span>
        </>
      )}
      <div className="ur-form-a">
        <Button type="submit" size="mini" icon="img" disabled={!ok}>
          {count > 1 ? t("image.runMany", { count }) : t("image.run")}
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- günün maliyeti

/**
 * Günün AI maliyeti (etkin tasarım dili); ipucunda bu ay. Üretilmeyi bekleyenler başlığında, "Seçilenleri üret"in yanında.
 * Harcama tutarı yalnız yönetebilene (`access.manage`); platformda öbürleri için sorulmaz, yanıt gelmezse sessizce gizli.
 */
export function GununMaliyeti() {
  const { t } = useTranslation("production");
  const { current } = useLanguage();
  const { manage } = useAccess();
  const q = useQuery({
    queryKey: ["costs", current?.id],
    enabled: !!current && manage,
    queryFn: () => http.get<CostSummary>(withQuery(API.costs, { languageId: current?.id })),
    refetchInterval: 60_000,
  });
  if (!q.data) return null;
  return (
    <Tooltip content={t("status.month", { cost: formatUsd(q.data.monthUsd, { approx: true }) })}>
      <span tabIndex={0} className="ur-cost">
        {t("status.today", { cost: formatUsd(q.data.todayUsd, { approx: true }) })}
      </span>
    </Tooltip>
  );
}
