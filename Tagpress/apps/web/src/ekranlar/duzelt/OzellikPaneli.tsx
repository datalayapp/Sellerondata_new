import type { CenterTarget } from "@tagpress/domain";
import { type FocusEvent, type RefObject, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { editOf } from "./mantik/adjust-edit.ts";
import { SCALE_STEP, scaleLabel } from "./mantik/adjust-math.ts";
import { selectionEffectiveStroke, selectionName, selectionScale, selectionStroke, STROKE_STEP, strokeLabel } from "./mantik/adjust-select.ts";
import { centerTargets, fontEmptyText, fontLabel, fontScope, fontScopeText, partialRange } from "./mantik/adjust-session.ts";
import {
  Button,
  CollapsedGroup,
  IconButton,
  Kbd,
  NumberStepper,
  Panel,
  PanelSection,
  PropPair,
  PropRow,
  Select,
  StatusDot,
  Tag,
  TextField,
  Tooltip,
  useCommand,
} from "../../tezgah/index.ts";
import { SIZE_KEYS, STROKE_KEYS } from "./kisayollar.ts";
import { formatOffset, offsetOf, parseOffset } from "./konum.ts";
import type { Duzelt } from "./useDuzelt.ts";

/**
 * Sağ panel (maket 2): başlıkta seçimin adı ve "düzeltmeyi kaldır"; Metin (Enter), Font (kapsamıyla), Konum,
 * Biçim (boyut, kalınlık), kapalı grupta ortalama hedefi; altta Vazgeç ve Kaydet (tek birincil).
 *
 * Sonradan eklenecekler için yer: satır aralığı `BicimBolumu`'na üçüncü `PropRow` olarak; sola / sağa hizalama
 * `KonumBolumu`'nun altına `Segmented` satırı olarak girer (bugün Düzelt'te ayrı denetimi yok; tasarım dilinin kuralı).
 */
export function OzellikPaneli({ d, editorRef, onStage, footer = true }: { d: Duzelt; editorRef: RefObject<HTMLInputElement | null>; onStage(): void; footer?: boolean }) {
  const { t } = useTranslation("adjust");
  return (
    <Panel
      side="right"
      title={selectionName(d.sel, d.layout.lines)}
      actions={d.saved ? <IconButton icon="trash" size={28} label={t("remove.action")} disabled={d.saving} onClick={() => void d.remove()} /> : undefined}
      // Büyük pencerede Vazgeç ve Kaydet pencerenin altında (`footer={false}`).
      footer={
        footer ? (
          <div className="dz-foot">
            <Button size="page" command="duzelt.cancel" kbd={false} disabled={d.saving} onClick={() => void d.exit()}>
              {t("actions.cancel")}
            </Button>
            <Button need="edit" variant="primary" size="page" command="duzelt.save" disabled={!d.canSave} loading={d.saving} onClick={() => void d.save()}>
              {t("actions.save")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <MetinBolumu d={d} editorRef={editorRef} onStage={onStage} />
      <FontBolumu d={d} />
      <KonumBolumu d={d} />
      <BicimBolumu d={d} />
      <HedefGrubu d={d} />
    </Panel>
  );
}

function MetinBolumu({ d, editorRef, onStage }: { d: Duzelt; editorRef: RefObject<HTMLInputElement | null>; onStage(): void }) {
  const { t } = useTranslation("adjust");
  const { single, layout, cur, model } = d;
  const line = single !== null ? layout.lines[single] : undefined;
  const spans = single !== null ? (editOf(cur, single)?.spans ?? []) : [];
  return (
    <PanelSection heading={t("text.heading")} aside={<Kbd command="duzelt.editText" />}>
      <MetinAlani d={d} editorRef={editorRef} onStage={onStage} />
      {d.canEditText && line && single !== null && (
        <>
          {d.check.textEdited && (
            <span className="dz-row">
              <Tag tone="accent">{t("text.edited")}</Tag>
            </span>
          )}
          {spans.length > 0 && (
            <div className="dz-spans">
              <span className="dz-note">{t("text.spans")}</span>
              {spans.map((s) => (
                <span key={`${s.start}-${s.end}-${s.fontId}`} className="dz-span">
                  {t("text.span", { text: line.text.slice(s.start, s.end), font: fontLabel(model.fonts, s.fontId) })}
                  <IconButton icon="x" size={26} label={t("text.removeSpan")} onClick={() => d.removeSpan(single, s)} />
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </PanelSection>
  );
}

/**
 * Seçili satırın metin alanı (sayfa, pencere ve küçük tezgâh): odaklanınca taslak başlar, Enter yazar (motor ölçer).
 * Tek satır seçili değilse ya da motor yoksa pasif; nedeni ipucunda. `onBlur`: alan odağı bırakınca (küçük tezgâh
 * odak panelden çıkınca taslağı yazar).
 */
export function MetinAlani({
  d,
  editorRef,
  onStage,
  onBlur,
}: {
  d: Duzelt;
  editorRef: RefObject<HTMLInputElement | null>;
  onStage(): void;
  onBlur?(e: FocusEvent<HTMLInputElement>): void;
}) {
  const { t } = useTranslation("adjust");
  const { single, editing, layout } = d;
  // Düzenleme başlayınca (Enter, çift tık, ray) odak alanda ve bütün metin seçili.
  useEffect(() => {
    const el = editorRef.current;
    if (!editing || !el || document.activeElement === el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(editing.start, editing.end);
  }, [editing?.index]); // eslint-disable-line react-hooks/exhaustive-deps -- odak yalnız düzenlenen satır değişince; editing her tuşta yenilenir, seçim bozulmasın
  const line = single !== null ? layout.lines[single] : undefined;
  const mine = !!editing && editing.index === single;
  const readRange = (el: HTMLInputElement) => [el.selectionStart ?? 0, el.selectionEnd ?? 0] as const;
  if (!d.canEditText || !line || single === null) {
    // Düzenlenemezken alan pasif; nedeni ipucunda (kural: açıklama metni yok).
    return (
      <Tooltip content={!d.canEditText ? t("text.noEngine") : t("text.pickLine")}>
        <TextField className="dz-grow" disabled onChange={() => {}} value={layout.lines.map((l) => l.text).join(" · ")} aria-label={t("text.heading")} />
      </Tooltip>
    );
  }
  return (
    <TextField
      ref={editorRef}
      value={mine ? editing.draft : line.text}
      aria-label={t("text.field", { n: single + 1 })}
      spellCheck={false}
      readOnly={d.busy}
      onFocus={() => {
        if (!d.editing) d.startEdit(single);
      }}
      onChange={(v) => {
        const el = editorRef.current;
        const [s, e] = el ? readRange(el) : [v.length, v.length];
        if (!d.editing) d.startEdit(single);
        d.setDraft(v, s, e);
      }}
      onSelect={(e) => {
        const [s, en] = readRange(e.currentTarget);
        d.setRange(s, en);
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        void d.commitEdit();
        onStage();
      }}
      onBlur={onBlur}
    />
  );
}

function FontBolumu({ d }: { d: Duzelt }) {
  const { t } = useTranslation("adjust");
  if (!d.canEditText) return null;
  return (
    <PanelSection heading={fontScopeText(fontScope(d.editing, d.sel))} aside={d.busy ? <StatusDot tone="busy" label={t("font.measuring")} /> : undefined}>
      <FontSecici d={d} />
    </PanelSection>
  );
}

/** Font kutusu (seçimin, taslakta seçili parçanın ya da bütün yazının fontu). Motor yoksa çizilmez. */
export function FontSecici({ d, label }: { d: Duzelt; label?: string }) {
  const { t } = useTranslation("adjust");
  const { model, editing, sel, shownFont } = d;
  if (!d.canEditText) return null;
  const scope = fontScope(editing, sel);
  const span = partialRange(editing);
  const fonts = model.fonts ?? [];
  const empty = !!span || !shownFont;
  const options = [...(empty ? [{ value: "", label: fontEmptyText(scope) }] : []), ...fonts.map((f) => ({ value: f.id, label: fontLabel(fonts, f.id) }))];
  // Seçili font kutuda kendi yazısıyla (maket .fi.sel); bilgisayarda yoksa arayüz yazısına düşer.
  const family = !span && shownFont ? fonts.find((f) => f.id === shownFont)?.family : undefined;
  const select = (
    <Select
      className={family ? "dz-font" : undefined}
      style={family ? { fontFamily: `"${family}", var(--f)` } : undefined}
      value={span ? "" : (shownFont ?? "")}
      options={options}
      onChange={(v) => d.chooseFont(v)}
      disabled={d.busy || !fonts.length}
      // Taslaktaki seçim alan odağı kaybedince de korunur; font o parçaya uygulanır.
      aria-label={label ?? t("font.label")}
    />
  );
  // Tek aile kuralı ipucunda (kural: açıklama metni yok).
  return model.fontMixing === "single" ? <Tooltip content={t("font.single")}>{select}</Tooltip> : select;
}

function KonumBolumu({ d }: { d: Duzelt }) {
  const { t } = useTranslation("adjust");
  const o = offsetOf(d.cur, d.sel);
  return (
    <PanelSection heading={t("position.heading")}>
      <PropPair>
        <OffsetField label={t("position.x")} hint={t("position.xHint")} value={o.x} onCommit={(v) => d.setOffset("x", v)} />
        <OffsetField label={t("position.y")} hint={t("position.yHint")} value={o.y} onCommit={(v) => d.setOffset("y", v)} />
      </PropPair>
    </PanelSection>
  );
}

/** Konum alanı: yazarken taslak; Enter ya da odaktan çıkınca yazılır, Esc eski değere döner. */
function OffsetField({ label, hint, value, onCommit }: { label: string; hint: string; value: number; onCommit(v: number): void }) {
  const shown = formatOffset(value);
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const v = parseOffset(draft);
    setDraft(null);
    if (v !== null) onCommit(v);
  };
  return (
    <label title={hint}>
      {label}
      <TextField
        className="tz-mono"
        value={draft ?? shown}
        unit="px"
        inputMode="decimal"
        onChange={setDraft}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") setDraft(null);
        }}
      />
    </label>
  );
}

function BicimBolumu({ d }: { d: Duzelt }) {
  const { t } = useTranslation("adjust");
  const down = useCommand("duzelt.scaleDown");
  const up = useCommand("duzelt.scaleUp");
  const thin = useCommand("duzelt.strokeDown");
  const thick = useCommand("duzelt.strokeUp");
  const { cur, sel, model, layout } = d;
  const st = selectionStroke(cur, sel);
  const eff = selectionEffectiveStroke(layout, cur, sel);
  const max = model.limits.strokeMaxPx;
  const step = (v: number, now: number, unit: number, run: (s: number) => void) => {
    if (v !== now) run(Math.sign(v - now) * unit);
  };
  return (
    <PanelSection>
      <PropRow label={t("size.label")}>
        <BoyutAdimlayici d={d} keys={{ down: down.keysText, up: up.keysText }} />
        <Kbd keys={SIZE_KEYS.down} />
        <Kbd keys={SIZE_KEYS.up} />
      </PropRow>
      <PropRow label={t("stroke.label")}>
        <NumberStepper
          value={st}
          step={STROKE_STEP}
          // Etkin kontur 0'a inince incelme kapanır (bugünkü gibi).
          min={eff <= 0.005 ? st : -max}
          max={max}
          format={(v) => t("stroke.value", { v: strokeLabel(v) })}
          onChange={(v) => step(v, st, STROKE_STEP, d.stroke)}
          aria-label={t("stroke.label")}
          decreaseLabel={`${t("stroke.down")} · ${thin.keysText}`}
          increaseLabel={`${t("stroke.up")} · ${thick.keysText}`}
        />
        <Kbd keys={STROKE_KEYS.down} />
        <Kbd keys={STROKE_KEYS.up} />
      </PropRow>
    </PanelSection>
  );
}

/** Seçimin boyutu (− %100 +). `keys`: düğme adlarına eklenen kısayol ("Küçült (%2) · -"). */
export function BoyutAdimlayici({ d, keys }: { d: Duzelt; keys?: { down: string; up: string } }) {
  const { t } = useTranslation("adjust");
  const sc = selectionScale(d.cur, d.sel);
  const withKey = (label: string, k?: string) => (k ? `${label} · ${k}` : label);
  return (
    <NumberStepper
      value={sc}
      step={SCALE_STEP}
      min={d.model.limits.scaleMin}
      max={d.model.limits.scaleMax}
      format={scaleLabel}
      onChange={(v) => {
        if (v !== sc) d.scale(Math.sign(v - sc) * SCALE_STEP);
      }}
      aria-label={t("size.label")}
      decreaseLabel={withKey(t("size.down"), keys?.down)}
      increaseLabel={withKey(t("size.up"), keys?.up)}
    />
  );
}

function HedefGrubu({ d }: { d: Duzelt }) {
  const { t } = useTranslation("adjust");
  const options = centerTargets(d.model.centers);
  const current = options.find((o) => o.value === d.target)?.label;
  return (
    <CollapsedGroup title={t("target.heading")} summary={current}>
      <div className="dz-group">
        <Select<CenterTarget> value={d.target} options={options} onChange={d.setTarget} aria-label={t("target.heading")} />
      </div>
    </CollapsedGroup>
  );
}
