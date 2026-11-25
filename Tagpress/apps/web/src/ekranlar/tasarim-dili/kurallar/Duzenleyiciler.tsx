import { API, type FontEntry, type FontList, type FontRole, type GlyphRule, type LabelSize, type Profile, type Shape, type StickerSheet } from "@tagpress/domain";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, path } from "../../../lib/api.ts";
import { describeGlyphRule } from "../mantik/describe.ts";
import { Button, Field, IconButton, Menu, NumberStepper, PropRow, Segmented, Select, Switch, TextArea, TextField } from "../../../tezgah/index.ts";
import { num, pct } from "../dil.ts";
import { Yazi } from "../Yazi.tsx";
import { Cipler, type Hata, Hatalar, IsteBagliSayi, Kutu, Onay, SatirAlani, Sayi } from "./Parcalar.tsx";

/** Özel düzenleyiciler (font listesi, özel karakterler, çipler…). Sağ paneldeki dar sütuna göre alt alta dizilir. */
export interface DuzenleyiciProps<T> {
  value: T;
  onChange: (v: T) => void;
  profile: Profile;
  languageId: string;
  /** Bu alana (ya da altındaki bir yola) ait hata iletileri. */
  errors: Hata[];
  /** Hata yolunu eşleştirmek için alanın kendi yolu. */
  fieldPath: string;
  /** Alanın görünen adı (erişilebilir ad olarak). */
  label: string;
}

/** Yeni kayıtlar için kısa, çakışmayan kimlik. */
function newId(prefix: string, taken: string[]): string {
  let i = taken.length + 1;
  while (taken.includes(`${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

const sub = (errors: Hata[], p: string) => errors.filter((e) => e.path.startsWith(p));

// ---------------------------------------------------------------- font listesi

const KINDS: FontEntry["kind"][] = ["script", "serif", "sans", "display"];
const ROLES: FontRole[] = ["primary", "secondary", "accent"];

export function FontlarDuzenleyici({ value, onChange, languageId, errors, fieldPath }: DuzenleyiciProps<FontEntry[]>) {
  const { t } = useTranslation("designLanguage");
  const files = useQuery({
    queryKey: ["fonts", languageId],
    queryFn: () => api.get<FontList>(path(API.fonts, { lang: languageId })),
    retry: false,
  });
  const used = new Set(value.map((f) => f.file).filter(Boolean));
  const available = (files.data?.files ?? []).filter((f) => !used.has(f.file));
  const missing = new Set((files.data?.missing ?? []).map((m) => m.fontId));
  const set = (i: number, patch: Partial<FontEntry>) => onChange(value.map((f, k) => (k === i ? { ...f, ...patch } : f)));

  return (
    <div className="td-ed">
      {value.length === 0 && <p className="td-ed-bos">{t("editors.fonts.empty")}</p>}
      <ul className="td-ed-liste">
        {value.map((f, i) => (
          <Kutu key={f.id + i} kapali={!f.enabled}>
            <Yazi languageId={languageId} file={f.file} text={`${f.family} Aa 123 &`} height={44} />
            <p className="td-ed-ad">
              <b>{f.family}</b> <span>{f.style}</span>
            </p>
            <p className="td-ed-mono" title={f.id}>
              {f.file ?? f.id}
            </p>
            {missing.has(f.id) && <p className="td-ed-uyari">{t("editors.fonts.missing")}</p>}
            <PropRow label={t("editors.fonts.kind")}>
              <Select<FontEntry["kind"]> value={f.kind} options={KINDS.map((k) => ({ value: k, label: t(`editors.fonts.kinds.${k}`) }))} aria-label={t("editors.fonts.kind")} onChange={(kind) => set(i, { kind })} />
            </PropRow>
            <Field label={t("editors.fonts.roles")}>
              <div role="group" aria-label={t("editors.fonts.rolesOf", { font: f.family })} className="td-onaylar">
                {ROLES.map((r) => (
                  <Onay key={r} checked={f.roles.includes(r)} label={t(`editors.fonts.role.${r}`)} onChange={(on) => set(i, { roles: on ? [...f.roles, r] : f.roles.filter((x) => x !== r) })} />
                ))}
              </div>
            </Field>
            <PropRow label={t("editors.fonts.upperRun")}>
              <IsteBagliSayi
                value={f.maxUppercaseRun}
                step={1}
                min={1}
                max={50}
                label={t("editors.fonts.upperRunOf", { font: f.family })}
                emptyLabel={t("editors.fonts.noLimit")}
                setLabel={t("editors.fonts.setLimit")}
                clearLabel={t("editors.fonts.clearLimit")}
                initial={3}
                onChange={(v) => set(i, { maxUppercaseRun: v === null ? null : Math.max(1, Math.round(v)) })}
              />
            </PropRow>
            <Field label={t("editors.fonts.note")}>
              <TextField value={f.note} placeholder={t("editors.fonts.notePlaceholder")} onChange={(note) => set(i, { note })} />
            </Field>
            <PropRow label={t("editors.fonts.lockTracking")}>
              <Switch checked={f.lockTracking} label={t("editors.fonts.lockTracking")} onChange={(lockTracking) => set(i, { lockTracking })} />
            </PropRow>
            <PropRow label={t("editors.fonts.inUse")}>
              <Switch checked={f.enabled} label={t("editors.fonts.inUseOf", { font: f.family })} onChange={(enabled) => set(i, { enabled })} />
            </PropRow>
            <Button size="mini" variant="quiet" icon="trash" onClick={() => onChange(value.filter((_, k) => k !== i))} aria-label={t("editors.fonts.remove", { font: f.family })}>
              {t("editors.remove")}
            </Button>
          </Kutu>
        ))}
      </ul>
      <div className="td-ed-ekle">
        <Menu
          align="start"
          trigger={(p) => (
            <Button {...p} size="mini" icon="plus" disabled={available.length === 0}>
              {t("editors.fonts.add")}
            </Button>
          )}
          items={available.map((a) => ({
            label: `${a.family ?? a.file} ${a.style ?? ""}`.trim(),
            onSelect: () => {
              const family = a.family ?? a.file.replace(/\.[^.]+$/, "");
              const style = a.style ?? "Regular";
              onChange([...value, { id: `${family}/${style}`, family, style, file: a.file, kind: "sans", roles: [], enabled: true, maxUppercaseRun: null, lockTracking: false, note: "" }]);
            },
          }))}
        />
        {files.isError ? <span className="td-soluk">{t("editors.fonts.loadFailed")}</span> : available.length === 0 && !files.isLoading ? <span className="td-soluk">{t("editors.fonts.noneToAdd")}</span> : null}
      </div>
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

// ---------------------------------------------------------------- özel karakter kuralları

type MatchType = GlyphRule["match"]["type"];
const MATCHES: MatchType[] = ["chars", "word-initial-upper", "line-initial-upper", "digits"];

function withMatch(type: MatchType, prev: GlyphRule["match"]): GlyphRule["match"] {
  if (type === prev.type) return prev;
  const text = prev.type === "chars" ? prev.chars : prev.type === "digits" ? "" : prev.letters;
  switch (type) {
    case "chars":
      return { type, chars: text || "&" };
    case "word-initial-upper":
    case "line-initial-upper":
      return { type, letters: text };
    case "digits":
      return { type };
  }
}

export function OzelKarakterDuzenleyici({ value, onChange, profile, languageId, errors, fieldPath }: DuzenleyiciProps<GlyphRule[]>) {
  const { t } = useTranslation("designLanguage");
  const fonts = profile.fonts.list;
  const set = (i: number, patch: Partial<GlyphRule>) => onChange(value.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= value.length) return;
    const next = [...value];
    [next[i], next[j]] = [next[j] as GlyphRule, next[i] as GlyphRule];
    onChange(next);
  };

  return (
    <div className="td-ed">
      {value.length === 0 && <p className="td-ed-bos">{t("editors.glyphs.empty")}</p>}
      <ul className="td-ed-liste">
        {value.map((r, i) => {
          const font = fonts.find((f) => f.id === r.fontId);
          const sample = r.match.type === "chars" ? r.match.chars : r.match.type === "digits" ? "0123456789" : r.match.letters || "AM";
          return (
            <Kutu key={r.id} kapali={!r.enabled}>
              <Yazi languageId={languageId} file={font?.file} text={sample} height={40} />
              <p className="td-ed-not">{describeGlyphRule(profile, r)}</p>
              <div className="td-ed-arac">
                <Switch checked={r.enabled} label={t("editors.glyphs.enabled")} onChange={(enabled) => set(i, { enabled })} />
                <span className="td-ed-bosluk" />
                <IconButton icon="up" size={26} label={t("editors.glyphs.moveUp")} disabled={i === 0} onClick={() => move(i, -1)} />
                <IconButton icon="chev" size={26} label={t("editors.glyphs.moveDown")} disabled={i === value.length - 1} onClick={() => move(i, 1)} />
                <IconButton icon="trash" size={26} label={t("editors.glyphs.remove")} onClick={() => onChange(value.filter((_, k) => k !== i))} />
              </div>
              <PropRow label={t("editors.glyphs.which")}>
                <Select<MatchType> value={r.match.type} options={MATCHES.map((m) => ({ value: m, label: t(`editors.glyphs.match.${m}`) }))} aria-label={t("editors.glyphs.which")} onChange={(m) => set(i, { match: withMatch(m, r.match) })} />
              </PropRow>
              {r.match.type !== "digits" && (
                <Field label={r.match.type === "chars" ? t("editors.glyphs.chars") : t("editors.glyphs.letters")}>
                  <TextField
                    value={r.match.type === "chars" ? r.match.chars : r.match.letters}
                    placeholder={r.match.type === "chars" ? "&" : "A M"}
                    onChange={(v) => set(i, { match: r.match.type === "chars" ? { type: "chars", chars: v } : { type: r.match.type, letters: v.replace(/\s/g, "") } })}
                  />
                </Field>
              )}
              <PropRow label={t("editors.glyphs.font")}>
                <Select<string>
                  value={r.fontId}
                  aria-label={t("editors.glyphs.font")}
                  options={[...(font ? [] : [{ value: r.fontId, label: r.fontId || t("editors.glyphs.choose") }]), ...fonts.map((f) => ({ value: f.id, label: `${f.family} ${f.style !== "Regular" ? f.style : ""}`.trim() }))]}
                  onChange={(fontId) => set(i, { fontId })}
                />
              </PropRow>
              <PropRow label={t("editors.glyphs.scale")}>
                <Sayi value={r.scale} step={0.05} min={0.1} max={5} unit="×" label={t("editors.glyphs.scale")} onChange={(scale) => set(i, { scale: scale > 0 ? scale : 1 })} />
              </PropRow>
              <PropRow label={t("editors.glyphs.shift")}>
                <Sayi value={r.baselineShiftEm} step={0.01} min={-2} max={2} unit="em" label={t("editors.glyphs.shift")} onChange={(baselineShiftEm) => set(i, { baselineShiftEm })} />
              </PropRow>
              <Field label={t("editors.glyphs.onlyWith")}>
                <div role="group" aria-label={t("editors.glyphs.onlyWith")} className="td-onaylar">
                  {fonts.map((f) => (
                    <Onay key={f.id} checked={r.onlyWithFonts.includes(f.id)} label={f.family} onChange={(on) => set(i, { onlyWithFonts: on ? [...r.onlyWithFonts, f.id] : r.onlyWithFonts.filter((x) => x !== f.id) })} />
                  ))}
                  {fonts.length === 0 && <span className="td-soluk">{t("editors.glyphs.needFonts")}</span>}
                </div>
              </Field>
              <Hatalar errors={sub(errors, `${fieldPath}.${i}`)} />
            </Kutu>
          );
        })}
      </ul>
      <div className="td-ed-ekle">
        <Button
          size="mini"
          icon="plus"
          disabled={fonts.length === 0}
          title={fonts.length === 0 ? t("editors.glyphs.needFonts") : undefined}
          onClick={() =>
            onChange([
              ...value,
              { id: newId("kural-", value.map((r) => r.id)), label: "", match: { type: "chars", chars: "&" }, fontId: fonts[0]?.id ?? "", scale: 1, baselineShiftEm: 0, onlyWithFonts: [], enabled: true },
            ])
          }
        >
          {t("editors.glyphs.add")}
        </Button>
      </div>
      <Hatalar errors={errors.filter((e) => e.path === fieldPath)} />
    </div>
  );
}

// ---------------------------------------------------------------- çip listesi (bağlaçlar, tek başına olamayanlar)

export function CipDuzenleyici({ value, onChange, errors, fieldPath, label }: DuzenleyiciProps<string[]>) {
  const { t } = useTranslation("designLanguage");
  return (
    <div className="td-ed">
      <Cipler value={value} onChange={onChange} label={label} placeholder={t("editors.chips.placeholder")} />
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

// ---------------------------------------------------------------- bağlaca özel oranlar

export function BaglacOranDuzenleyici({ value, onChange, errors, fieldPath }: DuzenleyiciProps<Record<string, number>>) {
  const { t } = useTranslation("designLanguage");
  const [word, setWord] = useState("");
  const entries = Object.entries(value);
  const add = () => {
    const w = word.trim().toLocaleLowerCase();
    if (!w || w in value) return;
    onChange({ ...value, [w]: 0.5 });
    setWord("");
  };
  return (
    <div className="td-ed">
      {entries.length > 0 && (
        <ul className="td-ed-liste">
          {entries.map(([w, s]) => (
            <Kutu key={w}>
              <PropRow label={w}>
                <span className="td-istebagli">
                  <NumberStepper value={s} step={0.01} min={0.05} max={2} aria-label={t("editors.scales.ratioOf", { word: w })} format={pct} onChange={(v) => onChange({ ...value, [w]: v })} />
                  <IconButton
                    icon="trash"
                    size={26}
                    label={t("editors.scales.remove", { word: w })}
                    onClick={() => {
                      const { [w]: _, ...rest } = value;
                      onChange(rest);
                    }}
                  />
                </span>
              </PropRow>
            </Kutu>
          ))}
        </ul>
      )}
      <div className="td-ed-ekle">
        <TextField
          value={word}
          placeholder={t("editors.scales.placeholder")}
          aria-label={t("editors.scales.wordLabel")}
          onChange={setWord}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button size="mini" icon="plus" disabled={!word.trim()} onClick={add}>
          {t("editors.scales.add")}
        </Button>
      </div>
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

// ---------------------------------------------------------------- tipik satır sayısı (en az – en çok)

export function CiftDuzenleyici({ value, onChange, errors, fieldPath }: DuzenleyiciProps<[number, number]>) {
  const { t } = useTranslation("designLanguage");
  const fmt = (v: number) => t("editors.pair.lines", { n: v });
  return (
    <div className="td-ed">
      <PropRow label={t("editors.pair.min")}>
        <NumberStepper value={value[0]} step={1} min={1} max={20} aria-label={t("editors.pair.min")} format={fmt} onChange={(v) => onChange([Math.round(v), value[1]])} />
      </PropRow>
      <PropRow label={t("editors.pair.max")}>
        <NumberStepper value={value[1]} step={1} min={1} max={20} aria-label={t("editors.pair.max")} format={fmt} onChange={(v) => onChange([value[0], Math.round(v)])} />
      </PropRow>
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

// ---------------------------------------------------------------- örnek bölmeler (metin → satırlar)

export function OrnekDuzenleyici({ value, onChange, errors, fieldPath }: DuzenleyiciProps<Array<{ text: string; lines: string[] }>>) {
  const { t } = useTranslation("designLanguage");
  return (
    <div className="td-ed">
      {value.length === 0 && <p className="td-ed-bos">{t("editors.examples.empty")}</p>}
      <ul className="td-ed-liste">
        {value.map((ex, i) => (
          <Kutu key={i}>
            <Field label={t("editors.examples.text")}>
              <TextArea rows={3} value={ex.text} onChange={(text) => onChange(value.map((x, k) => (k === i ? { ...x, text } : x)))} />
            </Field>
            <Field label={t("editors.examples.lines")}>
              <SatirAlani lines={ex.lines} label={t("editors.examples.linesLabel")} placeholder={t("editors.examples.linesPlaceholder")} onChange={(lines) => onChange(value.map((x, k) => (k === i ? { ...x, lines: lines.length ? lines : [""] } : x)))} />
            </Field>
            <Button size="mini" variant="quiet" icon="trash" onClick={() => onChange(value.filter((_, k) => k !== i))}>
              {t("editors.examples.remove")}
            </Button>
            <Hatalar errors={sub(errors, `${fieldPath}.${i}`)} />
          </Kutu>
        ))}
      </ul>
      <div className="td-ed-ekle">
        <Button size="mini" icon="plus" onClick={() => onChange([...value, { text: "", lines: [""] }])}>
          {t("editors.examples.add")}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- kesim şekli

const SHAPE_KINDS: Shape["kind"][] = ["circle", "ellipse", "rect", "polygon"];

function shapeOf(kind: Shape["kind"], prev: Shape): Shape {
  if (kind === prev.kind) return prev;
  const c = 220;
  switch (kind) {
    case "circle":
      return { kind, cx: c, cy: c, r: 200 };
    case "ellipse":
      return { kind, cx: c, cy: c, rx: 200, ry: 160 };
    case "rect":
      return { kind, x: 20, y: 20, w: 400, h: 400, radius: 0 };
    case "polygon":
      return { kind, points: [{ x: 220, y: 20 }, { x: 420, y: 380 }, { x: 20, y: 380 }] };
  }
}

export function KesimDuzenleyici({ value, onChange, errors, fieldPath, label }: DuzenleyiciProps<Shape>) {
  const { t } = useTranslation("designLanguage");
  const n = (key: string, v: number, min?: number) => {
    const name = t(`editors.cut.sub.${key}`);
    return (
      <PropRow label={name} key={key}>
        <Sayi value={v} step={1} min={min} unit="px" label={name} onChange={(x) => onChange({ ...value, [key]: x } as Shape)} />
      </PropRow>
    );
  };
  return (
    <div className="td-ed">
      <Segmented<Shape["kind"]> aria-label={label} value={value.kind} options={SHAPE_KINDS.map((k) => ({ value: k, label: t(`editors.cut.kinds.${k}`) }))} onChange={(k) => onChange(shapeOf(k, value))} />
      {value.kind === "circle" && [n("cx", value.cx), n("cy", value.cy), n("r", value.r, 1)]}
      {value.kind === "ellipse" && [n("cx", value.cx), n("cy", value.cy), n("rx", value.rx, 1), n("ry", value.ry, 1)]}
      {value.kind === "rect" && [n("x", value.x), n("y", value.y), n("w", value.w, 1), n("h", value.h, 1), n("radius", value.radius, 0)]}
      {value.kind === "polygon" && (
        <Field label={t("editors.cut.points")}>
          <NoktaAlani points={value.points} onChange={(points) => onChange({ kind: "polygon", points })} label={t("editors.cut.points")} />
        </Field>
      )}
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

function NoktaAlani({ points, onChange, label }: { points: Array<{ x: number; y: number }>; onChange: (p: Array<{ x: number; y: number }>) => void; label: string }) {
  const fmt = (p: typeof points) => p.map((q) => `${q.x}, ${q.y}`).join("\n");
  const parse = (s: string) =>
    s
      .split("\n")
      .map((l) => l.split(/[,;\s]+/).filter(Boolean).map(Number))
      .filter((a) => a.length === 2 && a.every((x) => Number.isFinite(x)))
      .map(([x, y]) => ({ x: x as number, y: y as number }));
  const [text, setText] = useState(fmt(points));
  useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(points)) setText(fmt(points));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnız dışarıdan gelen noktalar değişince eşitlenir; text eklenirse yazarken ham metin ezilir
  }, [points]);
  return (
    <TextArea
      rows={Math.max(3, points.length)}
      value={text}
      className="td-mono"
      aria-label={label}
      onChange={(v) => {
        setText(v);
        const p = parse(v);
        if (p.length >= 3) onChange(p);
      }}
    />
  );
}

// ---------------------------------------------------------------- şablonun yeri

export function KutuDuzenleyici({ value, onChange, errors, fieldPath }: DuzenleyiciProps<{ x: number; y: number; w: number; h: number }>) {
  const { t } = useTranslation("designLanguage");
  return (
    <div className="td-ed">
      {(["x", "y", "w", "h"] as const).map((key) => (
        <PropRow label={t(`editors.cut.sub.${key}`)} key={key}>
          <Sayi value={value[key]} step={1} unit="px" label={t(`editors.cut.sub.${key}`)} onChange={(v) => onChange({ ...value, [key]: v })} />
        </PropRow>
      ))}
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

// ---------------------------------------------------------------- etiket boyutları

export function BoyutDuzenleyici({ value, onChange, errors, fieldPath }: DuzenleyiciProps<LabelSize[]>) {
  const { t } = useTranslation("designLanguage");
  const set = (i: number, patch: Partial<LabelSize>) => onChange(value.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  return (
    <div className="td-ed">
      <ul className="td-ed-liste">
        {value.map((s, i) => (
          <Kutu key={i}>
            <Field label={t("editors.sizes.id")}>
              <TextField className="td-mono" value={s.id} onChange={(id) => set(i, { id })} />
            </Field>
            <PropRow label={t("editors.sizes.cm")}>
              <Sayi value={s.cm} step={0.1} min={0.1} unit="cm" label={t("editors.sizes.cm")} onChange={(cm) => set(i, { cm })} />
            </PropRow>
            <PropRow label={t("editors.sizes.frame")}>
              <Sayi value={s.framePx} step={1} min={1} unit="px" label={t("editors.sizes.frame")} onChange={(framePx) => set(i, { framePx })} />
            </PropRow>
            <Button size="mini" variant="quiet" icon="trash" disabled={value.length <= 1} onClick={() => onChange(value.filter((_, k) => k !== i))}>
              {t("editors.sizes.remove")}
            </Button>
          </Kutu>
        ))}
      </ul>
      <div className="td-ed-ekle">
        <Button size="mini" icon="plus" onClick={() => onChange([...value, { id: newId("", value.map((s) => s.id)), cm: 3, framePx: 400 }])}>
          {t("editors.sizes.add")}
        </Button>
      </div>
      <Hatalar errors={sub(errors, fieldPath)} />
    </div>
  );
}

export function VarsayilanBoyutDuzenleyici({ value, onChange, profile, label }: DuzenleyiciProps<string>) {
  const sizes = profile.output.sizes;
  const options = [...(sizes.some((s) => s.id === value) ? [] : [{ value, label: value }]), ...sizes.map((s) => ({ value: s.id, label: `${s.id} (${num(s.cm)} cm)` }))];
  return <Select<string> value={value} options={options} aria-label={label} onChange={onChange} />;
}

// ---------------------------------------------------------------- sticker sayfaları

type SheetNum = "maxW" | "maxH" | "slotW" | "slotH" | "gap" | "padding";

export function StickerDuzenleyici({ value, onChange, errors, fieldPath }: DuzenleyiciProps<StickerSheet[]>) {
  const { t } = useTranslation("designLanguage");
  const set = (i: number, patch: Partial<StickerSheet>) => onChange(value.map((s, k) => (k === i ? { ...s, ...patch } : s)));
  const alan = (i: number, s: StickerSheet, key: SheetNum, label: string, min: number) => (
    <PropRow label={label} key={key}>
      {/* Profil değeri pt (1/72 inç; eski Figma sayfasının "px"i), bkz. `StickerSheetSchema`. */}
      <Sayi value={s[key]} step={1} min={min} unit="pt" label={label} onChange={(v) => set(i, { [key]: v, ...(key === "maxW" && s.shape === "circle" ? { maxH: v } : {}) } as Partial<StickerSheet>)} />
    </PropRow>
  );
  return (
    <div className="td-ed">
      {value.length === 0 && <p className="td-ed-bos">{t("editors.sheets.empty")}</p>}
      <ul className="td-ed-liste">
        {value.map((s, i) => (
          <Kutu key={s.id}>
            <Field label={t("editors.sheets.name")}>
              <TextField value={s.frameName} onChange={(frameName) => set(i, { frameName })} />
            </Field>
            <Field label={t("editors.sheets.shape")}>
              <Segmented<StickerSheet["shape"]>
                aria-label={t("editors.sheets.shape")}
                value={s.shape}
                options={[
                  { value: "rect", label: t("editors.sheets.rect") },
                  { value: "circle", label: t("editors.sheets.circle") },
                ]}
                onChange={(shape) => set(i, { shape })}
              />
            </Field>
            <Field label={t("editors.sheets.keywords")}>
              <Cipler value={s.productKeywords} onChange={(productKeywords) => set(i, { productKeywords })} label={t("editors.sheets.keywordsLabel")} placeholder={t("editors.chips.placeholder")} />
            </Field>
            {alan(i, s, "maxW", s.shape === "circle" ? t("editors.sheets.diameter") : t("editors.sheets.maxW"), 1)}
            {s.shape !== "circle" && alan(i, s, "maxH", t("editors.sheets.maxH"), 1)}
            {alan(i, s, "slotW", t("editors.sheets.slotW"), 1)}
            {alan(i, s, "slotH", t("editors.sheets.slotH"), 1)}
            {alan(i, s, "gap", t("editors.sheets.gap"), 0)}
            {alan(i, s, "padding", t("editors.sheets.padding"), 0)}
            <Button size="mini" variant="quiet" icon="trash" onClick={() => onChange(value.filter((_, k) => k !== i))}>
              {t("editors.sheets.remove")}
            </Button>
            <Hatalar errors={sub(errors, `${fieldPath}.${i}`)} />
          </Kutu>
        ))}
      </ul>
      <div className="td-ed-ekle">
        <Button
          size="mini"
          icon="plus"
          onClick={() =>
            onChange([...value, { id: newId("sayfa-", value.map((s) => s.id)), frameName: "", productKeywords: [], shape: "rect", maxW: 100, maxH: 100, slotW: 120, slotH: 120, gap: 0, padding: 0 }])
          }
        >
          {t("editors.sheets.add")}
        </Button>
      </div>
    </div>
  );
}
