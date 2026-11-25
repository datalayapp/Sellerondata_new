import { TEMPLATE_CUT_SHAPES, type Shape, type TemplateCut } from "@tagpress/domain";
import { type ReactNode, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMm, formatNumber, intlLocale } from "../../i18n/bicim.ts";
import { serverText } from "../../i18n/sunucu.ts";
import { centerSource, type DecorationSettings, FIELD_LABELS, SOURCE_LABELS } from "./mantik/draft.ts";
import { aspectCheck, cutFor, cutWith } from "./mantik/editor.ts";
import { isUnsupported } from "./mantik/endpoints.ts";
import { cutDiameterOf, toPct, toPolygon } from "./mantik/shapeMath.ts";
import {
  Button,
  CollapsedGroup,
  Field,
  IconButton,
  IssueBox,
  Menu,
  NumberStepper,
  Panel,
  PanelSection,
  PropRow,
  Segmented,
  Select,
  Switch,
  TextArea,
  TextField,
  Tooltip,
} from "../../tezgah/index.ts";
import { cutShapeLabel, cutSizeText, kindLabel, unsupportedText } from "./metin.ts";
import type { Sablon } from "./useSablon.ts";

const pct = (v: number) => `%${formatNumber(v)}`;
const mmText = (v: number) => `${formatMm(v, 2)} mm`;

/**
 * Açıklama panelde paragraf olarak durmaz, denetimin ipucunda görünür ("Açıklama metni yok; gerekirse ipucunda").
 * Sarmalayıcı kutu olur (ipucu ona tutunur); içteki denetim odak alınca da ipucu açılır.
 */
function Ipucu({ text, children }: { text: string; children: ReactNode }) {
  return (
    <Tooltip content={text}>
      <div className="sb-tip">{children}</div>
    </Tooltip>
  );
}

/**
 * Sağ panel: yazı alanı (kip, otomatik öneri, noktalarla düzenleme, alanın tamamı), kurdele, hedef merkez, kesim
 * (şekil ve mm); kapalı gruplarda şablon bilgisi, dekor ayarları, değişiklik geçmişi. Altta Geri al ve Kaydet.
 */
export function SagPanel({
  s,
  templateKey,
  area,
  selVertex,
  onMode,
  onArea,
  onAddVertex,
  onRemoveVertex,
}: {
  s: Sablon;
  templateKey: string;
  area: Shape | null;
  selVertex: number | null;
  onMode(mode: "auto" | "manual"): void;
  onArea(shape: Shape): void;
  onAddVertex(): void;
  onRemoveVertex(): void;
}) {
  const { t } = useTranslation("templates");
  const { eff, item } = s;
  const manual = eff.area.mode === "manual";
  const cut = eff.cut;
  return (
    <Panel
      side="right"
      title={
        <>
          <span className="tz-mono">{templateKey}</span> · {kindLabel(eff.kind)}
        </>
      }
      count={cut ? <span className="tz-mono">{cutSizeText(cut)}</span> : undefined}
      actions={
        <Menu
          align="end"
          trigger={(p) => <IconButton {...p} icon="dots" size={28} label={t("panel.more")} />}
          items={[{ label: t("panel.revertAll"), icon: "reset", disabled: !s.dirty, onSelect: s.revertAll }]}
        />
      }
      footer={
        <div className="sb-foot">
          <Button size="page" variant="quiet" command="sablonlar.undo" kbd={false} disabled={!s.canUndo || s.saving} onClick={s.undo}>
            {t("panel.undo")}
          </Button>
          <Button need="edit" size="page" variant="primary" command="sablonlar.save" disabled={!s.dirty} loading={s.saving} onClick={() => void s.doSave()}>
            {t("panel.save")}
          </Button>
        </div>
      }
    >
      {s.restored && (
        <div className="sb-pad">
          <IssueBox tone="warn">
            <b>{t("notice.restoredTitle")}</b> {t("notice.restoredBody", { fields: s.labels.join(", ") })}
          </IssueBox>
        </div>
      )}
      {item?.fileMissing && (
        <div className="sb-pad">
          <IssueBox tone="error">
            <b>{t("notice.missingTitle")}</b> {t("notice.missingBody")}
          </IssueBox>
        </div>
      )}
      <AlanBolumu s={s} manual={manual} area={area} selVertex={selVertex} onMode={onMode} onArea={onArea} onAddVertex={onAddVertex} onRemoveVertex={onRemoveVertex} />
      <KurdeleHedefBolumu s={s} />
      <KesimBolumu s={s} cut={cut} />
      <BilgiGrubu s={s} />
      <DekorGrubu s={s} />
      <GecmisGrubu s={s} />
    </Panel>
  );
}

function AlanBolumu({
  s,
  manual,
  area,
  selVertex,
  onMode,
  onArea,
  onAddVertex,
  onRemoveVertex,
}: {
  s: Sablon;
  manual: boolean;
  area: Shape | null;
  selVertex: number | null;
  onMode(mode: "auto" | "manual"): void;
  onArea(shape: Shape): void;
  onAddVertex(): void;
  onRemoveVertex(): void;
}) {
  const { t } = useTranslation("templates");
  const hintId = useId();
  const fullId = useId();
  const { suggest, ghost } = s;
  return (
    <PanelSection heading={t("area.heading")}>
      <Ipucu text={manual ? t("area.manualHint") : t("area.autoHint")}>
        <Segmented
          aria-label={t("area.mode")}
          value={s.eff.area.mode}
          onChange={onMode}
          options={[
            { value: "auto", label: t("area.auto") },
            { value: "manual", label: t("area.manual") },
          ]}
        />
      </Ipucu>
      <div className="sb-row">
        <Button size="mini" icon="spark" loading={suggest.isPending} onClick={() => suggest.mutate()}>
          {t("area.suggest")}
        </Button>
        {manual && area && area.kind !== "polygon" && (
          <Button variant="link" onClick={() => onArea(toPolygon(area))}>
            {t("area.toPoints")}
          </Button>
        )}
        {manual && area?.kind === "polygon" && (
          <>
            <Button size="mini" icon="plus" title={t("area.pointsHint")} onClick={onAddVertex}>
              {t("area.addPoint")}
            </Button>
            <Button size="mini" icon="trash" command="sablonlar.deleteVertex" kbd={false} disabled={selVertex === null || area.points.length <= 3} onClick={onRemoveVertex}>
              {t("area.removePoint")}
            </Button>
          </>
        )}
      </div>
      {suggest.isError &&
        (isUnsupported(suggest.error) ? (
          <IssueBox tone="info">
            <b>{t("area.suggestMissing")}</b> {unsupportedText()}
          </IssueBox>
        ) : (
          <IssueBox tone="error">
            <b>{t("area.suggestFailed")}</b> {serverText(suggest.error)}
          </IssueBox>
        ))}
      {ghost && (
        <IssueBox
          tone="info"
          fixes={
            <>
              <Button size="mini" onClick={() => onArea(ghost)}>
                {t("area.apply")}
              </Button>
              <Button size="mini" variant="quiet" onClick={() => s.setGhost(null)}>
                {t("area.dismiss")}
              </Button>
            </>
          }
        >
          <b>{t("area.ghostTitle")}</b> {t("area.ghostBody")}
        </IssueBox>
      )}
      <Ipucu text={manual ? t("area.fullAreaHint") : t("area.fullAreaManualOnly")}>
        <div className="sb-switch">
          <Switch id={fullId} checked={s.eff.ignoreDecorationInArea} disabled={!manual} label={t("area.fullArea")} aria-describedby={hintId} onChange={(v) => s.set("ignoreDecorationInArea", v)} />
          <label htmlFor={fullId}>{t("area.fullArea")}</label>
          <span className="tz-sr" id={hintId}>
            {manual ? t("area.fullAreaHint") : t("area.fullAreaManualOnly")}
          </span>
        </div>
      </Ipucu>
    </PanelSection>
  );
}

/** Kurdele ve hedef merkez tek bölümde: iki satır ve "Alan merkezine döndür" bağlantısı. Kaynak bilgisi ipucunda. */
function KurdeleHedefBolumu({ s }: { s: Sablon }) {
  const { t } = useTranslation("templates");
  const closedMm = s.eff.ribbonTop * cutDiameterOf(s.scale.cutPx) * s.scale.mmPerPx;
  const target = s.eff.textCenter;
  const edited = "textCenter" in s.patch;
  const src = s.item ? centerSource({ ...s.item.template, textCenter: s.orig.textCenter }) : null;
  const note = !edited && src && (src.source === "measured" || src.source === "learned") ? (src.source === "learned" ? t("center.learnedNote") : t("center.measuredNote")) : null;
  const sourceText = edited ? t("center.editedSource") : src ? (src.samples ? t("center.sourceSamples", { label: src.label, n: src.samples }) : src.label) : t("center.unknown");
  return (
    <PanelSection>
      <Ipucu text={t("ribbon.hint")}>
        <PropRow label={t("ribbon.label")}>
          <NumberStepper
            aria-label={t("ribbon.aria")}
            value={Math.round(s.eff.ribbonTop * 100)}
            step={1}
            min={0}
            max={60}
            format={pct}
            onChange={(v) => s.set("ribbonTop", v / 100, "ribbonTop")}
          />
          <span className="sb-aside tz-mono">{t("ribbon.closed", { mm: formatMm(closedMm) })}</span>
        </PropRow>
      </Ipucu>
      {target ? (
        <>
          <Ipucu text={[`${t("center.source")}: ${sourceText}.`, note].filter(Boolean).join(" ")}>
            <PropRow label={t("center.label")}>
              <span className="sb-val tz-mono">{t("center.xy", { x: formatNumber(toPct(target.x)), y: formatNumber(toPct(target.y)) })}</span>
            </PropRow>
          </Ipucu>
          <div>
            <Button variant="link" onClick={() => s.set("textCenter", null)}>
              {t("center.reset")}
            </Button>
          </div>
        </>
      ) : (
        <Ipucu text={t("center.unset")}>
          <PropRow label={t("center.label")}>
            <span className="sb-val">{t("center.unsetValue")}</span>
          </PropRow>
        </Ipucu>
      )}
    </PanelSection>
  );
}

type CutChoice = TemplateCut["shape"] | "inherit";

function KesimBolumu({ s, cut }: { s: Sablon; cut: TemplateCut | null }) {
  const { t } = useTranslation("templates");
  const tpl = s.item?.template;
  const aspect = aspectCheck(tpl && tpl.width && tpl.height ? { w: tpl.width, h: tpl.height } : null, cut);
  const setCut = (patch: Partial<TemplateCut>) => cut && s.set("cut", cutWith(cut, patch), "cut");
  const size = (label: string, value: number, patch: (v: number) => Partial<TemplateCut>, min = 1) => (
    <PropRow label={label}>
      <NumberStepper editable aria-label={label} value={value} step={0.5} min={min} max={1000} format={mmText} onChange={(v) => setCut(patch(v))} />
    </PropRow>
  );
  return (
    <>
      <CollapsedGroup title={t("cut.heading")} summary={cut ? cutSizeText(cut) : cutShapeLabel("inherit")} persistKey="sablonlar.kesim">
        <div className="sb-group">
          <Ipucu text={t("cut.hint")}>
            <PropRow label={t("cut.shape")}>
              <Select<CutChoice>
                aria-label={t("cut.shape")}
                value={cut?.shape ?? "inherit"}
                options={(["inherit", ...TEMPLATE_CUT_SHAPES] as CutChoice[]).map((v) => ({ value: v, label: cutShapeLabel(v) }))}
                onChange={(v) => s.set("cut", v === "inherit" ? null : cutFor(v, cut))}
              />
            </PropRow>
          </Ipucu>
          {cut &&
            (cut.shape === "circle"
              ? size(t("cut.diameter"), cut.wMm, (v) => ({ wMm: v }))
              : (
                  <>
                    {size(t("cut.width"), cut.wMm, (v) => ({ wMm: v }))}
                    {size(t("cut.height"), cut.hMm, (v) => ({ hMm: v }))}
                  </>
                ))}
          {cut?.shape === "roundRect" && size(t("cut.radius"), cut.radiusMm, (v) => ({ radiusMm: v }), 0)}
        </div>
      </CollapsedGroup>
      {aspect && !aspect.ok && (
        <div className="sb-pad">
          <IssueBox tone="warn">
            <b>{t("cut.aspectTitle")}</b> {t("cut.aspectBody", { image: formatNumber(aspect.image, { maximumFractionDigits: 2 }), cut: formatNumber(aspect.cut, { maximumFractionDigits: 2 }) })}
          </IssueBox>
        </div>
      )}
    </>
  );
}

function BilgiGrubu({ s }: { s: Sablon }) {
  const { t } = useTranslation("templates");
  const printedId = useId();
  const e = s.eff;
  const summary = `${e.printedText ? t("info.printedYes") : t("info.printedNo")} · ${t("info.tagCount", { count: e.tags.length })}`;
  return (
    <CollapsedGroup title={t("info.heading")} summary={summary} persistKey="sablonlar.bilgi">
      <div className="sb-group">
        <Ipucu text={t("info.printedHint")}>
          <div className="sb-switch">
            <Switch id={printedId} checked={e.printedText} label={t("info.printed")} aria-describedby={`${printedId}-h`} onChange={(v) => s.set("printedText", v)} />
            <label htmlFor={printedId}>{t("info.printed")}</label>
            <span className="tz-sr" id={`${printedId}-h`}>
              {t("info.printedHint")}
            </span>
          </div>
        </Ipucu>
        <Field label={t("info.notes")} hint={t("info.notesHint")}>
          <TextArea value={e.notes} rows={3} onChange={(v) => s.set("notes", v, "notes")} />
        </Field>
        <TagEditor tags={e.tags} onChange={(v) => s.set("tags", v)} />
      </div>
    </CollapsedGroup>
  );
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange(t: string[]): void }) {
  const { t } = useTranslation("templates");
  const [text, setText] = useState("");
  const add = () => {
    const parts = text
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (!parts.length) return;
    onChange([...tags, ...parts.filter((p) => !tags.includes(p))]);
    setText("");
  };
  return (
    <div className="sb-tags">
      {tags.length > 0 && (
        <div className="sb-chips">
          {tags.map((tg) => (
            <span key={tg} className="sb-chip">
              {tg}
              <IconButton icon="x" size={26} label={t("info.removeTag", { tag: tg })} onClick={() => onChange(tags.filter((x) => x !== tg))} />
            </span>
          ))}
        </div>
      )}
      <Field label={t("info.tags")} hint={t("info.tagsHint")}>
        <TextField
          value={text}
          placeholder={t("info.addTag")}
          onChange={setText}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !text && tags.length) onChange(tags.slice(0, -1));
          }}
          onBlur={add}
        />
      </Field>
    </div>
  );
}

function DekorGrubu({ s }: { s: Sablon }) {
  const { t } = useTranslation("templates");
  const d = s.eff.decoration;
  const sourceLabel = (v: DecorationSettings["source"]) => t(`decor.sources.${v}`);
  return (
    <CollapsedGroup title={t("decor.heading")} summary={sourceLabel(d.source)} persistKey="sablonlar.dekor">
      <div className="sb-group">
        <Ipucu text={t("decor.hint")}>
          <Field label={t("decor.source")} hint={t("decor.sourceHint")}>
            <Select<DecorationSettings["source"]> value={d.source} options={(["auto", "alpha", "color"] as const).map((v) => ({ value: v, label: t(`decor.sourceOptions.${v}`) }))} onChange={(v) => s.setDec("source", v)} />
          </Field>
        </Ipucu>
        <Ipucu text={t("decor.thresholdHint")}>
          <PropRow label={t("decor.threshold")}>
            <NumberStepper aria-label={t("decor.threshold")} value={d.threshold} step={1} min={1} max={80} format={(v) => formatNumber(v)} onChange={(v) => s.setDec("threshold", v, "threshold")} />
          </PropRow>
        </Ipucu>
        <Ipucu text={t("decor.dilateHint")}>
          <PropRow label={t("decor.dilate")}>
            <NumberStepper aria-label={t("decor.dilate")} value={d.dilatePx} step={1} min={0} max={40} format={(v) => t("decor.px", { n: formatNumber(v) })} onChange={(v) => s.setDec("dilatePx", v, "dilatePx")} />
          </PropRow>
        </Ipucu>
        {s.item?.template.kind !== "generated" && (
          <Field label={t("decor.kind")}>
            <Segmented
              value={s.eff.kind === "sticker" ? "sticker" : "label"}
              onChange={(v) => s.set("kind", v)}
              options={[
                { value: "label", label: kindLabel("label") },
                { value: "sticker", label: kindLabel("sticker") },
              ]}
            />
          </Field>
        )}
      </div>
    </CollapsedGroup>
  );
}

function GecmisGrubu({ s }: { s: Sablon }) {
  const { t } = useTranslation("templates");
  const tpl = s.item?.template;
  const rows = tpl?.provenance ?? [];
  return (
    <CollapsedGroup title={t("history.heading")} summary={<span className="tz-mono">{rows.length}</span>} persistKey="sablonlar.gecmis">
      <div className="sb-group">
        {!rows.length ? (
          <p className="sb-note">{t("history.empty")}</p>
        ) : (
          <ul className="sb-hist">
            {[...rows].reverse().map((p, i) => (
              <li key={i}>
                <b>{FIELD_LABELS[p.field] ?? p.field}</b>
                <span>{SOURCE_LABELS[p.source] ?? p.source}</span>
                {p.samples !== undefined && <span className="tz-mono">{t("history.samples", { n: p.samples })}</span>}
                <span className="sb-hist-at tz-mono">{dateText(p.at)}</span>
              </li>
            ))}
          </ul>
        )}
        {tpl?.generatedFrom && (
          <p className="sb-note">
            {t("history.generated", { date: dateText(tpl.generatedFrom.at), prompt: tpl.generatedFrom.prompt })}
          </p>
        )}
      </div>
    </CollapsedGroup>
  );
}

function dateText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(intlLocale(), { day: "numeric", month: "short", year: "numeric" });
}
