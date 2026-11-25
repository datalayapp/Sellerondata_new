import type { BatchSummary } from "@tagpress/domain";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ElleEkleAlanlar, useElleEkle } from "../../ortak/ElleEkle.tsx";
import { isTypingTarget } from "../ice-aktar/mantik/desk.ts";
import { relativeStamp } from "./mantik/jobs.ts";
import { looksLikeOrders } from "./mantik/yukle.ts";
import { Button, Icon } from "../../tezgah/index.ts";

/**
 * Alım alanı (maket 1 ve 2): "Dosya yükle" (sürükle-bırak dahil) ve "Elle ekle". Liste boşken büyük (bırakma alanı,
 * sayfa içi elle ekleme formu, üç adım), doluyken ince ama her zaman görünür şerit. Yüklenen dosya doğrudan
 * "Üretilmeyi bekleyenler"e düşer; üretim başlamaz.
 */

export function IntakeEmpty({ languageId, uploading, onChoose, onAdded }: { languageId: string; uploading: boolean; onChoose(): void; onAdded(jobId: string): void }) {
  const { t } = useTranslation("production");
  return (
    <div className="ur-empty">
      <div className="ur-empty-h">
        <h1>{t("intake.emptyTitle")}</h1>
        <p>{t("intake.emptyBody")}</p>
      </div>
      <div className="ur-intake-big">
        <div className="ur-drop">
          <span className="ur-drop-ic" aria-hidden="true">
            <Icon name="up" size={18} />
          </span>
          <b>{t("intake.dropTitle")}</b>
          <span className="ur-mut">{t("intake.or")}</span>
          <Button variant="primary" size="guided" icon="file" command="uretim.upload" kbd={false} loading={uploading} onClick={onChoose}>
            {t("intake.upload")}
          </Button>
          <small>{t("intake.formats")}</small>
        </div>
        <ManualCard languageId={languageId} onAdded={onAdded} />
      </div>
      <ol className="ur-steps">
        {(["upload", "generate", "approve"] as const).map((k, i) => (
          <li key={k}>
            <i className="tz-mono">{i + 1}</i>
            <b>{t(`intake.steps.${k}.title`)}</b>
            <small>{t(`intake.steps.${k}.body`)}</small>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Boş sayfadaki elle ekleme formu: üretim başlatmaz ("Listeye ekle"). */
function ManualCard({ languageId, onAdded }: { languageId: string; onAdded(jobId: string): void }) {
  const { t } = useTranslation("production");
  const f = useElleEkle(languageId, onAdded);
  return (
    <form
      className="ur-manual or-ea"
      aria-label={t("intake.manual")}
      onSubmit={(e) => {
        e.preventDefault();
        void f.submit(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          void f.submit(false);
        }
      }}
    >
      <div className="ur-manual-h">
        <span className="ur-manual-ic" aria-hidden="true">
          <Icon name="pen" size={18} />
        </span>
        <span>
          <b>{t("intake.manual")}</b>
          <small>{t("intake.manualBody")}</small>
        </span>
      </div>
      <ElleEkleAlanlar form={f} compact />
      <Button type="submit" need="edit" size="page" wide icon="plus" disabled={!f.canAdd} loading={f.busy === "plain"}>
        {t("intake.addToList")}
      </Button>
    </form>
  );
}

/** Doluyken ince alım şeridi: son yükleme bilgisi, "Dosya yükle", "Elle ekle". */
export function IntakeStrip({ last, uploading, onChoose, onManual }: { last: BatchSummary | null; uploading: boolean; onChoose(): void; onManual(): void }) {
  const { t } = useTranslation("production");
  return (
    <div className="ur-intake">
      <span className="ur-intake-ic" aria-hidden="true">
        <Icon name="up" size={18} />
      </span>
      <span className="ur-intake-t">
        <b>{t("intake.stripTitle")}</b>
        <small>{last ? t("intake.last", { file: last.sourceFile, count: last.total, when: relativeStamp(last.createdAt) }) : t("intake.formats")}</small>
      </span>
      <span className="tz-sp" />
      <Button size="page" icon="up" command="uretim.upload" kbd={false} loading={uploading} onClick={onChoose}>
        {t("intake.upload")}
      </Button>
      <Button need="edit" size="page" icon="plus" onClick={onManual}>
        {t("intake.manual")}
      </Button>
    </div>
  );
}

/** Dosya sürüklenirken ekranın her yerinde bırakma hedefi; açık pencere varken çalışmaz. */
export function useFileDrop(onFile: (f: File) => void): boolean {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files") && !document.querySelector("dialog[open]");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) onFile(f);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [onFile]);
  return dragging;
}

/** Ctrl V: yazı alanında değilken ve pencere kapalıyken yapıştırılan sipariş verisi (JSON) yüklenir. */
export function usePasteOrders(onText: (text: string) => void): void {
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector("dialog[open]")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (!looksLikeOrders(text)) return;
      e.preventDefault();
      onText(text);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [onText]);
}
