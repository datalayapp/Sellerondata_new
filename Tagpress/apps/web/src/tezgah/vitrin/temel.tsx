import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { BandButton, BandCard, FullBand, StepChips, WorkRow } from "../cerceve/cerceve.tsx";
import { Button, type ButtonSize, type ButtonVariant, IconButton, Kbd } from "../dugme/Button.tsx";
import { EmptyState, IssueBadge, IssueBox, ProgressBar, StatusDot, Tag } from "../durum/durum.tsx";
import { Checkbox, Field, NumberStepper, SearchField, Segmented, Select, Switch, TextArea, TextField } from "../form/form.tsx";
import { Icon, ICON_NAMES, type IconName } from "../ikon/Icon.tsx";
import { Num } from "../Num.tsx";
import {
  CenterColumn,
  CollapsedGroup,
  ListRow,
  Panel,
  PanelSection,
  PropPair,
  PropRow,
  Rail,
  SelectionBar,
  StatusBar,
  Tabs,
  ToolDivider,
  ToolGroup,
  ToolLabel,
  ToolSpacer,
  ToolStrip,
  Workspace,
} from "../yerlesim/yerlesim.tsx";
import "./temel.css";

/** Vitrin: temel bileşenler (T1). Her bileşen ailesi bir `<Section>`; yeni bileşen eklenince buraya örnek girer. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="tz-vitrin-sec">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

/** Etiketli küçük başlık + satır (düğme ve form matrisleri). */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="tz-vt-row">
      <span className="tz-vt-lb">{label}</span>
      <div className="tz-vitrin-row">{children}</div>
    </div>
  );
}

const noop = () => {};

/**
 * Çerçevenin bant + ana alan iskeleti, üst satırsız: sayfanın kendi çerçevesi zaten üst satırı taşıyor
 * (ikinci bir menü ve kimlik katmanı çıkmasın diye `AppFrame` yerine aynı sınıflarla kurulur).
 */
function DemoFrame({ full, row, className, children }: { full?: boolean; row: ReactNode; className: string; children: ReactNode }) {
  return (
    <div className={`tz-vitrin-frame ${className}`}>
      <div className={full ? "tz-app tz-app--full" : "tz-app"}>
        <div className="tz-bd">{row}</div>
        <div className="tz-main">{children}</div>
      </div>
    </div>
  );
}

/** Çalışma bandı + üç sütunlu çalışma alanı (ray, liste paneli, orta sütun, özellik paneli). */
function WorkDemo() {
  const { t } = useTranslation("showcase");
  const [tool, setTool] = useState("fit");
  const [list, setList] = useState("all");
  const [selected, setSelected] = useState(true);
  const [shape, setShape] = useState<"round" | "rect">("round");
  const [text, setText] = useState(t("work.customerText"));
  const [diameter, setDiameter] = useState(38);
  const [size, setSize] = useState<"a4" | "a5">("a4");
  const [orderNo, setOrderNo] = useState("10482");
  const [qty, setQty] = useState("60");
  const [marks, setMarks] = useState(true);
  const [picked, setPicked] = useState(true);
  return (
    <DemoFrame
      className="tz-vt-app"
      row={
        <WorkRow
          back={{ command: "nav.production", onClick: noop }}
          crumbs={[
            { label: t("work.crumbProduction"), onClick: noop },
            {
              label: t("work.crumbBatch"),
              menu: (close) => (
                <div role="menu" className="tz-menu">
                  <button type="button" role="menuitem" className="tz-menu-i" onClick={close}>
                    {t("work.crumbBatch")}
                  </button>
                  <button type="button" role="menuitem" className="tz-menu-i" onClick={close}>
                    {t("work.allJobs")}
                  </button>
                </div>
              ),
            },
          ]}
          flow={[
            { id: "proposals", label: t("work.flowProposals"), count: 3, active: true, onClick: noop },
            { id: "issues", label: t("work.flowIssues"), count: 1, error: true, onClick: noop },
            { id: "approved", label: t("work.flowApproved"), count: 4, onClick: noop },
          ]}
          meta={<StatusDot tone="busy" label={t("work.producing")} />}
          actions={<BandButton cta label={t("work.approveBest")} icon="check" onClick={noop} />}
        />
      }
    >
      <Workspace
        leftWidth={280}
        rightWidth={300}
        rail={
          <Rail
            label={t("work.tools")}
            value={tool}
            onChange={setTool}
            items={[
              { id: "fit", icon: "fit", command: "canvas.fit" },
              { id: "actual", icon: "grid", command: "canvas.actual" },
              "divider",
              { id: "zoomIn", icon: "zin", command: "canvas.zoomIn" },
              { id: "pan", icon: "hand", command: "canvas.pan" },
            ]}
          />
        }
        left={
          <Panel side="left" title={t("work.queue")} count={12} actions={<IconButton icon="file" label={t("work.addFile")} size={28} />}>
            <PanelSection>
              <Tabs
                label={t("work.filters")}
                value={list}
                onChange={setList}
                items={[
                  { id: "all", label: t("work.tabAll"), count: 12 },
                  { id: "issues", label: t("work.tabIssues"), count: 1 },
                  { id: "approved", label: t("work.tabApproved"), count: 4 },
                  { id: "more", label: t("work.tabMore"), menu: true },
                ]}
              />
            </PanelSection>
            <ListRow
              current
              title={
                <>
                  <span className="tz-mono">10482</span>
                  {t("work.row1")}
                </>
              }
              sub={t("work.row1Sub")}
              leading={<span className="tz-vt-ph" />}
              trailing={<StatusDot tone="busy" />}
              onClick={noop}
            />
            <ListRow
              multi
              checkbox={{ checked: picked, onChange: setPicked, label: t("work.row2") }}
              title={
                <>
                  <span className="tz-mono">10483</span>
                  {t("work.row2")}
                </>
              }
              sub={t("work.row2Sub")}
              leading={<span className="tz-vt-ph" />}
              trailing={<StatusDot tone="ready" />}
              onClick={noop}
            />
            <ListRow
              title={
                <>
                  <span className="tz-mono">10484</span>
                  {t("work.row3")}
                </>
              }
              sub={t("work.row3Sub")}
              leading={<span className="tz-vt-ph" />}
              trailing={<IssueBadge tone="error">{t("work.oneIssue")}</IssueBadge>}
              onClick={noop}
            />
            <ListRow
              title={
                <>
                  <span className="tz-mono">10485</span>
                  {t("work.row4")}
                </>
              }
              sub={t("work.row4Sub")}
              leading={<span className="tz-vt-ph" />}
              trailing={<StatusDot tone="ok" />}
              onClick={noop}
            />
          </Panel>
        }
        right={
          <Panel
            side="right"
            title={t("work.props")}
            footer={
              <Button variant="primary" size="page" wide>
                {t("buttons.primary")} <Kbd keys="2" on="primary" />
              </Button>
            }
          >
            <PanelSection
              heading={t("work.customerHeading")}
              aside={
                <button type="button" className="tz-lnk">
                  {t("work.reset")}
                </button>
              }
            >
              <TextArea value={text} onChange={setText} autoGrow aria-label={t("work.customerHeading")} />
            </PanelSection>
            <PanelSection heading={t("work.sizeHeading")}>
              <PropRow label={t("work.diameter")}>
                <NumberStepper value={diameter} step={1} min={10} max={120} format={(v) => `${v} mm`} onChange={setDiameter} aria-label={t("work.diameter")} />
              </PropRow>
              <PropRow label={t("work.paper")}>
                <Select
                  value={size}
                  options={[
                    { value: "a4", label: "A4" },
                    { value: "a5", label: "A5" },
                  ]}
                  onChange={setSize}
                  aria-label={t("work.paper")}
                />
              </PropRow>
              <PropRow label={t("work.cutMarks")}>
                <Switch checked={marks} onChange={setMarks} label={t("work.cutMarks")} />
              </PropRow>
              <PropPair>
                <label>
                  {t("work.orderNo")}
                  <TextField value={orderNo} onChange={setOrderNo} />
                </label>
                <label>
                  {t("work.qty")}
                  <TextField value={qty} onChange={setQty} unit={t("work.unitPcs")} />
                </label>
              </PropPair>
            </PanelSection>
            <PanelSection>
              <IssueBox tone="warn" fixes={<Button size="mini">{t("work.shrink")}</Button>}>
                {t("work.overflow")}
              </IssueBox>
            </PanelSection>
            <CollapsedGroup title={t("work.details")} summary={t("work.detailsSummary")} persistKey="vitrin.details">
              <PanelSection>
                <PropRow label={t("work.rows")}>
                  <Num>2</Num>
                </PropRow>
                <PropRow label={t("work.cost")}>
                  <Num>0,04 $</Num>
                </PropRow>
              </PanelSection>
            </CollapsedGroup>
            <CollapsedGroup title={t("work.mapping")} summary={t("work.mappingSummary")}>
              <PanelSection>
                <PropRow label={t("work.field")}>
                  <Select value="name" options={[{ value: "name", label: t("work.fieldName") }]} onChange={noop} aria-label={t("work.field")} />
                </PropRow>
              </PanelSection>
            </CollapsedGroup>
          </Panel>
        }
      >
        <CenterColumn
          strip={
            <ToolStrip label={t("work.strip")}>
              <ToolGroup>
                <IconButton icon="undo" label={t("work.undo")} />
                <IconButton icon="redo" label={t("work.redo")} />
              </ToolGroup>
              <ToolDivider />
              <ToolLabel>{t("work.shape")}</ToolLabel>
              <Segmented
                value={shape}
                options={[
                  { value: "round", label: t("work.round") },
                  { value: "rect", label: t("work.rect") },
                ]}
                onChange={setShape}
                aria-label={t("work.shape")}
              />
              <ToolSpacer />
              <Button variant="quiet" icon="refresh">
                {t("work.refresh")}
              </Button>
            </ToolStrip>
          }
          selectionBar={
            selected ? (
              <SelectionBar label={t("work.selected")} onClear={() => setSelected(false)}>
                <Button size="mini" variant="secondary">
                  {t("work.include")}
                </Button>
                <Button size="mini" variant="secondary">
                  {t("work.exclude")}
                </Button>
              </SelectionBar>
            ) : undefined
          }
          status={
            <StatusBar
              end={
                <span>
                  <Num>100%</Num>
                </span>
              }
            >
              <span>mm</span>
              <b>
                <Num>38 × 38 mm</Num>
              </b>
              <span>{t("work.saved")}</span>
            </StatusBar>
          }
        >
          <EmptyState
            icon="layout"
            title={t("work.empty")}
            action={
              !selected ? (
                <Button variant="secondary" onClick={() => setSelected(true)}>
                  {t("work.selectRows")}
                </Button>
              ) : undefined
            }
          />
        </CenterColumn>
      </Workspace>
    </DemoFrame>
  );
}

/** Sekmeli iş satırı, yeniden adlandırılabilir kırıntı (alçak çerçeve). */
function TabsDemo() {
  const { t } = useTranslation("showcase");
  const [tab, setTab] = useState("summary");
  const [name, setName] = useState(t("tabsFrame.name"));
  return (
    <DemoFrame
      className="tz-vt-short"
      row={
        <WorkRow
          crumbs={[
            { label: t("tabsFrame.parent"), onClick: noop },
            { label: name, rename: { value: name, onRename: setName } },
          ]}
          tabs={{
            items: [
              { id: "summary", label: t("tabsFrame.summary") },
              { id: "rules", label: t("tabsFrame.rules"), count: 8 },
              { id: "versions", label: t("tabsFrame.versions"), count: 3 },
            ],
            value: tab,
            onChange: setTab,
          }}
          actions={<BandButton label={t("tabsFrame.save")} onClick={noop} />}
        />
      }
    >
      <div className="tz-vt-pad">{t("tabsFrame.body")}</div>
    </DemoFrame>
  );
}

/** Sekmeler önce (`tabsFirst`), sonra yer adı ve özet; sağda sessiz menü düğmeleri (maket Baskı masası). */
function TabsFirstDemo() {
  const { t } = useTranslation("showcase");
  const [tab, setTab] = useState("desk");
  const [name, setName] = useState(t("tabsFirst.name"));
  return (
    <DemoFrame
      className="tz-vt-short"
      row={
        <WorkRow
          tabsFirst
          tabs={{
            items: [
              { id: "desk", label: t("tabsFirst.desk") },
              { id: "sheets", label: t("tabsFirst.sheets") },
              { id: "archive", label: t("tabsFirst.archive") },
            ],
            value: tab,
            onChange: setTab,
          }}
          crumbs={[{ label: name, rename: { value: name, onRename: setName } }]}
          meta={<span>{t("tabsFirst.summary")}</span>}
          actions={
            <>
              <BandButton quiet label={t("tabsFirst.drafts")} menuItems={[{ label: t("tabsFirst.name"), onSelect: noop }]} />
              <BandButton quiet icon="dots" label={t("tabsFirst.more")} menuItems={[{ label: t("tabsFirst.toArchive"), onSelect: noop }]} />
            </>
          }
        />
      }
    >
      <div className="tz-vt-pad">{t("tabsFirst.body")}</div>
    </DemoFrame>
  );
}

/** Liste satırı yoğunlukları: fixed (46 px, tek satır), auto (maket .vrow), compact (maket .glist). */
function ListsDemo() {
  const { t } = useTranslation("showcase");
  const [cur, setCur] = useState("connections");
  const sections: { id: string; icon: IconName; count?: number }[] = [
    { id: "connections", icon: "key" },
    { id: "production", icon: "gear", count: 2 },
    { id: "fonts", icon: "font" },
    { id: "cost", icon: "coins" },
    { id: "languages", icon: "book" },
    { id: "language", icon: "globe" },
  ];
  return (
    <div className="tz-vt-lists">
      <div className="tz-vt-list">
        <span className="tz-vt-lb">{t("lists.fixed")}</span>
        <div className="tz-vt-box">
          <ListRow current title={t("lists.sheet")} sub={t("lists.sheetSub")} leading={<span className="tz-vt-ph" />} onClick={noop} />
          <ListRow title={t("lists.sticker")} sub={t("lists.stickerSub")} leading={<span className="tz-vt-ph" />} onClick={noop} />
        </div>
      </div>
      <div className="tz-vt-list">
        <span className="tz-vt-lb">{t("lists.auto")}</span>
        <div className="tz-vt-box">
          <ListRow density="auto" current title={t("lists.version3")} sub={t("lists.version3Sub")} trailing={<StatusDot tone="ok" label={t("lists.live")} />} onClick={noop} />
          <ListRow density="auto" title={t("lists.version2")} sub={t("lists.version2Sub")} onClick={noop} />
        </div>
      </div>
      <div className="tz-vt-list">
        <span className="tz-vt-lb">{t("lists.compact")}</span>
        <div className="tz-vt-box">
          {sections.map((s) => (
            <ListRow
              key={s.id}
              density="compact"
              current={cur === s.id}
              leading={<Icon name={s.icon} size={15} />}
              title={t(`lists.${s.id}`)}
              trailing={s.count}
              onClick={() => setCur(s.id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** Kılavuzlu akış: 240 px bant, banda binen kart, adım çipleri. */
function FullDemo() {
  const { t } = useTranslation("showcase");
  const [kinds, setKinds] = useState({ wedding: true, baby: true, product: false });
  return (
    <DemoFrame
      full
      className="tz-vt-tall tz-vt-full"
      row={
        <FullBand
          kicker={[{ label: t("full.kicker") }, { label: t("full.step") }]}
          title={t("full.title")}
          sub={t("full.sub")}
          aside={<StepChips steps={[t("full.step1"), t("full.step2"), t("full.step3")]} current={0} />}
        />
      }
    >
      <BandCard
        footer={
          <>
            <Button size="guided" variant="quiet">
              {t("full.skip")}
            </Button>
            <ToolSpacer />
            <Button size="guided" variant="primary">
              {t("full.next")} <Kbd keys="Enter" on="primary" />
            </Button>
          </>
        }
      >
        <div className="tz-vt-kinds">
          <Checkbox checked={kinds.wedding} onChange={(v) => setKinds({ ...kinds, wedding: v })} label={t("full.wedding")} />
          <Checkbox checked={kinds.baby} onChange={(v) => setKinds({ ...kinds, baby: v })} label={t("full.baby")} />
          <Checkbox checked={kinds.product} onChange={(v) => setKinds({ ...kinds, product: v })} label={t("full.product")} />
        </div>
      </BandCard>
    </DemoFrame>
  );
}

export default function TemelVitrin() {
  const { t } = useTranslation("showcase");
  const [text, setText] = useState("");
  const [area, setArea] = useState(t("form.areaValue"));
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<"mm" | "cm">("mm");
  const [seg, setSeg] = useState<"normal" | "bold" | "script">("bold");
  const [num, setNum] = useState(38);
  const [on, setOn] = useState(true);
  const [off, setOff] = useState(false);
  const [archived, setArchived] = useState(false);
  const [check, setCheck] = useState<boolean | "mixed">("mixed");
  const [checked, setChecked] = useState(true);
  const [plain, setPlain] = useState(false);
  const [pressed, setPressed] = useState(true);
  const [loading, setLoading] = useState(true);
  const variants: { v: ButtonVariant; label: string }[] = [
    { v: "primary", label: t("buttons.primary") },
    { v: "secondary", label: t("buttons.secondary") },
    { v: "quiet", label: t("buttons.quiet") },
    { v: "danger", label: t("buttons.danger") },
  ];
  const sizes: { s: ButtonSize; label: string }[] = [
    { s: "mini", label: t("buttons.sizeMini") },
    { s: "tool", label: t("buttons.sizeTool") },
    { s: "page", label: t("buttons.sizePage") },
    { s: "guided", label: t("buttons.sizeGuided") },
  ];
  return (
    <>
      <Section title={t("sections.frame")}>
        <WorkDemo />
        <TabsDemo />
        <TabsFirstDemo />
      </Section>
      <Section title={t("sections.lists")}>
        <ListsDemo />
      </Section>
      <Section title={t("sections.band")}>
        <FullDemo />
      </Section>
      <Section title={t("sections.buttons")}>
        {sizes.map(({ s, label }) => (
          <Row key={s} label={label}>
            {variants.map(({ v, label: vl }) => (
              <Button key={v} variant={v} size={s}>
                {vl}
              </Button>
            ))}
          </Row>
        ))}
        <Row label={t("buttons.withIcon")}>
          <Button variant="primary" icon="check">
            {t("buttons.primary")}
          </Button>
          <Button icon="print">{t("buttons.print")}</Button>
          <Button variant="quiet" icon="refresh">
            {t("buttons.quiet")}
          </Button>
          <Button variant="danger" icon="trash">
            {t("buttons.danger")}
          </Button>
          <Button variant="primary" size="page" icon="check">
            {t("buttons.primary")}
          </Button>
        </Row>
        <Row label={t("buttons.withKbd")}>
          <Button variant="primary">
            {t("buttons.primary")} <Kbd keys="2" on="primary" />
          </Button>
          <Button>
            {t("buttons.secondary")} <Kbd keys="D" />
          </Button>
          <Button command="canvas.fit" kbd icon="fit" />
          <Button command="canvas.zoomIn" />
        </Row>
        <Row label={t("buttons.states")}>
          <Button variant="primary" loading={loading} onClick={() => setLoading(!loading)}>
            {t("buttons.loading")}
          </Button>
          <Button variant="primary" disabled>
            {t("buttons.primary")}
          </Button>
          <Button disabled>{t("buttons.secondary")}</Button>
          <Button variant="quiet" disabled>
            {t("buttons.quiet")}
          </Button>
        </Row>
        <Row label={t("buttons.wide")}>
          <div className="tz-vt-wide">
            <Button variant="primary" size="page" wide>
              {t("buttons.primary")} <Kbd keys="2" on="primary" />
            </Button>
          </div>
        </Row>
        <Row label={t("buttons.icons")}>
          <IconButton icon="cursor" label={t("buttons.iconSelect")} size={32} pressed={pressed} onClick={() => setPressed(!pressed)} />
          <IconButton icon="hand" label={t("buttons.iconMove")} size={32} />
          <IconButton icon="trash" label={t("buttons.danger")} size={28} />
          <IconButton icon="fit" command="canvas.fit" size={28} />
          <IconButton icon="dots" label={t("buttons.iconMore")} size={26} />
          <IconButton icon="undo" label={t("buttons.iconUndo")} disabled />
        </Row>
        <Row label={t("buttons.iconSet")}>
          <div className="tz-vt-icons">
            {ICON_NAMES.map((n) => (
              <span key={n} className="tz-vt-ic">
                <Icon name={n} />
                <small className="tz-mono">{n}</small>
              </span>
            ))}
          </div>
        </Row>
        <Row label={t("buttons.kbd")}>
          <Kbd keys="Enter" />
          <Kbd keys="Alt 1" />
          <span className="tz-vt-chip tz-vt-chip--primary">
            <Kbd keys="2" on="primary" />
          </span>
          <span className="tz-vt-chip tz-vt-chip--band">
            <Kbd keys="?" on="band" />
          </span>
        </Row>
      </Section>
      <Section title={t("sections.form")}>
        <Row label={t("form.fields")}>
          <TextField value={text} onChange={setText} placeholder={t("form.placeholder")} unit="mm" aria-label={t("form.name")} />
          <TextField value="Elif & Kerem" onChange={noop} aria-label={t("form.name")} />
          <TextField value="12" onChange={noop} invalid aria-label={t("form.name")} />
          <TextField value={t("form.disabledValue")} onChange={noop} disabled aria-label={t("form.name")} />
          <SearchField value={q} onChange={setQ} command="canvas.fit" placeholder={t("form.search")} aria-label={t("form.search")} />
        </Row>
        <Row label={t("form.choices")}>
          <Select
            value={sel}
            options={[
              { value: "mm", label: t("form.unitMm") },
              { value: "cm", label: t("form.unitCm") },
            ]}
            onChange={setSel}
            aria-label={t("form.unit")}
          />
          <Segmented
            value={seg}
            options={[
              { value: "normal", label: t("form.weightNormal") },
              { value: "bold", label: t("form.weightBold") },
              { value: "script", label: t("form.weightScript") },
            ]}
            onChange={setSeg}
            aria-label={t("form.weight")}
          />
          <NumberStepper value={num} step={1} min={10} max={120} format={(v) => `${v} mm`} onChange={setNum} aria-label={t("form.diameter")} />
          <NumberStepper value={3.8} step={0.1} format={(v) => `${String(v).replace(".", ",")} cm`} onChange={noop} aria-label={t("form.height")} disabled />
        </Row>
        <Row label={t("form.toggles")}>
          <Switch checked={on} onChange={setOn} label={t("form.marks")} />
          <Switch checked={off} onChange={setOff} label={t("form.marks")} />
          <Switch checked onChange={noop} label={t("form.marks")} disabled />
          <Switch checked={archived} onChange={setArchived} label={t("form.showArchived")} showLabel />
          <Checkbox checked={checked} onChange={setChecked} label={t("form.all")} />
          <Checkbox checked={plain} onChange={setPlain} label={t("form.all")} />
          <Checkbox checked={check} onChange={setCheck} label={t("form.all")} />
          <Checkbox checked onChange={noop} label={t("form.all")} disabled />
        </Row>
        <div className="tz-vt-fields">
          <Field label={t("form.name")} hint={t("form.nameHint")}>
            <TextField value="Elif & Kerem" onChange={noop} />
          </Field>
          <Field label={t("form.orderNo")} error={t("form.orderError")}>
            <TextField value="10x82" onChange={noop} />
          </Field>
          <Field label={t("form.customerText")} hint={t("form.customerHint")}>
            <TextArea value={area} onChange={setArea} autoGrow />
          </Field>
        </div>
      </Section>
      <Section title={t("sections.status")}>
        <Row label={t("status.dots")}>
          <StatusDot tone="ok" label={t("status.ok")} />
          <StatusDot tone="warn" label={t("status.warn")} />
          <StatusDot tone="error" label={t("status.error")} />
          <StatusDot tone="busy" label={t("status.busy")} />
          <StatusDot tone="ready" label={t("status.ready")} />
          <StatusDot tone="idle" label={t("status.idle")} />
        </Row>
        <Row label={t("status.dotsBare")}>
          <StatusDot tone="ok" />
          <StatusDot tone="warn" />
          <StatusDot tone="error" />
          <StatusDot tone="busy" />
          <StatusDot tone="ready" />
          <StatusDot tone="idle" />
        </Row>
        <Row label={t("status.tags")}>
          <IssueBadge tone="error">{t("status.badgeError")}</IssueBadge>
          <IssueBadge tone="warn">{t("status.badgeWarn")}</IssueBadge>
          <Tag>{t("status.tagNeutral")}</Tag>
          <Tag tone="accent">{t("status.tagAccent")}</Tag>
          <Tag tone="info">{t("status.tagInfo")}</Tag>
        </Row>
        <Row label={t("status.progress")}>
          <ProgressBar value={6} max={12} label={t("status.progressLabel")} />
          <ProgressBar value={12} max={12} label={t("status.progressLabel")} />
          <span className="tz-vt-mut">
            <Num>6 / 12</Num>
          </span>
        </Row>
        <div className="tz-vt-issues">
          <IssueBox tone="error" fixes={<Button size="mini">{t("status.fixShrink")}</Button>}>
            {t("status.issueError")}
          </IssueBox>
          <IssueBox
            tone="warn"
            fixes={
              <>
                <Button size="mini">{t("status.fixShrink")}</Button>
                <Button size="mini">{t("status.fixSplit")}</Button>
              </>
            }
          >
            {t("status.issueWarn")}
          </IssueBox>
          <IssueBox tone="ok">{t("status.issueOk")}</IssueBox>
        </div>
        <div className="tz-vt-empty">
          <EmptyState icon="layout" title={t("status.emptyTitle")} action={<Button variant="secondary">{t("status.emptyAction")}</Button>} />
        </div>
      </Section>
      <Section title={t("sections.numbers")}>
        <Row label={t("numbers.label")}>
          <Num>3,8 cm · 01:11 · 12.09.2026 · 38 mm</Num>
        </Row>
      </Section>
    </>
  );
}
