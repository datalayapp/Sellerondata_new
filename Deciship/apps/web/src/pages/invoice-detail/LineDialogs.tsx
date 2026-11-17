import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { measurements } from "../../api/endpoints";
import type { InvoiceLine } from "../../api/types";
import { Icon } from "../../components/Icon";
import {
  Empty,
  ErrorState,
  Field,
  Modal,
  ModalAction,
  Skel,
  StatusPill,
} from "../../components/ui";
import { fmtDateTime, fmtDims, fmtKg, fmtNum } from "../../lib/format";

/** Search measurements by tracking no and pin one to the line. */
export function MatchModal({
  line,
  loading,
  onClose,
  onPick,
}: {
  line: InvoiceLine;
  loading: boolean;
  onClose: () => void;
  onPick: (measurementId: string) => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const [text, setText] = useState(line.trackingNo);
  const [q, setQ] = useState(line.trackingNo);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const res = useQuery({
    queryKey: ["measurements", "pick", q],
    queryFn: () => measurements.list({ q: q || undefined, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const items = res.data?.items ?? [];
  const currentId = line.measurement?.id ?? line.measurementId ?? null;
  return (
    <Modal
      busy={loading}
      label={line.trackingNo}
      title={t("match.title")}
      size="wide"
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t("match.cancel")}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="check"
            loading={loading}
            disabled={!sel}
            onClick={() => sel && onPick(sel)}
          >
            {t("match.pick")}
          </ModalAction>
        </>
      }
    >
      <p className="muted mpick-lead">
        {t("match.lead")}
      </p>
      <Field
        label={t("match.searchLabel")}
        htmlFor="mp-q"
        help={t("match.searchHelp")}
      >
        <div className="search">
          <Icon name="search" />
          <input
            id="mp-q"
            className="inp"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t("match.trackingNo")}
          />
        </div>
      </Field>
      <div
        className={`mpick${res.isPlaceholderData ? " is-stale" : ""}`}
        role="radiogroup"
        aria-label={t("match.measurements")}
      >
        {res.isError && !res.data ? (
          <ErrorState error={res.error} onRetry={() => res.refetch()} />
        ) : !res.data ? (
          <div className="col">
            <Skel h={52} />
            <Skel h={52} />
          </div>
        ) : items.length === 0 ? (
          <Empty
            compact
            icon="search"
            title={q ? t("match.emptySearch") : t("match.emptyNone")}
          >
            {q ? t("match.emptySearchHint") : t("match.emptyNoneHint")}
          </Empty>
        ) : (
          items.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={sel === m.id}
              className={`mpick-it${sel === m.id ? " on" : ""}`}
              onClick={() => setSel(m.id)}
              onDoubleClick={() => onPick(m.id)}
            >
              <span className="mpick-main">
                <span className="mono mpick-no">{m.trackingNo}</span>
                {m.id === currentId && (
                  <StatusPill tone="blue">{t("match.current")}</StatusPill>
                )}
              </span>
              <span className="mpick-dim num">
                <span className="mono">
                  {fmtDims(m.lengthCm, m.widthCm, m.heightCm)} cm
                </span>{" "}
                · {fmtKg(m.weightKg)}
              </span>
              <span className="mpick-sub">
                {fmtDateTime(m.measuredAt)} · {m.measuredBy?.name}
              </span>
            </button>
          ))
        )}
      </div>
      {res.data && res.data.total > items.length && (
        <p className="t3 s12 mt8">
          {t("match.truncated", { count: res.data.total, total: fmtNum(res.data.total), shown: fmtNum(items.length) })}
        </p>
      )}
    </Modal>
  );
}

const REASON_KEYS = ["carrierRight", "contractSurcharge", "notWorth", "settled"] as const;

export function ReasonModal({
  trackingNo,
  initial = "",
  editing = false,
  title,
  loading,
  onClose,
  onSubmit,
}: {
  trackingNo: string;
  initial?: string;
  editing?: boolean;
  /** Mesaj 14: toplu karar penceresi kendi başlığını verir ("12 satırı uyumlu say"); verilmezse tek satır başlığı. */
  title?: string;
  loading: boolean;
  onClose: () => void;
  onSubmit: (r: string) => void;
}) {
  const { t } = useTranslation("invoiceDetail");
  const [reason, setReason] = useState(initial);
  const [touched, setTouched] = useState(false);
  const err =
    reason.trim().length < 3 ? t("reason.required") : null;
  return (
    <Modal
      busy={loading}
      label={trackingNo}
      title={title ?? (editing ? t("reason.editTitle") : t("reason.acceptTitle"))}
      onClose={onClose}
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t("match.cancel")}
          </ModalAction>
          <ModalAction
            kind="prim"
            icon="check"
            loading={loading}
            onClick={() => {
              setTouched(true);
              if (!err) onSubmit(reason.trim());
            }}
          >
            {editing ? t("reason.saveReason") : t("reason.acceptTitle")}
          </ModalAction>
        </>
      }
    >
      <p className="muted reason-lead">
        {t("reason.lead")}
      </p>
      <div className="reason-chips">
        {REASON_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setReason(t(`reason.chips.${k}`))}
          >
            {t(`reason.chips.${k}`)}
          </button>
        ))}
      </div>
      <Field label={t("reason.label")} htmlFor="reason" error={touched ? err : null}>
        <textarea
          id="reason"
          className="txt"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
    </Modal>
  );
}
