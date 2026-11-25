import { type Issue, type VariantAdjust } from "@tagpress/domain";
import { useTranslation } from "react-i18next";
import { issueText } from "../../i18n/sunucu.ts";
import { editOf } from "./mantik/adjust-edit.ts";
import { isSelected, lineAdjustOf, toggleSel } from "./mantik/adjust-select.ts";
import { Button, Icon, IssueBox, ListRow, Panel } from "../../tezgah/index.ts";
import type { Duzelt } from "./useDuzelt.ts";

const neutral = (l: { dx: number; dy: number; scale: number; strokePx?: number }) =>
  Math.abs(l.dx) < 0.005 && Math.abs(l.dy) < 0.005 && Math.abs(l.scale - 1) < 0.00005 && Math.abs(l.strokePx ?? 0) < 0.005;

/** Satır elle ayarlı mı (kendi kaydırması, boyutu, kalınlığı ya da metin / font düzenlemesi var). */
export const lineIsOwn = (cur: VariantAdjust, i: number) => !neutral(lineAdjustOf(cur, i)) || !!editOf(cur, i);

/**
 * Sol panel: satırlar (tık seçer, Ctrl/Shift + tık ekler ya da çıkarır; tuvalde Tab ile gezilir), başlıkta "Bütün yazı",
 * altta otomatik denetimin sonucu.
 */
export function SatirPaneli({ d }: { d: Duzelt }) {
  const { t } = useTranslation("adjust");
  const { layout, cur, sel } = d;
  const pick = (i: number, add: boolean) => {
    if (d.editing) void d.commitEdit();
    d.setSel(add ? toggleSel(sel, i, layout.lines.length) : [i]);
  };
  return (
    <Panel
      side="left"
      title={t("lines.title")}
      count={layout.lines.length}
      actions={
        // Maket .lnk: basılıyken de yalnız mor yazı bağlantısı (seçili olduğu sağ panel başlığından okunur).
        <Button variant="link" command="duzelt.selectAll" kbd={false} aria-pressed={sel === null} onClick={() => d.setSel(null)}>
          {t("lines.all")}
        </Button>
      }
      footer={hasCheck(d.check.issues, d.check.contained) ? <Denetim issues={d.check.issues} contained={d.check.contained} /> : undefined}
    >
      <div className="dz-lines">
        {layout.lines.map((line, i) => {
          const own = lineIsOwn(cur, i);
          const multi = !!sel && sel.length > 1 && isSelected(sel, i);
          return (
            <ListRow
              key={i}
              leading={<span className="dz-ln-no tz-mono">{i + 1}</span>}
              title={line.text}
              sub={own ? t("lines.own") : undefined}
              density="card"
              current={(!!sel && sel.length === 1 && sel[0] === i) || undefined}
              multi={multi || undefined}
              onClick={(e) => pick(i, e.ctrlKey || e.metaKey || e.shiftKey)}
            />
          );
        })}
      </div>
    </Panel>
  );
}

export const hasCheck = (issues: Issue[], contained: boolean) => contained || issues.length > 0;

/** Otomatik denetim: kaydetmeyi engellemez; tek satır (sorun yoksa "kesimin içinde", kutusuz yeşil yazı). Sonuç yoksa çizilmez. */
export function Denetim({ issues, contained }: { issues: Issue[]; contained: boolean }) {
  const { t } = useTranslation("adjust");
  const shown = issues.filter((i) => i.severity !== "info");
  const info = issues.filter((i) => i.severity === "info");
  return (
    <div className="dz-check" role="status" aria-live="polite">
      {shown.map((i, n) => (
        <IssueBox key={`${i.code}-${n}`} tone={i.severity === "error" ? "error" : "warn"}>
          {issueText(i)}
        </IssueBox>
      ))}
      {info.map((i, n) => (
        <p key={`${i.code}-i${n}`} className="dz-note">
          {issueText(i)}
        </p>
      ))}
      {contained && (
        <p className="dz-ok">
          <Icon name="okc" size={15} />
          {t("check.ok")}
        </p>
      )}
    </div>
  );
}
