import "./kisayollar.ts";
import "./ice-aktar.css";
import { type DragEvent, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { EkranProps } from "../../lib/route.ts";
import { TemplatePicker } from "../../ortak/index.ts";
import { ACCEPT_ATTR, ACCEPTED, visibleSelection } from "./mantik/desk.ts";
import { ROW_FILTERS, type RowFilter } from "./mantik/rows.ts";
import {
  AppFrame,
  BandButton,
  Button,
  CenterColumn,
  Checkbox,
  type Crumb,
  EmptyState,
  Icon,
  SelectionBar,
  StatusBar,
  Tabs,
  ToolDivider,
  ToolSpacer,
  ToolStrip,
  useCommand,
  useCommands,
  Workspace,
  WorkRow,
} from "../../tezgah/index.ts";
import { takePendingImport } from "./bekleyen.ts";
import { Karsilama } from "./Karsilama.tsx";
import { SagPanel } from "./SagPanel.tsx";
import { type RowActions, Satir, YokSayilanlar } from "./Satir.tsx";
import { type Masa, useMasa } from "./useMasa.ts";

/**
 * Kısayolun hedefi bir denetimse (düğme, onay kutusu, sekme…) Enter ve Space onun işidir: işleyici `false` döner ve
 * olay serbest kalır. Açık katmanda (menü, şablon seçici) dağıtıcı zaten çalışmaz.
 */
const CONTROL = "button, a[href], summary, [role=checkbox], [role=tab], [role=menuitem], [role=option], [role=radio], [role=switch]";
const onControl = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest?.(CONTROL);

/**
 * İçe aktarma masası (`#/uretim/ice-aktar`, maket 3): sipariş dosyası satır satır; sorunlu satırın düzeltmesi hemen
 * altında; sağda dosya, özet, toplu işler ve gönderim. Hiçbir metin kendiliğinden değişmez.
 */
export default function IceAktarEkrani({ go }: EkranProps) {
  const { t } = useTranslation("importDesk");
  const m = useMasa({ onClose: () => go("uretim"), openBatch: (id) => go("uretim", [], { parti: id }) });
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const chooseFile = () => fileInput.current?.click();
  const ready = m.phase.kind === "ready" && !!m.preview;

  // Üretim ekranına bırakılan dosya: bir kez alınır.
  const loadFile = useRef(m.loadFile);
  loadFile.current = m.loadFile;
  useEffect(() => {
    const f = takePendingImport();
    if (f) void loadFile.current(f);
  }, []);

  useCommands("iceAktar", {
    "iceAktar.close": () => {
      if (m.selected.size) m.clearSelection();
      else void m.requestClose();
    },
    ...(ready
      ? {
          "iceAktar.commitGenerate": () => void m.commit(true),
          "iceAktar.nextIssue": () => m.nextProblem(1),
          "iceAktar.prevIssue": () => m.nextProblem(-1),
          "iceAktar.down": () => m.step(1),
          "iceAktar.up": () => m.step(-1),
          "iceAktar.edit": (e: KeyboardEvent) => {
            if (onControl(e)) return false;
            const i = m.activeIndex ?? m.visibleIdx[0];
            if (i !== undefined) m.startEdit(i);
          },
          "iceAktar.toggle": (e: KeyboardEvent) => {
            if (onControl(e)) return false;
            if (m.activeIndex !== null) m.toggleInclude(m.activeIndex);
          },
        }
      : {}),
  });

  const drop = {
    onDragOver: (e: DragEvent) => {
      if (Array.from(e.dataTransfer.types).includes("Files")) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget === e.target) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) void m.acceptFile(f);
    },
  };

  const crumbs: Crumb[] = [{ label: t("frame:nav.production"), onClick: () => void m.requestClose() }, { label: t("frame:routes.importDesk") }];
  if (ready && m.preview) crumbs.push({ label: m.preview.fileName });

  return (
    <div className="ia-root" {...drop}>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT_ATTR}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void m.acceptFile(f);
        }}
      />
      <AppFrame band="work" active="uretim" workRow={<WorkRow crumbs={crumbs} actions={ready ? <BandButton label={t("work.otherFile")} icon="up" quiet iconOnly={false} onClick={chooseFile} /> : undefined} />}>
        <Workspace right={ready ? <SagPanel m={m} /> : undefined} rightWidth={300}>
          {ready ? (
            <MasaGorunumu m={m} />
          ) : (
            <CenterColumn>
              <Karsilama phase={m.phase as Exclude<typeof m.phase, { kind: "ready" }>} onChooseFile={chooseFile} onPaste={(text) => void m.acceptText(text)} onRetry={m.retry} canRetry={m.canRetry} />
            </CenterColumn>
          )}
        </Workspace>
      </AppFrame>
      {dragging && (
        <div className="ia-dropzone" aria-hidden="true">
          <p>{t("intake.drop", { types: ACCEPTED.join(", ") })}</p>
        </div>
      )}
    </div>
  );
}

/** Orta sütun: süzgeçler ve satır ekle, seçim şeridi, tablo, durum satırı. */
function MasaGorunumu({ m }: { m: Masa }) {
  const { t } = useTranslation("importDesk");
  const next = useCommand("iceAktar.nextIssue");
  const prev = useCommand("iceAktar.prevIssue");
  const toggle = useCommand("iceAktar.toggle");
  const preview = m.preview;

  // Satır eylemleri kararlı (satırlar yalnız kendi verisi değişince yeniden çizilir).
  const latest = useRef(m);
  latest.current = m;
  const actions = useMemo<RowActions>(
    () => ({
      patch: (i, p) => latest.current.patchRow(i, p),
      activate: (i) => latest.current.setActiveIndex(i),
      select: (i, mods) => latest.current.select(i, mods),
      startEdit: (i) => latest.current.startEdit(i),
      stopEdit: () => latest.current.stopEdit(),
      setPicker: (i, o) => latest.current.setPicker(i, o),
      fix: (i, issue, f) => latest.current.fix(i, issue, f),
    }),
    [],
  );
  if (!preview) return null;

  const strip = (
    <ToolStrip label={t("strip.label")}>
      <Tabs label={t("strip.filters")} items={ROW_FILTERS.map((f) => ({ id: f.id, label: f.label, count: m.counts[f.id] }))} value={m.filter} onChange={(id) => m.setFilter(id as RowFilter)} />
      <ToolDivider />
      <Button command="iceAktar.nextIssue" title={`${next.tooltip} · ${prev.tooltip}`} onClick={() => m.nextProblem(1)} />
      <ToolSpacer />
      <YokSayilanlar rows={m.rows} onRestore={(i, code) => m.patchRow(i, { dismissed: (m.rows.find((r) => r.index === i)?.dismissed ?? []).filter((d) => d !== code) })} />
      <Button variant="quiet" icon="plus" onClick={m.addRow}>
        {t("strip.addRow")}
      </Button>
    </ToolStrip>
  );

  const selection =
    m.selected.size > 0 ? (
      <SelectionBar label={t("selection.count", { count: m.selected.size })} onClear={m.clearSelection}>
        <TemplatePicker
          languageId={m.languageId}
          keys={preview.templateKeys}
          value={null}
          allowClear
          onChange={m.assignTemplate}
          trigger={(p) => (
            <Button icon="tag" {...p}>
              {t("selection.assignTemplate")}
              <Icon name="chev" size={12} />
            </Button>
          )}
        />
        <Button onClick={() => m.setIncludeFor(m.selected, true)}>{t("selection.include")}</Button>
        <Button onClick={() => m.setIncludeFor(m.selected, false)}>{t("selection.exclude")}</Button>
      </SelectionBar>
    ) : undefined;

  const status = (
    <StatusBar end={<span>{t("status.toggleHint", { key: toggle.keysText })}</span>}>
      {m.pending.size > 0 ? <span>{t("status.checking")}</span> : m.touched ? <span>{t("status.unsaved")}</span> : null}
    </StatusBar>
  );

  return (
    <CenterColumn strip={strip} selectionBar={selection} status={status}>
      <div ref={m.tableRef} className="ia-scroll">
        <div role="table" aria-label={t("table.label")} aria-rowcount={m.visible.length + 1} className="ia-tbl">
          <div role="row" className="ia-head">
            <span role="columnheader" className="ia-c ia-c-cb">
              <Checkbox checked={visibleSelection(m.selected, m.visibleIdx)} onChange={m.selectAllVisible} label={t("table.selectAll")} />
            </span>
            <span role="columnheader">{t("cols.orderNo")}</span>
            <span role="columnheader">{t("cols.text")}</span>
            <span role="columnheader">{t("cols.quantity")}</span>
            <span role="columnheader">{t("cols.size")}</span>
            <span role="columnheader">{t("cols.template")}</span>
            <span role="columnheader">{t("cols.issue")}</span>
          </div>
          {m.visible.length === 0 ? (
            <EmptyState
              icon="file"
              title={m.filter === "all" ? t("table.emptyFile") : t("table.emptyFilter")}
              action={
                m.filter !== "all" ? (
                  <Button onClick={() => m.setFilter("all")}>{t("table.showAll")}</Button>
                ) : undefined
              }
            />
          ) : (
            m.visible.map((r) => (
              <Satir
                key={r.index}
                row={r}
                active={m.activeIndex === r.index}
                selected={m.selected.has(r.index)}
                editing={m.editingIndex === r.index}
                pickerOpen={m.pickerIndex === r.index}
                validating={m.pending.has(r.index)}
                languageId={m.languageId}
                templateKeys={preview.templateKeys}
                sizes={preview.labelSizes}
                actions={actions}
              />
            ))
          )}
        </div>
      </div>
    </CenterColumn>
  );
}
