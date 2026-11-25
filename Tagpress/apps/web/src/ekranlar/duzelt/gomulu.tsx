/**
 * Gömülü düzenleme (sahip kararı 2026-11-24): Düzelt ayrı sayfaya gidip gelmeden, bulunduğu ekranın içinde açılır.
 * - `HizliDuzelt`: Üretim'in sağ panelindeki küçük tezgâh (küçük tuval, satır seçimi ve sürükleme, metin, yazı tipi,
 *   boyut, ortalama, geri al / sıfırla). Değişiklikler kısa bir duraksamadan sonra kendiliğinden kaydedilir.
 * - `DuzeltPenceresi`: aynı ekranın üstünde açılan büyük pencere (satır listesi, büyük tuval, özellik paneli;
 *   Vazgeç / Kaydet). Kapanınca çağıran ekran olduğu yerde kalır.
 *
 * SÖZLEŞME (Üretim ve Baskı masası bunu kullanır; imzalar değişmez, değişmesi gerekirse orkestratöre bildirilir).
 *
 * Çağıran için notlar:
 * - Küçük tezgâhta bekleyen kayıt varken büyük pencereyi açmadan önce `flush()` çağrılır (pencere sunucudaki son
 *   hâlden açılır). Pencere kaydedince küçük tezgâh yeni hâli kendiliğinden alır (yerelde bekleyen değişiklik yoksa).
 * - Küçük tezgâh kaldırılırken (başka karta geçiş, panel kapanışı) bekleyen kayıt ve açık metin taslağı yazılır.
 * - Küçük tezgâh genel kısayol bağlamaz (Üretim'in klavye ritmi sürer); oklar ve Ctrl Z / Ctrl Y yalnız küçük tuval
 *   odaktayken ve ekran o tuşu almadıysa çalışır.
 */
import "./kisayollar.ts";
import "./duzelt.css";
import type { VariantEditModel } from "@tagpress/domain";
import { type ReactElement, type Ref, type RefObject, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { serverText } from "../../i18n/sunucu.ts";
import { Button, EmptyState, Icon, IconButton, IssueBox, useToast, useViewport, useWorkDialogActive, WorkDialog, WorkDialogFooter } from "../../tezgah/index.ts";
import { DuzeltCalisma, Hata } from "./Calisma.tsx";
import { alignment, sameAdjust } from "./mantik/adjust-math.ts";
import { alignEpsilon, fineStep } from "./mantik/adjust-view.ts";
import { fitZoomFor, mmPerPx } from "./olcu.ts";
import { BoyutAdimlayici, FontSecici, MetinAlani } from "./OzellikPaneli.tsx";
import { Sahne } from "./Sahne.tsx";
import { Denetim, lineIsOwn } from "./SatirPaneli.tsx";
import { type Duzelt, useDuzelt } from "./useDuzelt.ts";
import { useDuzeltModel } from "./useDuzeltModel.ts";

export type HizliDuzeltHandle = {
  /** Bekleyen (henüz kaydedilmemiş) değişikliği hemen kaydeder. Değişiklik yoksa ya da kayıt başarılıysa true. */
  flush(): Promise<boolean>;
};

export type HizliDuzeltProps = {
  /** Düzenlenen seçenek (varyasyon). `kind === "image-on-template"` olan seçenek için çağıran bileşeni göstermez. */
  variantId: string;
  /** Üretim'in onay düğmesi onaylamadan önce `flush()` çağırır. */
  handleRef?: Ref<HizliDuzeltHandle>;
  /** Her başarılı kayıttan sonra (çağıran önizlemeyi ve işi tazeler). */
  onSaved?: () => void;
};

/** Son değişiklikten sonra kendiliğinden kayda kadar beklenen süre (ms): sürükleme bırakılınca, düğme basılınca. */
export const AUTOSAVE_MS = 800;

const noop = () => {};

type KucukHandle = HizliDuzeltHandle & {
  /** Yerelde bekleyen bir şey yok (taslak, kaydedilmemiş değişiklik, süren kayıt). */
  idle(): boolean;
  /** Bu tezgâhın bildiği sunucu düzeltmesi. */
  base(): VariantEditModel["adjust"];
};

export function HizliDuzelt({ variantId, handleRef, onSaved }: HizliDuzeltProps): ReactElement | null {
  const { t } = useTranslation("adjust");
  const m = useDuzeltModel(variantId);
  const inner = useRef<KucukHandle | null>(null);
  const [sync, setSync] = useState(0);
  useImperativeHandle(handleRef, () => ({ flush: () => inner.current?.flush() ?? Promise.resolve(true) }), []);

  // Sunucudaki düzeltme başka yerden değişti (büyük pencerede kaydedildi, geri alındı) ve burada bekleyen bir şey yok:
  // küçük tezgâh yeni hâlden yeniden kurulur.
  const model = m.state === "ready" ? m.model : null;
  useEffect(() => {
    const h = inner.current;
    if (!model || !h || !h.idle() || sameAdjust(model.adjust, h.base())) return;
    setSync((n) => n + 1);
  }, [model]);

  if (m.state === "error") {
    return (
      <div className="dz-q">
        <IssueBox tone="warn">
          <b>{m.notAdjustable ? t("error.notAdjustable") : t("error.open")}</b> {m.notAdjustable ? t("error.notAdjustableBody") : serverText(m.error)}
        </IssueBox>
      </div>
    );
  }
  if (m.state === "loading") {
    return (
      <div className="dz-q">
        <div className="dz-q-cv dz-q-cv--wait" aria-busy="true">
          <span className="dz-q-note">{t("loading")}</span>
        </div>
      </div>
    );
  }
  return <KucukTezgah key={`${variantId}:${sync}`} variantId={variantId} model={m.model} frameMm={m.frameMm} onSaved={onSaved} innerRef={inner} />;
}

function KucukTezgah({
  variantId,
  model,
  frameMm,
  onSaved,
  innerRef,
}: {
  variantId: string;
  model: VariantEditModel;
  frameMm: number;
  onSaved?: () => void;
  innerRef: RefObject<KucukHandle | null>;
}) {
  const { t } = useTranslation("adjust");
  const toast = useToast();
  const d = useDuzelt({ variantId, model, onLeave: noop, guard: false });
  const k = mmPerPx(frameMm, model.framePx);
  const world = useMemo(() => ({ x: 0, y: 0, w: frameMm, h: frameMm }), [frameMm]);
  const api = useViewport({ world, pad: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement>(null);
  const focusStage = () => stageRef.current?.focus({ preventScroll: true });
  const [savedOnce, setSavedOnce] = useState(false);

  const dRef = useRef<Duzelt>(d);
  dRef.current = d;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const timer = useRef<number | undefined>(undefined);

  /** Bekleyeni şimdi kaydet; `commitDraft`: açık metin taslağı da yazılır. */
  const runSave = useCallback(async (commitDraft: boolean): Promise<boolean> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    const r = await dRef.current.persist({ commitDraft });
    if (r === "saved") {
      setSavedOnce(true);
      onSavedRef.current?.();
    }
    return r !== "failed";
  }, []);

  useImperativeHandle(
    innerRef,
    () => ({
      flush: () => runSave(true),
      idle: () => {
        const x = dRef.current;
        return !x.unsaved && !x.editing && !x.saving && timer.current === undefined;
      },
      base: () => dRef.current.saved,
    }),
    [runSave],
  );

  // Kendiliğinden kayıt: bırakılmış her değişiklikten kısa süre sonra (sürükleme ara değeri ve metin taslağı sayılmaz).
  // Kayıt başarısızsa yeniden denenmez; hata görünür ve "Yeniden dene" ya da sonraki değişiklik yeniden kaydeder.
  const unsaved = d.unsaved;
  useEffect(() => {
    if (!unsaved) return;
    timer.current = window.setTimeout(() => void runSave(false), AUTOSAVE_MS);
    return () => {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [d.hist.present, d.saved, unsaved, runSave]);

  // Kaldırılırken (başka karta geçiş, panel kapanışı) bekleyen kayıt ve açık taslak yazılır.
  useEffect(
    () => () => {
      void runSave(true);
    },
    [runSave],
  );

  const fitZoom = fitZoomFor(frameMm, api.size.w, api.size.h);
  const step = api.size.w > 0 ? fineStep(api.view.zoom, fitZoom) : 1;
  const aligned = alignment(d.selCenter, d.goal, alignEpsilon(api.view.zoom, fitZoom));

  const edit = (i: number | null) => {
    const idx = i ?? (d.layout.lines.length === 1 ? 0 : null);
    if (idx === null) {
      toast({ message: t("text.pickLine") });
      return;
    }
    d.startEdit(idx);
  };
  const pick = (i: number | null) => {
    if (d.editing) void d.commitEdit();
    d.setSel(i === null ? null : [i]);
  };

  /** Küçük tuval odaktayken: oklar taşır (Shift 10 kat), Ctrl Z / Ctrl Y, Enter metni düzenler. Ekran tuşu aldıysa dokunulmaz. */
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && d.editing && e.target === editorRef.current) {
      e.preventDefault();
      d.cancelEdit();
      focusStage();
      return;
    }
    if (e.target !== stageRef.current) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && (key === "z" || key === "y")) {
      e.preventDefault();
      if (key === "y" || e.shiftKey) d.redo();
      else d.undo();
    } else if (!mod && !e.altKey && e.key.startsWith("Arrow")) {
      e.preventDefault();
      d.nudge(e.key, e.shiftKey, step);
    } else if (!mod && e.key === "Enter") {
      e.preventDefault();
      edit(d.single);
    }
  };

  const status = d.saving ? t("quick.saving") : savedOnce && !d.unsaved ? t("quick.saved") : t("quick.hint");
  const issues = d.check.issues.filter((i) => i.severity !== "info");

  return (
    <div ref={rootRef} className="dz-q" onKeyDown={onKeyDown}>
      <div className="dz-q-cv">
        <Sahne
          d={d}
          api={api}
          k={k}
          frameMm={frameMm}
          tool="select"
          aligned={aligned}
          stageRef={stageRef}
          onEdit={edit}
          onStageFocus={noop}
          compact
          label={t("quick.canvas")}
        />
        <span className="dz-q-tools">
          <IconButton icon="undo" size={28} label={t("shortcuts.undo")} disabled={!d.canUndo} onClick={d.undo} />
          <IconButton icon="reset" size={28} label={t("shortcuts.reset")} disabled={sameAdjust(d.cur, null)} onClick={d.reset} />
        </span>
        <span className="dz-q-note" role="status" aria-live="polite">
          {status}
        </span>
      </div>

      <div className="dz-q-lines" role="group" aria-label={t("lines.title")}>
        <Button size="mini" aria-pressed={d.sel === null} onClick={() => pick(null)}>
          {t("lines.all")}
        </Button>
        {d.layout.lines.map((line, i) => (
          <Button key={i} size="mini" className="dz-q-line" title={t("quick.line", { n: i + 1 })} aria-pressed={!!d.sel && d.sel.length === 1 && d.sel[0] === i} data-own={lineIsOwn(d.cur, i) || undefined} onClick={() => pick(i)}>
            <span>{line.text}</span>
          </Button>
        ))}
      </div>

      <label className="dz-q-field">
        <span>{t("text.heading")}</span>
        <MetinAlani
          d={d}
          editorRef={editorRef}
          onStage={focusStage}
          onBlur={(e) => {
            // Odak panelden çıkınca taslak yazılır (panel içindeki font ve boyut taslağı kendisi işler).
            if (d.editing && !rootRef.current?.contains(e.relatedTarget as Node | null)) void d.commitEdit();
          }}
        />
      </label>

      <div className="dz-q-row">
        {d.canEditText && (
          <label className="dz-q-field dz-grow">
            <span>{t("quick.font")}</span>
            <FontSecici d={d} label={t("quick.font")} />
          </label>
        )}
        <div className="dz-q-field">
          <span aria-hidden="true">{t("size.label")}</span>
          <BoyutAdimlayici d={d} />
        </div>
      </div>

      <div className="dz-q-center" role="group" aria-label={t("target.heading")}>
        <Button icon="ah" aria-pressed={aligned.x} onClick={() => d.center("x")}>
          {t("quick.centerX")}
        </Button>
        <Button icon="av" aria-pressed={aligned.y} onClick={() => d.center("y")}>
          {t("quick.centerY")}
        </Button>
        <Button icon="cross" aria-pressed={aligned.x && aligned.y} onClick={() => d.center("both")}>
          {t("quick.centerBoth")}
        </Button>
      </div>

      {issues.length > 0 && <Denetim issues={issues} contained={false} />}

      {d.saveError !== null && (
        <div role="alert">
          <IssueBox
            tone="error"
            fixes={
              <Button size="mini" disabled={d.saving} onClick={() => void runSave(true)}>
                {t("quick.retry")}
              </Button>
            }
          >
            <b>{t("quick.failed")}</b> {serverText(d.saveError)}
          </IssueBox>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- büyük pencere

export type DuzeltPenceresiProps = {
  variantId: string;
  /** `saved`: pencerede Kaydet ile kayıt yapıldı mı. Vazgeç, Esc ve kapatma düğmesi `false` verir. */
  onClose: (saved: boolean) => void;
};

/**
 * Ayrıntılı düzenleme penceresi: `#/duzelt` sayfasının düzenleyicisi (`DuzeltCalisma`) bulunduğu ekranın üstünde.
 * Esc önce metin taslağını, odağı, seçimi bırakır, sonra kapatır; kaydedilmemiş değişiklik varsa sorar. Pencere açıkken
 * alttaki ekranın kısayolları kapalıdır (alt kip).
 */
export function DuzeltPenceresi({ variantId, onClose }: DuzeltPenceresiProps): ReactElement | null {
  const { t } = useTranslation("adjust");
  const m = useDuzeltModel(variantId);
  const exitRef = useRef<(() => void) | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const done = useRef(false);
  const finish = useCallback((saved: boolean) => {
    if (done.current) return;
    done.current = true;
    closeRef.current(saved);
  }, []);

  const job = m.state === "error" ? undefined : m.job;
  const variant = m.state === "error" ? undefined : m.variant;
  const name = job?.text.split(/\r?\n/)[0]?.trim();
  const subtitle = [job?.orderNo ? t("window.order", { order: job.orderNo }) : null, variant ? t("window.variant", { no: variant.no }) : null, name || null].filter(Boolean).join(" · ");

  let body: ReactElement;
  if (m.state === "error") {
    body = (
      <Hata
        title={m.notAdjustable ? t("error.notAdjustable") : t("error.open")}
        body={m.notAdjustable ? t("error.notAdjustableBody") : serverText(m.error)}
        onBack={() => finish(false)}
      />
    );
  } else if (m.state === "loading") {
    body = (
      <div className="dz-wd-wait">
        <EmptyState icon="layout" title={t("loading")} />
      </div>
    );
  } else {
    body = <PencereIcerik key={variantId} variantId={variantId} model={m.model} frameMm={m.frameMm} exitRef={exitRef} onLeave={finish} />;
  }

  return (
    <WorkDialog title={t("window.title")} subtitle={subtitle || undefined} onRequestClose={() => (exitRef.current ? exitRef.current() : finish(false))}>
      {body}
    </WorkDialog>
  );
}

function PencereIcerik({
  variantId,
  model,
  frameMm,
  exitRef,
  onLeave,
}: {
  variantId: string;
  model: VariantEditModel;
  frameMm: number;
  exitRef: RefObject<(() => void) | null>;
  onLeave(saved: boolean): void;
}) {
  const active = useWorkDialogActive();
  return (
    <DuzeltCalisma
      variantId={variantId}
      model={model}
      frameMm={frameMm}
      onLeave={onLeave}
      modal
      active={active}
      wrap={(body, d) => (
        <>
          {body}
          <PencereAlti d={d} exitRef={exitRef} />
        </>
      )}
    />
  );
}

/** Pencerenin alt şeridi: not, Vazgeç (Esc), Kaydet (Ctrl S). X ve Esc de Vazgeç gibi davranır. */
function PencereAlti({ d, exitRef }: { d: Duzelt; exitRef: RefObject<(() => void) | null> }) {
  const { t } = useTranslation("adjust");
  const exit = d.exit;
  useEffect(() => {
    exitRef.current = () => void exit();
  });
  useEffect(
    () => () => {
      exitRef.current = null;
    },
    [exitRef],
  );
  return (
    <WorkDialogFooter>
      <span className="dz-wd-note">
        <Icon name="okc" size={15} />
        {t("window.note")}
      </span>
      <span className="tz-sp" />
      <Button size="page" command="duzelt.cancel" kbd disabled={d.saving} onClick={() => void d.exit()}>
        {t("actions.cancel")}
      </Button>
      <Button need="edit" variant="primary" size="page" command="duzelt.save" disabled={!d.canSave} loading={d.saving} onClick={() => void d.save()}>
        {t("actions.save")}
      </Button>
    </WorkDialogFooter>
  );
}
