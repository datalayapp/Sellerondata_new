import type { PrintItem, PrintSessionNotice, PrintTemplate, PrintTemplateView } from "@tagpress/domain";
import { type DragEvent as ReactDragEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { noticeText } from "../../../i18n/sunucu.ts";
import { pagePreviewUrl } from "../mantik/api.ts";
import { lodFor, type Pt, type Rect, rectFromPoints, thumbWidth, unionRect } from "../../../tezgah/tuval/canvas-math.ts";
import { cellLabels, dropItems, hitItem, type ItemSizes, itemSize, itemsInRect, type Page, pageAt, type Session, type Templates } from "../mantik/desk-model.ts";
import { boardBounds, dropGhost, movableIds, moveTargets, pageFocusRect, targetsLocked } from "../mantik/masa.ts";
import { boxSelect, clickSelect, pressSelect } from "../mantik/selection.ts";
import type { ShelfRow } from "../mantik/shelf.ts";
import type { AlignMode } from "../mantik/slot-geometry.ts";
import {
  Button,
  CanvasViewport,
  CenterColumn,
  cx,
  IconButton,
  IssueBox,
  Menu,
  type MenuItem,
  SelectionBar,
  StatusBar,
  ToolDivider,
  ToolGroup,
  ToolSpacer,
  ToolStrip,
  Tooltip,
  useViewport,
  ZoomControl,
} from "../../../tezgah/index.ts";
import { type Lod, Sayfa } from "./Sayfa.tsx";
import { shelfDrag } from "./surukle.ts";

export type Arrange = { align: AlignMode } | { distribute: "x" | "y" };

type Mods = { shift: boolean; ctrl: boolean };
type Drag =
  | { mode: "move"; start: Pt; ids: string[]; els: HTMLElement[]; moved: boolean; dx: number; dy: number; pressed: string; wasSelected: boolean; mods: Mods }
  | { mode: "box"; start: Pt; mods: Mods; pageId: string | null };

const EMPTY_WORLD: Rect = { x: 0, y: 0, w: 210, h: 297 };
const NO_LABELS: ReturnType<typeof cellLabels> = [];

export interface TuvalProps {
  session: Session;
  /** Oturum bildirimleri (düzenleyiciden; sürüm artmadan da değişebilir). */
  notices: readonly PrintSessionNotice[];
  layout: ReadonlyMap<string, Rect>;
  templates: Templates;
  liveTemplates: PrintTemplateView[];
  sizes: ItemSizes;
  orders: ReadonlyMap<string, { orderNo: string | null; quantity: number }>;
  selected: string[];
  /** Seçim şeridinin hedefi (kilitli sayfadakiler hariç). */
  editable: ReadonlySet<string>;
  inSlot: { any: boolean; offset: boolean };
  activePageId: string | null;
  readOnly: boolean;
  /** Baskı önizlemesi: kesim çizgisi, kesim ve kayıt işaretleri. */
  preview: boolean;
  onPreview(v: boolean): void;
  previewOf(variantId: string): string;
  thumbVersion: string;
  /** Yeni sayfa eklenince o sayfaya odaklan (`n` her istekte artar). */
  focus: { pageId: string; n: number } | null;
  saving: boolean;
  saveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  replanning: boolean;
  onUndo(): void;
  onRedo(): void;
  onReplan(): void;
  onNewPage(templateId: string): void;
  onTemplates(): void;
  onSelect(ids: string[]): void;
  onActivePage(id: string | null): void;
  onCommit(next: Session): void;
  onAdjust(item: PrintItem): void;
  onAdjustSelected(): void;
  onShelfDrop(pageId: string, point: Pt, row: ShelfRow, mods: { shift: boolean; alt: boolean }): void;
  onRefuse(message: string): void;
  onArrange(how: Arrange): void;
  onRecenter(): void;
  onRelease(): void;
  onDuplicate(): void;
  onRemove(): void;
}

/**
 * Orta sütun: araç şeridi (Sayfa ekle, Yeniden planla, geri al / ileri al, baskı önizlemesi), seçim şeridi (Hizala,
 * yuvaya al, yuvadan çıkar, Yazıyı düzelt, çoğalt, sil), cetvelli tuvalde oturumun sayfaları ve durum satırı.
 *
 * Başarım: sayfalar `Artboard` (görünür alan dışı çizilmez) ve `memo`'lu `Sayfa`; uzaktaki sayfa sunucunun küçük
 * resmi, yakındaki etiket önizlemeleri (canvas-math `lodFor`). Sürüklerken öğeler DOM dönüşümüyle kayar, bırakınca tek
 * değişiklik (`onCommit`); raftan sürüklerken hayalet ve ipucu yine DOM'da.
 */
export function Tuval(p: TuvalProps) {
  const { t } = useTranslation("printDesk");
  const bounds = useMemo(() => boardBounds(p.layout) ?? EMPTY_WORLD, [p.layout]);
  const api = useViewport({ world: bounds });
  const apiRef = useRef(api);
  apiRef.current = api;
  const cv = api.canvas;
  const stageRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const hintRef = useRef<HTMLDivElement>(null);
  const marqueeRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const [failedThumbs, setFailedThumbs] = useState<ReadonlySet<string>>(new Set());
  const markFailed = useCallback((pageId: string) => setFailedThumbs((s) => new Set(s).add(pageId)), []);
  const { session, layout, templates, sizes } = p;

  // Her yeni oturumda bir kez bütün sayfalar sığdırılır (tuval boyutu bilindiğinde).
  const fitted = useRef<string | null>(null);
  const sized = api.size.w > 0;
  useEffect(() => {
    if (!sized || !layout.size || fitted.current === session.id) return;
    fitted.current = session.id;
    apiRef.current.fit(boardBounds(layout));
  }, [sized, layout, session.id]);
  // Yeni sayfaya odak: her istekte bir kez (sayfa kaydedilip kimliği gerçeğe dönünce düzen yenilenir; görünüm sıçramasın).
  const focusN = p.focus?.n;
  const focusedN = useRef<number | undefined>(undefined);
  useEffect(() => {
    const r = p.focus ? layout.get(p.focus.pageId) : undefined;
    if (r && focusedN.current !== focusN) {
      focusedN.current = focusN;
      apiRef.current.fit(pageFocusRect(r));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- odak yalnız yeni istekte (focusN) ya da düzen değişince; p.focus her çizimde yeni nesne, apiRef bir ref
  }, [focusN, layout]);

  // Yeni durum çizilince sürüklemenin geçici dönüşümleri kalkar (öğeler kendi yerlerinde).
  useLayoutEffect(() => {
    for (const el of stageRef.current?.querySelectorAll<HTMLElement>("[data-item][data-drag]") ?? []) {
      el.style.transform = "";
      el.removeAttribute("data-drag");
    }
  }, [session]);

  const pagesById = useMemo(() => new Map(session.pages.map((x) => [x.id, x])), [session.pages]);
  const selByPage = useMemo(() => {
    const set = new Set(p.selected);
    const m = new Map<string, string>();
    for (const pg of session.pages) {
      const ids = pg.items.filter((i) => set.has(i.id)).map((i) => i.id);
      if (ids.length) m.set(pg.id, ids.join(","));
    }
    return m;
  }, [p.selected, session.pages]);
  const labelsByPage = useMemo(() => new Map(session.pages.map((pg) => [pg.id, cellLabels(pg, templates.get(pg.templateId), p.orders)])), [session.pages, templates, p.orders]);

  // Cetvel vurgusu: seçili öğelerin masadaki kutusu.
  const highlight = useMemo(() => {
    const boxes: Rect[] = [];
    const set = new Set(p.selected);
    for (const pg of session.pages) {
      const o = layout.get(pg.id);
      if (!o) continue;
      const tpl = templates.get(pg.templateId);
      for (const it of pg.items) {
        if (!set.has(it.id)) continue;
        const s = itemSize(it, tpl, sizes);
        boxes.push({ x: o.x + it.xMm - s.w / 2, y: o.y + it.yMm - s.h / 2, w: s.w, h: s.h });
      }
    }
    const u = unionRect(boxes);
    return u ? { x: [u.x, u.x + u.w] as [number, number], y: [u.y, u.y + u.h] as [number, number] } : undefined;
  }, [p.selected, session.pages, layout, templates, sizes]);

  // Ayrıntı düzeyi: tuval boyutu bilinmeden yalnız kağıt; uzakta küçük resim, yakında etiketler.
  const zoom = api.view.zoom;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const lodOf = (pg: Page, r: Rect): Lod => (!sized ? "none" : failedThumbs.has(pg.id) ? "detail" : lodFor(r.w, zoom));

  // ---------------------------------------------------------------- isabet

  const hitAt = (pt: Pt): { page: Page; item: PrintItem | null } | null => {
    const at = pageAt(layout, pt);
    if (!at) return null;
    const page = pagesById.get(at.pageId);
    if (!page) return null;
    return { page, item: hitItem(page, templates.get(page.templateId), at.local, sizes) };
  };
  const itemEls = (ids: readonly string[]): HTMLElement[] => {
    const want = new Set(ids);
    return [...(stageRef.current?.querySelectorAll<HTMLElement>("[data-item]") ?? [])].filter((el) => want.has(el.dataset.item ?? ""));
  };
  const resetDrag = () => {
    for (const el of stageRef.current?.querySelectorAll<HTMLElement>("[data-item][data-drag]") ?? []) {
      el.style.transform = "";
      el.removeAttribute("data-drag");
    }
  };
  const showMarquee = (r: Rect | null) => {
    const m = marqueeRef.current;
    if (!m) return;
    m.hidden = !r;
    if (r) Object.assign(m.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  };

  // ---------------------------------------------------------------- fare

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest("[data-tz-overlay], button, a, input")) return;
    e.currentTarget.focus({ preventScroll: true });
    const pt = cv.clientToWorld(e.clientX, e.clientY);
    const mods = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
    const hit = hitAt(pt);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (hit?.item) {
      const next = pressSelect(p.selected, hit.item.id, mods);
      if (next.join() !== p.selected.join()) p.onSelect(next);
      if (hit.page.id !== p.activePageId) p.onActivePage(hit.page.id);
      const ids = movableIds(session, next, p.readOnly);
      drag.current = { mode: "move", start: pt, ids, els: itemEls(ids), moved: false, dx: 0, dy: 0, pressed: hit.item.id, wasSelected: p.selected.includes(hit.item.id), mods };
    } else {
      drag.current = { mode: "box", start: pt, mods, pageId: hit?.page.id ?? null };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const pt = cv.clientToWorld(e.clientX, e.clientY);
    if (d.mode === "box") {
      const r = rectFromPoints(d.start, pt);
      if (r.w * cv.get().zoom >= 3 || r.h * cv.get().zoom >= 3) showMarquee(r);
      return;
    }
    if (!d.ids.length) return;
    const dx = pt.x - d.start.x;
    const dy = pt.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) * cv.get().zoom < 3) return;
    d.moved = true;
    d.dx = dx;
    d.dy = dy;
    for (const el of d.els) {
      el.dataset.drag = "1";
      el.style.transform = `translate(${dx}px, ${dy}px)`;
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const pt = cv.clientToWorld(e.clientX, e.clientY);
    if (d.mode === "box") {
      showMarquee(null);
      const r = rectFromPoints(d.start, pt);
      if (r.w * cv.get().zoom < 3 && r.h * cv.get().zoom < 3) {
        p.onSelect(clickSelect(p.selected, null, d.mods));
        p.onActivePage(d.pageId);
      } else p.onSelect(boxSelect(p.selected, itemsInRect(session, layout, templates, r, sizes), d.mods));
      return;
    }
    if (!d.moved) {
      // Sürüklemeden tıklama: Shift/Ctrl ile seçili olan seçimden çıkar; seçili gruptaki birine düz tık yalnız onu seçer.
      if ((d.mods.shift || d.mods.ctrl) && d.wasSelected) p.onSelect(clickSelect(p.selected, d.pressed, d.mods));
      else if (!d.mods.shift && !d.mods.ctrl && p.selected.length > 1) p.onSelect([d.pressed]);
      return;
    }
    const pointerPage = pageAt(layout, pt);
    if (!pointerPage) {
      resetDrag();
      return;
    }
    const targets = moveTargets(session, layout, d.ids, d.dx, d.dy, pointerPage.pageId);
    if (targetsLocked(session, targets)) {
      resetDrag();
      p.onRefuse(t("move.locked"));
      return;
    }
    const next = dropItems(session, targets, templates, e.altKey);
    if (next === session) resetDrag();
    else p.onCommit(next);
  };

  // ---------------------------------------------------------------- raftan bırakma

  const hideGhost = () => {
    if (ghostRef.current) ghostRef.current.hidden = true;
    if (hintRef.current) hintRef.current.hidden = true;
  };
  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    const row = shelfDrag.current;
    if (p.readOnly || !row) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    // Kilitli ya da türü uymayan sayfa (sticker → etiket sayfası): hayalet yok, bırakınca nedeni söylenir.
    const g = dropGhost(session, layout, templates, sizes, cv.clientToWorld(e.clientX, e.clientY), row, e.altKey);
    const el = ghostRef.current;
    if (!el) return;
    if (!g) {
      hideGhost();
      return;
    }
    el.hidden = false;
    el.classList.toggle("is-rect", templates.get(pagesById.get(g.pageId)?.templateId ?? "")?.kind === "sticker");
    Object.assign(el.style, { left: `${g.x - g.w / 2}px`, top: `${g.y - g.h / 2}px`, width: `${g.w}px`, height: `${g.h}px` });
    // Değiştirici ipucu yalnız raftan sürüklerken, hayaletin yanında (kalıcı şerit yok).
    const hint = hintRef.current;
    const box = cv.containerRef.current?.getBoundingClientRect();
    if (hint && box) {
      hint.textContent = t("drop.hint", { count: Math.max(1, row.remaining) });
      hint.style.left = `${e.clientX - box.left + 18}px`;
      hint.style.top = `${e.clientY - box.top + 18}px`;
      hint.hidden = false;
    }
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    hideGhost();
    const row = shelfDrag.current;
    shelfDrag.current = null;
    if (p.readOnly || !row) return;
    e.preventDefault();
    const at = pageAt(layout, cv.clientToWorld(e.clientX, e.clientY));
    if (!at || !pagesById.has(at.pageId)) {
      p.onRefuse(t("drop.noPage"));
      return;
    }
    if (pagesById.get(at.pageId)?.locked) {
      p.onRefuse(t("drop.locked"));
      return;
    }
    p.onShelfDrop(at.pageId, at.local, row, { shift: e.shiftKey, alt: e.altKey });
  };

  // ---------------------------------------------------------------- şeritler

  const single = p.editable.size === 1;
  const alignItems: (MenuItem | "sep")[] = [
    { label: single ? t("align.paperLeft") : t("align.left"), icon: "dl", onSelect: () => p.onArrange({ align: "left" }) },
    { label: t("align.hcenter"), icon: "ah", onSelect: () => p.onArrange({ align: "hcenter" }) },
    { label: t("align.right"), icon: "dr", onSelect: () => p.onArrange({ align: "right" }) },
    { label: t("align.top"), icon: "dt", onSelect: () => p.onArrange({ align: "top" }) },
    { label: t("align.vcenter"), icon: "av", onSelect: () => p.onArrange({ align: "vcenter" }) },
    { label: t("align.bottom"), icon: "db", onSelect: () => p.onArrange({ align: "bottom" }) },
    "sep",
    { label: t("align.distributeX"), icon: "dx", disabled: p.editable.size < 3, onSelect: () => p.onArrange({ distribute: "x" }) },
    { label: t("align.distributeY"), icon: "dy", disabled: p.editable.size < 3, onSelect: () => p.onArrange({ distribute: "y" }) },
  ];
  const pageItems: (MenuItem | "sep")[] = p.liveTemplates.length
    ? p.liveTemplates.map((x) => ({ label: t("strip.templateOption", { name: x.name, count: x.capacity }), onSelect: () => p.onNewPage(x.id) }))
    : [{ label: t("strip.noTemplates"), onSelect: p.onTemplates }];

  const strip = (
    <ToolStrip label={t("strip.label")}>
      {!p.readOnly && (
        <ToolGroup>
          <Menu
            align="start"
            trigger={(tp) => (
              <Button {...tp} variant="quiet" icon="filep" chevron>
                {t("strip.addPage")}
              </Button>
            )}
            items={pageItems}
          />
          <Button variant="quiet" icon="refresh" loading={p.replanning} title={t("strip.replanHint")} onClick={p.onReplan}>
            {t("strip.replan")}
          </Button>
        </ToolGroup>
      )}
      {!p.readOnly && <ToolDivider />}
      <ToolGroup>
        <IconButton icon="undo" command="baskiMasa.undo" disabled={!p.canUndo} onClick={p.onUndo} />
        <IconButton icon="redo" command="baskiMasa.redo" disabled={!p.canRedo} onClick={p.onRedo} />
      </ToolGroup>
      <ToolSpacer />
      <IconButton icon="cut" pressed={p.preview} label={t("strip.preview")} onClick={() => p.onPreview(!p.preview)} />
    </ToolStrip>
  );

  const lockedCount = p.selected.length - p.editable.size;
  const selectionBar =
    p.selected.length > 0 && !p.readOnly ? (
      <SelectionBar label={lockedCount > 0 ? t("selection.countLocked", { count: p.selected.length, locked: lockedCount }) : t("selection.count", { count: p.selected.length })} onClear={() => p.onSelect([])}>
        <Menu align="start" trigger={(tp) => <Button {...tp} variant="quiet" icon="dl" disabled={!p.editable.size}>{t("align.menu")}</Button>} items={alignItems} />
        <IconButton icon="cross" label={t("selection.recenter")} disabled={!p.inSlot.offset} onClick={p.onRecenter} />
        <IconButton icon="unlink" label={t("selection.release")} disabled={!p.inSlot.any} onClick={p.onRelease} />
        <ToolSpacer />
        <Button command="baskiMasa.adjust" disabled={p.selected.length !== 1} onClick={p.onAdjustSelected}>
          {t("selection.adjust")}
        </Button>
        <IconButton icon="copy" command="baskiMasa.duplicate" disabled={!p.editable.size} onClick={p.onDuplicate} />
        <IconButton icon="trash" command="baskiMasa.delete" disabled={!p.editable.size} onClick={p.onRemove} />
      </SelectionBar>
    ) : undefined;

  // Oturum bildirimleri (sunucudan): eski ölçüyle dizilmiş taslak, eski ölçüyle basılmış arşiv, küçük sticker yazısı.
  const list = p.notices;
  const stale = list.find((n) => n.code === "plan-stale");
  const old = list.find((n) => n.code === "printed-old-scale");
  const small = list.filter((n) => n.code === "sticker-small-text");
  const notices =
    stale || old || small.length ? (
      <div className="bm-notices">
        {stale && (
          <IssueBox
            tone="warn"
            fixes={
              !p.readOnly && (
                <Button variant="quiet" size="mini" loading={p.replanning} onClick={p.onReplan}>
                  {t("notices.replan")}
                </Button>
              )
            }
          >
            {noticeText(stale)}
          </IssueBox>
        )}
        {old && <IssueBox tone="info">{noticeText(old)}</IssueBox>}
        {small.length === 1 && <IssueBox tone="warn">{noticeText(small[0]!)}</IssueBox>}
        {small.length > 1 && (
          <IssueBox tone="warn">
            {t("notices.stickerSmallTitle")} {small.map((n) => t("notices.stickerSmallItem", n.params)).join(" · ")}
          </IssueBox>
        )}
      </div>
    ) : null;

  const hasExtras = session.pages.some((pg) => pg.items.some((i) => i.extra));
  const status = (
    <StatusBar end={<ZoomControl api={api} presets={["fit", "actual"]} labels={{ fit: t("status.fitAll") }} />}>
      <span className="bm-sb-k">{t("status.unit")}</span>
      <span className={cx("bm-sb-k", p.saveError && "bm-err")} aria-live="polite">
        {p.saving ? t("status.saving") : p.saveError ? t("status.saveFailed") : t("status.saved")}
      </span>
      {p.readOnly && <span className="bm-sb-k">{t("status.readOnly")}</span>}
      {hasExtras && (
        <Tooltip content={t("status.extras")}>
          <span className="bm-legend">
            <i aria-hidden="true" />
            <span>{t("status.extrasShort")}</span>
          </span>
        </Tooltip>
      )}
    </StatusBar>
  );

  const hint = <div ref={hintRef} className="bm-dhint" hidden aria-hidden="true" />;

  return (
    <CenterColumn
      strip={strip}
      selectionBar={
        <>
          {notices}
          {selectionBar}
        </>
      }
      status={status}
    >
      <div
        ref={stageRef}
        className="bm-stage"
        tabIndex={0}
        role="application"
        aria-label={t("canvas.label", { count: session.pages.length })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          showMarquee(null);
          resetDrag();
        }}
        onDoubleClick={(e) => {
          const hit = hitAt(cv.clientToWorld(e.clientX, e.clientY));
          if (hit?.item && !p.readOnly) p.onAdjust(hit.item);
        }}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hideGhost();
        }}
        onDrop={onDrop}
      >
        <CanvasViewport api={api} rulers highlight={highlight} overlay={hint}>
          {session.pages.map((pg) => {
            const r = layout.get(pg.id);
            if (!r) return null;
            const tpl: PrintTemplate | undefined = templates.get(pg.templateId);
            const lod = lodOf(pg, r);
            return (
              <Sayfa
                key={pg.id}
                page={pg}
                template={tpl}
                at={r}
                lod={lod}
                thumbUrl={lod === "thumb" ? pagePreviewUrl(pg.id, thumbWidth(r.w, zoom, dpr), p.thumbVersion) : null}
                onThumbError={markFailed}
                sizes={sizes}
                selectedKey={selByPage.get(pg.id) ?? ""}
                active={pg.id === p.activePageId}
                preview={p.preview}
                previewOf={p.previewOf}
                labels={lod === "detail" ? (labelsByPage.get(pg.id) ?? NO_LABELS) : NO_LABELS}
              />
            );
          })}
          <div ref={ghostRef} className="bm-ghost" hidden aria-hidden="true" />
          <div ref={marqueeRef} className="bm-marq" hidden aria-hidden="true" />
        </CanvasViewport>
      </div>
    </CenterColumn>
  );
}
