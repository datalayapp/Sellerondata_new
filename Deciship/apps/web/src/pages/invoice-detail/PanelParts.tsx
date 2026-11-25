import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InvoiceLine } from "../../api/types";
import { Icon } from "../../components/Icon";
import { Button, Field, StatusPill } from "../../components/ui";
import { HARD_ROW_FLAGS, type RowFlagCode } from "@deciship/core";
import { flagText } from "../invoice-upload/uploadUtils";
import { hardFlagsOf } from "./lineUtils";

/** Tracking-no correction + manual match controls of the line panel. */
export function MatchBox({
  line: l,
  busy,
  onTracking,
  onMatch,
  onUnpin,
  readOnly,
}: {
  line: InvoiceLine;
  busy: boolean;
  onTracking: (trackingNo: string) => Promise<unknown>;
  onMatch: () => void;
  onUnpin: () => void;
  /** değiştirme izni yok: düğmeler çizilmez, bilgiler okunur */
  readOnly?: boolean;
}) {
  const { t } = useTranslation("invoiceDetail");
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(l.trackingNo);
  const [err, setErr] = useState<string | null>(null);
  const pinned = Boolean(l.measurementPinned);
  const save = async () => {
    const val = v.trim();
    if (!val) return setErr(t("panel.trackingEmpty"));
    if (val === l.trackingNo) return setEditing(false);
    try {
      await onTracking(val);
      setEditing(false);
    } catch {
      /* toast already shown */
    }
  };
  return (
    <div className="mbox">
      <div className="mbox-row">
        <span className="mbox-k">{t("panel.trackingNo")}</span>
        {editing ? (
          <form
            className="mbox-edit"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Field
              label={<span className="sr-only">{t("panel.correctTracking")}</span>}
              htmlFor="ln-trk"
              error={err}
              help={t("panel.trackingHelp")}
            >
              <input
                id="ln-trk"
                className="inp sm mono"
                value={v}
                autoFocus
                aria-invalid={!!err || undefined}
                onChange={(e) => {
                  setV(e.target.value);
                  setErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    e.nativeEvent.stopImmediatePropagation();
                    setEditing(false);
                  }
                }}
              />
            </Field>
            <div className="mbox-btns">
              <Button
                kind="ghost"
                small
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                {t("panel.cancel")}
              </Button>
              <Button
                kind="secondary"
                small
                type="submit"
                icon="check"
                loading={busy}
              >
                {t("panel.save")}
              </Button>
            </div>
          </form>
        ) : (
          <span className="mbox-v">
            <span className="mono">{l.trackingNo}</span>
            {!readOnly && (
              <Button
                kind="plain"
                small
                icon="edit"
                aria-label={t("panel.fixTrackingAria")}
                title={t("panel.fixTrackingTitle")}
                onClick={() => {
                  setV(l.trackingNo);
                  setErr(null);
                  setEditing(true);
                }}
              >
                {t("panel.fix")}
              </Button>
            )}
          </span>
        )}
      </div>
      {l.originalTrackingNo && l.originalTrackingNo !== l.trackingNo && (
        <div className="mbox-row">
          <span className="mbox-k">{t("panel.onInvoice")}</span>
          <span className="mono t3">{l.originalTrackingNo}</span>
        </div>
      )}
      <div className="mbox-row">
        <span className="mbox-k">{t("panel.measurement")}</span>
        <span className="mbox-v">
          {pinned && !l.measurement && l.measurementId ? (
            <>
              <StatusPill tone="blue">{t("panel.pinned")}</StatusPill>
              <StatusPill tone="red">{t("panel.pinnedDeleted")}</StatusPill>
            </>
          ) : pinned ? (
            <StatusPill tone="blue">{t("panel.pinned")}</StatusPill>
          ) : l.measurement ? (
            <StatusPill tone="gray">{t("panel.matchedByTracking")}</StatusPill>
          ) : (
            <StatusPill tone="yellow">{t("panel.unmatched")}</StatusPill>
          )}
        </span>
      </div>
      {!readOnly && (
        <div className="mbox-acts">
          <Button
            kind="secondary"
            small
            icon="search"
            onClick={onMatch}
            disabled={busy}
          >
            {l.measurement ? t("panel.matchOther") : t("panel.match")}
          </Button>
          {pinned && (
            <Button
              kind="ghost"
              small
              icon="close"
              onClick={onUnpin}
              loading={busy}
            >
              {t("panel.unpin")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * SPEC §11.5: satırın okuma kontrolü bayrakları. "Kontrol ettim" bayrakları silmez; satırı
 * "Kontrol edilecek" sayısından ve rozetten çıkarır (PATCH { parseChecked: true }).
 */
export function ReadCheckBox({
  line: l,
  busy,
  onToggle,
}: {
  line: InvoiceLine;
  busy: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const flags = l.parseFlags ?? [];
  const hard = hardFlagsOf(l);
  const done = Boolean(l.parseChecked) || hard.length === 0;
  return (
    <section
      className={`pf-box mt12${done ? " done" : ""}`}
      aria-label={t("line.readCheck")}
    >
      <div className="pf-h">
        <span className="row center-y gap8">
          {hard.length > 0 && !l.parseChecked ? (
            <span className="tag yellow">{t("line.readCheck")}</span>
          ) : (
            <span className="tag gray">{t("panel.readNote")}</span>
          )}
          {l.parseChecked && <span className="t3 s12">{t("panel.checked")}</span>}
        </span>
        {hard.length > 0 &&
          (l.parseChecked ? (
            <Button
              kind="ghost"
              small
              icon="back"
              loading={busy}
              onClick={() => onToggle(false)}
            >
              {t("panel.undo")}
            </Button>
          ) : (
            <Button
              kind="secondary"
              small
              icon="check"
              loading={busy}
              onClick={() => onToggle(true)}
            >
              {t("panel.markChecked")}
            </Button>
          ))}
      </div>
      <ul className="pflags">
        {flags.map((c) => {
          const soft = !HARD_ROW_FLAGS.includes(c as RowFlagCode);
          return (
            <li key={c} className={soft ? "soft" : ""}>
              <Icon name={soft ? "info" : "warn"} size={14} />
              <span>{flagText(c)}</span>
            </li>
          );
        })}
      </ul>
      {hard.length > 0 && !l.parseChecked && (
        <p className="t3 s12 mt8">
          {t("panel.checkHint")}
        </p>
      )}
    </section>
  );
}

/** Line note: saved on blur, Ctrl+Enter or the small save button. */
export function NoteBox({
  note,
  busy,
  onSave,
}: {
  note: string;
  busy: boolean;
  onSave: (note: string) => Promise<unknown>;
}) {
  const { t } = useTranslation("invoiceDetail");
  const [v, setV] = useState(note);
  const saved = useRef(note);
  useEffect(() => {
    if (note !== saved.current) {
      saved.current = note;
      setV(note);
    }
  }, [note]);
  const dirty = v.trim() !== saved.current.trim();
  const commit = async () => {
    if (!dirty || busy) return;
    const n = v.trim();
    try {
      await onSave(n);
      saved.current = n;
      setV(n);
    } catch {
      /* toast already shown; keep the text so nothing is lost */
    }
  };
  return (
    <div className="pn-notebox">
      <textarea
        className="txt"
        aria-label={t("panel.noteLabel")}
        placeholder={t("panel.notePlaceholder")}
        maxLength={1000}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit();
          }
        }}
      />
      <div className="pn-notebox-f">
        <span className="help">
          {dirty ? t("panel.noteUnsaved") : t("panel.noteVisible")}
        </span>
        {dirty && (
          <Button
            kind="secondary"
            small
            icon="check"
            loading={busy}
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
          >
            {t("panel.saveNote")}
          </Button>
        )}
      </div>
    </div>
  );
}
