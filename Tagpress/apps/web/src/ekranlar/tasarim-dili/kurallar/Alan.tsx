import type { FontEntry, GlyphRule, LabelSize, Shape, StickerSheet } from "@tagpress/domain";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { type FieldSpec, ENFORCEMENT_VIEW } from "../mantik/formSpec.ts";
import { getPath } from "../mantik/profilePath.ts";
import { useWork } from "../mantik/work.tsx";
import { cx, Icon, NumberStepper, Segmented, Switch, TextArea, TextField, Tooltip } from "../../../tezgah/index.ts";
import { pct } from "../dil.ts";
import { fieldHelp, fieldLabel } from "../profilMetni.ts";
import {
  BaglacOranDuzenleyici,
  BoyutDuzenleyici,
  CiftDuzenleyici,
  CipDuzenleyici,
  type DuzenleyiciProps,
  FontlarDuzenleyici,
  KesimDuzenleyici,
  KutuDuzenleyici,
  OrnekDuzenleyici,
  OzelKarakterDuzenleyici,
  StickerDuzenleyici,
  VarsayilanBoyutDuzenleyici,
} from "./Duzenleyiciler.tsx";
import { Hatalar, IsteBagliSayi, Sayi } from "./Parcalar.tsx";

/**
 * Bir profil alanı: etiket, tür ölçüsüne uygun kontrol ve yerinde hata. Tanım `PROFILE_DOCS`'tan (`formSpec.ts`), metin
 * önce sözlükten gelir (`profilMetni.ts`). Açıklama metni ekranda yok: yardım ve kesinlik etiketin ipucunda; motorun
 * kesin uyguladığı alanda etiketin yanında kilit. Değişen alanın satırı açık mor zeminli (rozet yok).
 */
export function Alan({ spec, groupName, changed }: { spec: FieldSpec; groupName?: string; changed: boolean }) {
  const { t } = useTranslation("designLanguage");
  const w = useWork();
  const profile = w.value;
  if (!profile) return null;
  const { path, doc, control } = spec;
  const value = getPath(profile, path);
  const errs = Object.entries(w.errors)
    .filter(([p]) => p === path || p.startsWith(`${path}.`))
    .map(([p, message]) => ({ path: p, message }));
  const ownError = errs.find((e) => e.path === path)?.message;
  const label = fieldLabel(path);
  const id = `alan-${path}`;
  const set = (v: unknown) => w.edit(path, v);
  const enforcement = ENFORCEMENT_VIEW[doc.enforcement];

  let body: ReactNode = null;
  let stacked = false;
  switch (control.kind) {
    case "toggle":
      body = (
        <span className="td-anahtar">
          <Switch checked={value === true} label={label} onChange={set} />
          <span className="td-soluk">{value === true ? t("field.on") : t("field.off")}</span>
        </span>
      );
      break;
    case "segmented":
      stacked = true;
      body = <Segmented<string> aria-label={label} value={String(value)} options={control.options} onChange={set} />;
      break;
    case "number": {
      const fmtUnit = control.percent ? undefined : control.suffix;
      if (control.nullable) {
        body = (
          <IsteBagliSayi
            value={typeof value === "number" ? value : null}
            step={control.step}
            min={control.min}
            max={control.max}
            unit={fmtUnit}
            label={label}
            emptyLabel={t("field.generalLimit")}
            setLabel={t("field.setLimit")}
            clearLabel={t("field.clearLimit")}
            initial={profile.sizing.maxCapHeight}
            onChange={set}
          />
        );
      } else if (control.percent) {
        body = <PercentStepper value={typeof value === "number" ? value : 0} step={control.step} min={control.min} max={control.max} label={label} onChange={set} />;
      } else {
        body = <Sayi value={typeof value === "number" ? value : 0} step={control.step} min={control.min} max={control.max} unit={fmtUnit} label={label} onChange={set} />;
      }
      break;
    }
    case "text":
      body = <TextField id={`${id}-k`} value={typeof value === "string" ? value : ""} invalid={!!ownError} onChange={set} />;
      break;
    case "textarea":
      stacked = true;
      body = <TextArea id={`${id}-k`} value={typeof value === "string" ? value : ""} rows={path === "ai.instructions" ? 5 : 3} invalid={!!ownError} onChange={set} />;
      break;
    case "color":
      body = <Renk id={`${id}-k`} label={label} value={typeof value === "string" ? value : "#000000"} invalid={!!ownError} onChange={set} />;
      break;
    case "custom":
      stacked = true;
      body = <Ozel editor={control.editor} value={value} onChange={set} profile={profile} languageId={w.languageId} errors={errs} fieldPath={path} label={label} />;
      break;
  }

  const labelFor = control.kind === "text" || control.kind === "color" || control.kind === "textarea" ? `${id}-k` : undefined;
  const help = fieldHelp(path);
  const tip = [help, enforcement.hint].filter(Boolean).join(" ");
  const locked = doc.enforcement === "motor";
  const labelBody = (
    <>
      {label}
      {locked && <Icon name="lock" size={12} />}
    </>
  );
  const labelEl = (
    <Tooltip content={tip}>
      {labelFor ? (
        <label className="td-alan-l" htmlFor={labelFor}>
          {labelBody}
        </label>
      ) : (
        <span className="td-alan-l">{labelBody}</span>
      )}
    </Tooltip>
  );

  return (
    <div id={id} data-field={path} className={cx("td-alan", stacked && "is-ust", changed && "is-degisti")}>
      {labelEl}
      <div className="td-alan-v">{body}</div>
      <span className="td-sr">{tip}</span>
      {groupName && <span className="td-alan-grup td-soluk">{groupName}</span>}
      {control.kind !== "custom" && <Hatalar errors={errs} />}
    </div>
  );
}

/** Oran alanı: saklanan değer 0–1; görünen yüzde (TR "%97", EN "97%"). */
function PercentStepper({ value, step, min, max, label, onChange }: { value: number; step: number; min?: number; max?: number; label: string; onChange: (v: number) => void }) {
  return <NumberStepper value={value} step={step} min={min} max={max} aria-label={label} format={pct} onChange={onChange} />;
}

function Renk({ id, label, value, invalid, onChange }: { id: string; label: string; value: string; invalid: boolean; onChange: (v: string) => void }) {
  const { t } = useTranslation("designLanguage");
  const hex = /^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000";
  return (
    <span className="td-renk">
      <input type="color" aria-label={t("field.pickColor", { name: label })} value={hex} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <TextField id={id} className="td-mono" value={value} invalid={invalid} onChange={onChange} />
    </span>
  );
}

function Ozel({ editor, value, onChange, ...rest }: { editor: string; value: unknown; onChange: (v: unknown) => void } & Omit<DuzenleyiciProps<unknown>, "value" | "onChange">) {
  const c = onChange as never;
  switch (editor) {
    case "fonts":
      return <FontlarDuzenleyici {...rest} value={value as FontEntry[]} onChange={c} />;
    case "glyphs":
      return <OzelKarakterDuzenleyici {...rest} value={value as GlyphRule[]} onChange={c} />;
    case "connectorScales":
      return <BaglacOranDuzenleyici {...rest} value={value as Record<string, number>} onChange={c} />;
    case "chips":
      return <CipDuzenleyici {...rest} value={value as string[]} onChange={c} />;
    case "pair":
      return <CiftDuzenleyici {...rest} value={value as [number, number]} onChange={c} />;
    case "examples":
      return <OrnekDuzenleyici {...rest} value={value as Array<{ text: string; lines: string[] }>} onChange={c} />;
    case "cut":
      return <KesimDuzenleyici {...rest} value={value as Shape} onChange={c} />;
    case "box":
      return <KutuDuzenleyici {...rest} value={value as { x: number; y: number; w: number; h: number }} onChange={c} />;
    case "sizes":
      return <BoyutDuzenleyici {...rest} value={value as LabelSize[]} onChange={c} />;
    case "defaultSize":
      return <VarsayilanBoyutDuzenleyici {...rest} value={value as string} onChange={c} />;
    case "sheets":
      return <StickerDuzenleyici {...rest} value={value as StickerSheet[]} onChange={c} />;
    default:
      return null;
  }
}
