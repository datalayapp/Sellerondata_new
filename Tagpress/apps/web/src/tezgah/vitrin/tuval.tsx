import { memo, type ReactNode, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatMm } from "../../i18n/bicim.ts";
import { Button, IconButton } from "../dugme/Button.tsx";
import { Switch, TextField } from "../form/form.tsx";
import { Dialog, useConfirm, useToast } from "../katman/Dialog.tsx";
import { Menu, Popover, Tooltip } from "../katman/Popover.tsx";
import { setShortcutsOpen } from "../kisayol/kayit.ts";
import { type Rect, unionRect } from "../tuval/canvas-math.ts";
import { Artboard, CanvasDock, CanvasViewport, CropMarks, CutPath, SelectionBox, ZoomControl } from "../tuval/Tuval.tsx";
import { useViewport } from "../tuval/useViewport.ts";
import { CenterColumn, StatusBar } from "../yerlesim/yerlesim.tsx";
import "./tuval.css";

/** Vitrin: tuval ve katmanlar (T2). Her aile bir `<Section>`. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tz-vitrin-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const LABEL_MM = 38;

/** Yuvarlak etiket önizlemesi (müşteri metniyle). */
function RoundLabel({ lines, ink }: { lines: string[]; ink: string }) {
  const r = LABEL_MM / 2;
  return (
    <svg className="tz-vt-label" width={LABEL_MM} height={LABEL_MM} viewBox={`0 0 ${LABEL_MM} ${LABEL_MM}`} aria-hidden="true">
      <circle cx={r} cy={r} r={r} fill="var(--tz-paper)" />
      <circle cx={r} cy={r} r={r - 2.2} fill="none" stroke={ink} strokeWidth={0.35} />
      {lines.map((l, i) => (
        <text key={l} x={r} y={r + (i - (lines.length - 1) / 2) * 6.4 + 2} textAnchor="middle" fontSize={i === 0 ? 6.2 : 3.6} fill={ink} fontFamily="var(--f)">
          {l}
        </text>
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- 1. Öneriler tuvali

function ProposalCanvas() {
  const { t } = useTranslation("showcaseCanvas");
  const boards = useMemo(
    () => [
      { id: "v1", x: 0, name: t("proposals.v1"), lines: [t("sample.name"), t("sample.date")], ink: "var(--text)" },
      { id: "v2", x: 54, name: t("proposals.v2"), lines: [t("sample.name"), t("sample.date")], ink: "var(--primary-text)" },
      { id: "v3", x: 108, name: t("proposals.v3"), lines: [t("sample.name")], ink: "var(--tz-artboard-ink)" },
    ],
    [t],
  );
  const world = { x: -8, y: -14, w: 162, h: 70 };
  const api = useViewport({ world });
  const [sel, setSel] = useState<string | null>("v2");
  const [note, setNote] = useState("");
  const toast = useToast();
  const cur = boards.find((b) => b.id === sel);
  const selRect: Rect | null = cur ? { x: cur.x, y: 0, w: LABEL_MM, h: LABEL_MM } : null;
  const size = t("sizeLabel", { w: formatMm(LABEL_MM), h: formatMm(LABEL_MM) });
  return (
    <div className="tz-vitrin-frame tz-vt-frame">
      <CenterColumn
        status={
          <StatusBar end={<ZoomControl api={api} presets={["fit", "actual", "selection"]} onSelection={() => api.fit(selRect ?? unionRect(boards.map((b) => ({ x: b.x, y: 0, w: LABEL_MM, h: LABEL_MM }))))} />}>
            {t("status.proposals", { n: boards.length, size })}
          </StatusBar>
        }
      >
        <CanvasViewport
          api={api}
          rulers
          highlight={selRect ? { x: [selRect.x, selRect.x + selRect.w], y: [selRect.y, selRect.y + selRect.h] } : undefined}
          onBackground={() => setSel(null)}
          overlay={
            <CanvasDock>
              <div className="tz-vt-dock">
                <TextField value={note} onChange={setNote} placeholder={t("dock.placeholder")} aria-label={t("dock.label")} />
                <Button
                  variant="secondary"
                  icon="send"
                  disabled={!note.trim()}
                  onClick={() => {
                    setNote("");
                    toast({ message: t("dock.sent"), tone: "success" });
                  }}
                >
                  {t("dock.send")}
                </Button>
              </div>
            </CanvasDock>
          }
        >
          {boards.map((b) => (
            <Artboard
              key={b.id}
              x={b.x}
              y={0}
              w={LABEL_MM}
              h={LABEL_MM}
              name={<b>{b.name}</b>}
              tag={b.id === "v2" ? <span className="tz-vt-tag">{t("proposals.best")}</span> : undefined}
              selected={sel === b.id}
              below={
                sel === b.id ? (
                  <>
                    <Button size="mini" variant="primary" icon="check" onClick={() => toast({ message: t("proposals.approved", { name: b.name }), tone: "success" })}>
                      {t("proposals.approve")}
                    </Button>
                    <IconButton icon="pen" size={28} label={t("proposals.edit")} />
                  </>
                ) : undefined
              }
            >
              <div className="tz-vt-hit" onPointerDown={() => setSel(b.id)}>
                <RoundLabel lines={b.lines} ink={b.ink} />
              </div>
              {sel === b.id && <SelectionBox rect={{ x: 0, y: 0, w: LABEL_MM, h: LABEL_MM }} handles sizeLabel={size} />}
            </Artboard>
          ))}
        </CanvasViewport>
      </CenterColumn>
    </div>
  );
}

// ---------------------------------------------------------------- 2. Baskı önizlemesi (çok sayfa)

const A4 = { w: 210, h: 297 };
const GAP = 24;
const COLS = 8;
/** Sayfadaki etiket ızgarası: 4 × 6 yuvarlak, 38 mm, kenardan 14 mm. */
const SLOTS: Rect[] = Array.from({ length: 24 }, (_, i) => ({ x: 14 + (i % 4) * 47, y: 14 + Math.floor(i / 4) * 46, w: LABEL_MM, h: LABEL_MM }));

const Page = memo(function Page({ index, preview }: { index: number; preview: boolean }) {
  const { t } = useTranslation("showcaseCanvas");
  return (
    <div className="tz-vt-paper" style={{ width: A4.w, height: A4.h }}>
      {SLOTS.map((s, i) => (
        <div key={i} className="tz-vt-slot" style={{ left: s.x, top: s.y, width: s.w, height: s.h }}>
          <RoundLabel lines={[t("sample.name"), t("sample.order", { n: index * 24 + i + 1 })]} ink="var(--text)" />
        </div>
      ))}
      {preview && SLOTS.map((s, i) => <CutPath key={`c${i}`} shape="circle" rect={s} />)}
    </div>
  );
});

function PrintCanvas() {
  const { t } = useTranslation("showcaseCanvas");
  const [many, setMany] = useState(false);
  const [preview, setPreview] = useState(true);
  const count = many ? 40 : 2;
  const pages = useMemo(() => Array.from({ length: count }, (_, i) => ({ id: `p${i}`, x: (i % COLS) * (A4.w + GAP), y: Math.floor(i / COLS) * (A4.h + GAP + 10) })), [count]);
  const world = unionRect(pages.map((p) => ({ x: p.x, y: p.y, w: A4.w, h: A4.h }))) ?? { x: 0, y: 0, w: A4.w, h: A4.h };
  const api = useViewport({ world });
  return (
    <>
      <div className="tz-vitrin-row">
        <label className="tz-vt-sw">
          <Switch checked={many} onChange={(v) => setMany(v)} label={t("print.many")} />
          {t("print.many")}
        </label>
        <label className="tz-vt-sw">
          <Switch checked={preview} onChange={setPreview} label={t("print.preview")} />
          {t("print.preview")}
        </label>
        <Button size="mini" variant="quiet" icon="fit" onClick={() => api.fit(world)}>
          {t("print.fitAll")}
        </Button>
      </div>
      <div className="tz-vitrin-frame tz-vt-frame tz-vt-frame--tall">
        <CenterColumn status={<StatusBar end={<ZoomControl api={api} presets={["fit", "actual"]} />}>{t("status.pages", { count })}</StatusBar>}>
          <CanvasViewport api={api} rulers>
            {pages.map((p, i) => (
              <Artboard key={p.id} x={p.x} y={p.y} w={A4.w} h={A4.h} name={<b>{t("print.page", { n: i + 1 })}</b>} selected={i === 0}>
                <Page index={i} preview={preview} />
                {preview && <CropMarks rect={{ x: 0, y: 0, w: A4.w, h: A4.h }} />}
              </Artboard>
            ))}
          </CanvasViewport>
        </CenterColumn>
      </div>
      <p className="tz-vt-note">{t("print.note")}</p>
    </>
  );
}

// ---------------------------------------------------------------- 3. Katmanlar

function Layers() {
  const { t } = useTranslation(["showcaseCanvas", "shortcuts"]);
  const [name, setName] = useState(() => t("layers.sessionName"));
  const [draft, setDraft] = useState(name);
  const [dialog, setDialog] = useState<null | "edit" | "busy">(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const confirm = useConfirm();

  const saveBusy = () => {
    setBusy(true);
    window.setTimeout(() => {
      setBusy(false);
      setDialog(null);
      toast({ message: t("layers.saved"), tone: "success" });
    }, 1600);
  };

  return (
    <>
      <div className="tz-vitrin-row">
        <Popover align="start" width={300} onOpenChange={(o) => o && setDraft(name)} trigger={(p) => <Button {...p} icon="pen">{name}</Button>}>
          {(close) => (
            <form
              className="tz-vt-pop"
              onSubmit={(e) => {
                e.preventDefault();
                if (draft.trim()) setName(draft.trim());
                close();
              }}
            >
              <label className="tz-vt-lab" htmlFor="tz-vt-rename">
                {t("layers.rename")}
              </label>
              <TextField id="tz-vt-rename" value={draft} onChange={setDraft} />
              <div className="tz-vt-actions">
                <Button variant="quiet" onClick={close}>
                  {t("layers.cancel")}
                </Button>
                <Button variant="primary" type="submit">
                  {t("layers.save")}
                </Button>
              </div>
            </form>
          )}
        </Popover>

        <Menu
          align="start"
          trigger={(p) => (
            <Button {...p} icon="zin">
              {t("layers.view")}
            </Button>
          )}
          items={[
            { label: t("shortcuts:canvas.zoomIn"), icon: "plus", command: "canvas.zoomIn", onSelect: () => {} },
            { label: t("shortcuts:canvas.zoomOut"), icon: "minus", command: "canvas.zoomOut", onSelect: () => {} },
            "sep",
            { label: t("shortcuts:canvas.fit"), icon: "fit", command: "canvas.fit", onSelect: () => {} },
            { label: t("shortcuts:canvas.actual"), command: "canvas.actual", onSelect: () => {} },
            { label: t("shortcuts:canvas.selection"), command: "canvas.selection", disabled: true, onSelect: () => {} },
          ]}
        />

        <Menu
          trigger={(p) => <IconButton {...p} icon="dots" label={t("layers.more")} />}
          items={[
            { label: t("layers.duplicate"), icon: "copy", onSelect: () => toast({ message: t("layers.duplicated") }) },
            { label: t("layers.archive"), icon: "file", onSelect: () => {} },
            "sep",
            {
              label: t("layers.delete"),
              icon: "trash",
              danger: true,
              onSelect: async () => {
                const ok = await confirm({ title: t("layers.confirmTitle"), body: t("layers.confirmBody"), confirmLabel: t("layers.delete"), tone: "danger" });
                if (ok) toast({ message: t("layers.deleted"), action: { label: t("layers.undo"), run: () => toast({ message: t("layers.restored"), tone: "success" }) } });
              },
            },
          ]}
        />

        <Button onClick={() => setDialog("edit")}>{t("layers.openDialog")}</Button>
        <Button onClick={() => setDialog("busy")}>{t("layers.openBusy")}</Button>
      </div>

      <div className="tz-vitrin-row">
        <Button onClick={() => toast({ message: t("layers.deleted"), action: { label: t("layers.undo"), run: () => toast({ message: t("layers.restored"), tone: "success" }) } })}>
          {t("layers.toastUndo")}
        </Button>
        <Button onClick={() => toast({ message: t("layers.errorMessage"), tone: "error" })}>{t("layers.toastError")}</Button>
        <IconButton icon="fit" command="canvas.fit" />
        <IconButton icon="cut" label={t("layers.cut")} title={t("layers.tipCut")} />
        <Button variant="quiet" icon="reg" title={t("layers.tipLong")}>
          {t("layers.marks")}
        </Button>
        <Button variant="quiet" icon="print" command="canvas.fit" disabled>
          {t("layers.disabled")}
        </Button>
        <Tooltip content={t("layers.tipLong")}>
          <span className="tz-vt-chip" tabIndex={0}>
            {t("layers.marks")}
          </span>
        </Tooltip>
        <Button icon="kbd" command="help" onClick={() => setShortcutsOpen(true)} />
      </div>

      {dialog === "edit" && (
        <Dialog
          title={t("layers.dialogTitle")}
          dirty={text !== ""}
          onClose={() => {
            setDialog(null);
            setText("");
          }}
          footer={
            <>
              <Button variant="quiet" onClick={() => setDialog(null)}>
                {t("layers.cancel")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDialog(null);
                  setText("");
                  toast({ message: t("layers.saved"), tone: "success" });
                }}
              >
                {t("layers.save")}
              </Button>
            </>
          }
        >
          <div className="tz-vt-form">
            <label className="tz-vt-lab" htmlFor="tz-vt-note">
              {t("layers.noteLabel")}
            </label>
            <TextField id="tz-vt-note" value={text} onChange={setText} placeholder={t("layers.notePlaceholder")} />
            <p>{t("layers.dirtyHint")}</p>
            <Menu
              align="start"
              trigger={(p) => (
                <Button {...p} icon="layout">
                  {t("layers.inDialogMenu")}
                </Button>
              )}
              items={[
                { label: t("layers.templateA"), onSelect: () => setText(t("layers.templateA")) },
                { label: t("layers.templateB"), onSelect: () => setText(t("layers.templateB")) },
              ]}
            />
          </div>
        </Dialog>
      )}
      {dialog === "busy" && (
        <Dialog
          title={t("layers.busyTitle")}
          size="sm"
          busy={busy}
          onClose={() => setDialog(null)}
          footer={
            <Button variant="primary" loading={busy} onClick={saveBusy}>
              {t("layers.save")}
            </Button>
          }
        >
          <p>{t("layers.busyBody")}</p>
        </Dialog>
      )}
    </>
  );
}

export default function TuvalVitrin() {
  const { t } = useTranslation("showcaseCanvas");
  return (
    <>
      <Section title={t("sections.proposals")}>
        <ProposalCanvas />
        <p className="tz-vt-note">{t("proposals.note")}</p>
      </Section>
      <Section title={t("sections.print")}>
        <PrintCanvas />
      </Section>
      <Section title={t("sections.layers")}>
        <Layers />
      </Section>
    </>
  );
}
