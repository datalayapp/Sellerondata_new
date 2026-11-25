import {
  FEATURE_KEYS,
  type FeatureKey,
  PAPER_SIZE_IDS,
  type PaperSizeId,
  SETUP_API,
  SETUP_CUTTERS,
  STICKER_DEFAULT_MM,
  type SetupAnswers,
  type SetupState,
} from "@tagpress/domain";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../../i18n/bicim.ts";
import { serverText } from "../../i18n/sunucu.ts";
import { api } from "../../lib/api.ts";
import { featureDictId, refreshOrg } from "../../lib/features.ts";
import { useLanguage } from "../../lib/language.tsx";
import type { EkranProps } from "../../lib/route.ts";
import { AppFrame, BandCard, Button, CollapsedGroup, cx, Field, FullBand, Icon, type IconName, IssueBox, NumberStepper, Segmented, Select, StepChips, Switch, useCommands, useToast } from "../../tezgah/index.ts";
import { featureRows, isPaid, toggleWithDeps, TYPE_ICON, TYPE_IDS, type TypeId } from "./ozellikler.ts";
import "./kisayollar.ts";
import "./kurulum.css";

const STEP_IDS = ["type", "language", "print"] as const;
const HEADINGS = {
  type: { title: "type.title", sub: "type.sub" },
  language: { title: "language.title", sub: "language.sub" },
  print: { title: "print.title", sub: "print.sub" },
} as const;
type Choice = NonNullable<SetupAnswers["language"]>["choice"];
type Print = NonNullable<SetupAnswers["print"]>;
type Cutter = (typeof SETUP_CUTTERS)[number];

/** Kağıt kimliği → Baskı masasındaki ad (`printDesk:paper.*`; ölçü adın içinde). */
const PAPER_LABEL: Record<PaperSizeId, string> = {
  a4: "printDesk:paper.a4",
  "a4-yatay": "printDesk:paper.a4Landscape",
  a3: "printDesk:paper.a3",
  a5: "printDesk:paper.a5",
  sra3: "printDesk:paper.sra3",
  letter: "printDesk:paper.letter",
};

/** Sorulmayan baskı cevaplarının başlangıcı (sunucunun varsayılanlarıyla aynı anlam: A4, düz kağıt, elle kesim). */
const PRINT_START: Print = { paperPreset: "a4", paperType: "plain", usesCutter: false };

const CHOICE_ICON: Record<Choice, IconName> = { build: "spark", default: "stamp" };

/**
 * Kurulum (kılavuzlu akış, SUNUCU-PLANI §3.2): 1. etiket türü ve açılacak özellikler (öneri `POST /api/setup/preview`),
 * 2. tasarım dili (oluştur ya da varsayılan), 3. baskı soruları. Her adım geçişinde cevaplar kaydedilir
 * (`PUT /api/setup/answers`; yarıda kalırsa kaldığı yerden sürer); "Bitir" `POST /api/setup/complete` ile onaylanan
 * özellikleri yazar. "Oluştur" seçildiyse bitince Oluştur ekranına (`#/tasarim-dili/olustur`), yoksa Üretim'e gider.
 */
export default function KurulumEkrani({ go }: EkranProps) {
  const { t } = useTranslation("setup");
  const qc = useQueryClient();
  const toast = useToast();
  const fail = (e: unknown) => toast({ message: serverText(e), tone: "error" });

  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<SetupAnswers>({ labelTypes: [] });
  /** Elle değiştirilmiş özellik durumu; tür seçimi değişince sıfırlanır (liste yeniden öneriyi gösterir). */
  const [manual, setManual] = useState<Record<FeatureKey, boolean> | null>(null);
  const touched = useRef(false);

  // Kayıtlı durum: yarıda kalan kurulum kaldığı adımdan, tamamlanmış kurulum (yeniden çalıştırma) eski cevaplarla açılır.
  const saved = useQuery({ queryKey: ["setup"], queryFn: () => api.get<SetupState>(SETUP_API.setupGet.path) });
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !saved.data) return;
    restored.current = true;
    if (touched.current) return;
    setAnswers(saved.data.answers);
    if (saved.data.status === "in-progress") setStep(saved.data.step - 1);
  }, [saved.data]);
  const rerun = saved.data?.status === "completed";

  const types = answers.labelTypes;
  const preview = useQuery({
    queryKey: ["setup", "preview", [...types].sort().join(",")],
    queryFn: () => api.post<{ features: Record<FeatureKey, boolean> }>(SETUP_API.preview.path, { answers: { labelTypes: types } }),
    placeholderData: keepPreviousData,
  });
  const features = manual ?? preview.data?.features;

  const { languages } = useLanguage();
  const defaultLanguage = languages.find((l) => l.isDefault);
  const builderOn = features?.["language.builder"] ?? true;
  const choice: Choice = builderOn ? (answers.language?.choice ?? "default") : "default";
  const print: Print = { ...PRINT_START, ...answers.print };

  const update = (a: Partial<SetupAnswers>) => {
    touched.current = true;
    setAnswers((x) => ({ ...x, ...a }));
  };
  const updatePrint = (p: Partial<Print>) => update({ print: { ...print, ...p } });

  const toggleType = (id: TypeId) => {
    const set = new Set(types);
    if (!set.delete(id)) set.add(id);
    update({ labelTypes: TYPE_IDS.filter((x) => set.has(x)) });
    setManual(null);
  };

  const fullAnswers = (): SetupAnswers => ({ ...answers, language: { choice }, print });
  const save = useMutation({
    mutationFn: (to: SetupState["step"]) => api.put<SetupState>(SETUP_API.answers.path, { step: to, answers: fullAnswers() }),
    onSuccess: (s) => qc.setQueryData(["setup"], s),
    onError: fail,
  });
  const complete = useMutation({
    mutationFn: () =>
      api.post<{ setup: SetupState; features: unknown }>(SETUP_API.complete.path, {
        answers: fullAnswers(),
        features: FEATURE_KEYS.filter((k) => features?.[k]),
      }),
    onSuccess: (r) => {
      qc.setQueryData(["setup"], r.setup);
      refreshOrg(qc);
      toast({ message: t("done"), tone: "success" });
      // Oluştur ekranının kurulumdan giriş adresi: seçilen türler ve yayından sonra dönülecek yer (Üretim).
      if (choice === "build") go("tasarim-dili", ["olustur"], { kurulum: "1", turler: types.join(","), don: "#/uretim" });
      else go("uretim");
    },
    onError: fail,
  });
  const skip = useMutation({
    mutationFn: () => api.post<{ setup: SetupState }>(SETUP_API.skip.path),
    onSuccess: (r) => {
      qc.setQueryData(["setup"], r.setup);
      refreshOrg(qc);
      go("uretim");
    },
    onError: fail,
  });

  const last = step === STEP_IDS.length - 1;
  const busy = complete.isPending || skip.isPending;
  const canNext = !busy && !!features;
  const next = () => {
    if (!canNext) return;
    if (last) complete.mutate();
    else {
      save.mutate((step + 2) as SetupState["step"]);
      setStep((s) => s + 1);
    }
  };
  useCommands("kurulum", { "kurulum.next": next });

  const steps = STEP_IDS.map((id) => t(`steps.${id}`));
  const id = STEP_IDS[step] ?? "type";
  const rows = featureRows();

  const featureRow = (k: FeatureKey) => {
    const on = features?.[k] ?? false;
    const name = t(`feat.${featureDictId(k)}.name`);
    return (
      <li key={k} className={cx("kr-ft", !on && "is-off")}>
        <span>
          <b>{name}</b>
          {isPaid(k) && <small>{t("features.paid")}</small>}
        </span>
        <Switch checked={on} disabled={!features} label={name} onChange={(v) => features && setManual(toggleWithDeps(features, k, v))} />
      </li>
    );
  };

  return (
    <AppFrame
      band="full"
      active={null}
      fullBand={
        <FullBand
          kicker={[{ label: t("kicker") }, { label: t("stepOf", { n: step + 1, total: STEP_IDS.length }) }]}
          title={t(HEADINGS[id].title)}
          sub={t(HEADINGS[id].sub)}
          aside={<StepChips steps={steps} current={step} />}
        />
      }
    >
      <BandCard
        footer={
          <>
            {step === 0 ? (
              <Button variant="quiet" size="guided" disabled={busy} onClick={() => (rerun ? go("uretim") : skip.mutate())}>
                {rerun ? t("cancel") : t("skip")}
              </Button>
            ) : (
              <Button variant="quiet" size="guided" icon="left" disabled={busy} onClick={() => setStep((s) => s - 1)}>
                {t("back")}
              </Button>
            )}
            <span className="kr-sp" />
            <Button variant="primary" size="guided" command="kurulum.next" disabled={!canNext} onClick={next}>
              {last ? t("finish") : t("next")}
            </Button>
          </>
        }
      >
        {step === 0 && (
          <div className="kr-body">
            <div className="kr-types" role="group" aria-label={t("type.title")}>
              {TYPE_IDS.map((tid) => {
                const on = types.includes(tid);
                return (
                  <button key={tid} type="button" className={cx("kr-type", on && "is-on")} aria-pressed={on} onClick={() => toggleType(tid)}>
                    <span className="kr-type-ic">
                      <Icon name={TYPE_ICON[tid]} size={18} />
                    </span>
                    <b>{t(`types.${tid}`)}</b>
                    <small>{t(`typeHints.${tid}`)}</small>
                    {on && (
                      <span className="kr-type-ck" aria-hidden="true">
                        <Icon name="check" size={12} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <section className="kr-feats" aria-label={t("features.title")}>
              <h2>{t("features.title")}</h2>
              {preview.error && !features && (
                <IssueBox
                  tone="error"
                  fixes={
                    <Button size="mini" onClick={() => void preview.refetch()}>
                      {t("retry")}
                    </Button>
                  }
                >
                  {serverText(preview.error)}
                </IssueBox>
              )}
              <ul>{rows.main.map(featureRow)}</ul>
              {rows.more.length > 0 && (
                <div className="kr-more">
                  <CollapsedGroup title={t("features.more")} summary={t("features.moreSummary", { count: rows.more.filter((k) => features?.[k]).length })}>
                    <ul>{rows.more.map(featureRow)}</ul>
                  </CollapsedGroup>
                </div>
              )}
              <p className="kr-note">{t("features.note")}</p>
            </section>
          </div>
        )}

        {step === 1 && (
          <div className="kr-pane">
            <div className="kr-choices" role="radiogroup" aria-label={t("language.title")}>
              {(["build", "default"] as const).map((c) => {
                const on = choice === c;
                const off = c === "build" && !builderOn;
                const hint = c === "build" ? (off ? t("language.buildOff") : t("language.buildHint")) : defaultLanguage ? t("language.defaultHintName", { name: defaultLanguage.name }) : t("language.defaultHint");
                return (
                  <button
                    key={c}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    disabled={off}
                    className={cx("kr-type", on && "is-on")}
                    onClick={() => update({ language: { choice: c } })}
                  >
                    <span className="kr-type-ic">
                      <Icon name={CHOICE_ICON[c]} size={18} />
                    </span>
                    <b>{t(`language.${c}`)}</b>
                    <small>{hint}</small>
                    {on && (
                      <span className="kr-type-ck" aria-hidden="true">
                        <Icon name="check" size={12} />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="kr-note">{t("language.note")}</p>
          </div>
        )}

        {step === 2 && (
          <div className="kr-pane">
            <div className="kr-form">
              <Field label={t("print.paper")}>
                <Select<string>
                  value={print.paperPreset ?? "a4"}
                  onChange={(v) => updatePrint({ paperPreset: v })}
                  options={PAPER_SIZE_IDS.map((p) => ({ value: p, label: t(PAPER_LABEL[p]) }))}
                />
              </Field>
              <Field label={t("print.paperType")} hint={t(`print.paperTypeHint.${print.paperType ?? "plain"}`)}>
                <Segmented<NonNullable<Print["paperType"]>>
                  value={print.paperType ?? "plain"}
                  onChange={(v) => updatePrint({ paperType: v })}
                  options={[
                    { value: "plain", label: t("print.paperTypes.plain") },
                    { value: "precut", label: t("print.paperTypes.precut") },
                  ]}
                />
              </Field>
              <Field label={t("print.who")}>
                <Segmented<"machine" | "hand">
                  value={print.usesCutter ? "machine" : "hand"}
                  onChange={(v) => updatePrint({ usesCutter: v === "machine" })}
                  options={[
                    { value: "machine", label: t("print.whoMachine") },
                    { value: "hand", label: t("print.whoHand") },
                  ]}
                />
              </Field>
              {print.usesCutter && (
                <Field label={t("print.cutter")} hint={t(`print.cutterHint.${print.cutter ?? "other"}`)}>
                  <Select<Cutter> value={print.cutter ?? "other"} onChange={(v) => updatePrint({ cutter: v })} options={SETUP_CUTTERS.map((c) => ({ value: c, label: t(`print.cutters.${c}`) }))} />
                </Field>
              )}
              {types.includes("sticker") && (
                <Field label={t("print.sticker")} hint={t("print.stickerHint")}>
                  <NumberStepper
                    aria-label={t("print.sticker")}
                    decreaseLabel={t("print.smaller")}
                    increaseLabel={t("print.larger")}
                    value={print.stickerSizeMm ?? STICKER_DEFAULT_MM}
                    step={1}
                    min={10}
                    max={200}
                    editable
                    format={(v) => t("print.mm", { value: formatNumber(v) })}
                    onChange={(v) => updatePrint({ stickerSizeMm: Math.round(v) })}
                  />
                </Field>
              )}
            </div>
            <p className="kr-note">{t("print.note")}</p>
          </div>
        )}
      </BandCard>
    </AppFrame>
  );
}
