import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Link } from "react-router";
import { tariffs } from "../api/endpoints";
import type { TariffSummary } from "../api/types";
import { fmtDate } from "../lib/format";
import { defaultTariffOf, nextAutoPick, tariffForDate, validOn } from "../lib/tariffPick";
import { Field } from "./ui";

function validity(t: TariffSummary, tr: TFunction) {
  if (!t.validFrom && !t.validTo) return tr("select.unlimited");
  return `${t.validFrom ? fmtDate(t.validFrom) : "…"} – ${t.validTo ? fmtDate(t.validTo) : "…"}`;
}

/** "FedEx IP 2025 (varsayılan) · International Priority · USD · 01.01.2025 – 31.12.2025" */
function tariffOptionLabel(t: TariffSummary, tr: TFunction) {
  return [t.name + (t.isDefault ? ` (${tr("select.defaultLower")})` : ""), t.service, t.currency, validity(t, tr)]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Faturanın tarifesi: taşıyıcının etkin tarifeleri. K2: `value` boşken (ilk açılış, taşıyıcı değişimi) fatura gününde
 * (`date`) geçerli tarife, yoksa taşıyıcının varsayılanı önseçilir ve `onChange(id, true)` çağrılır (sunucuyla aynı kural,
 * `lib/tariffPick.ts`). Kişi elle seçmediyse fatura tarihi değişince önseçim yenilenir. Faturanın tüm satırları bu
 * tarifeyle karşılaştırılır. Seçilen tarife o gün geçerli değilse uyarır (yine de o tarifeyle hesaplanır).
 */
export function TariffSelect({
  id,
  carrierId,
  value,
  onChange,
  date,
  locked = false,
  autoPicked,
}: {
  id: string;
  carrierId: string;
  value: string;
  onChange: (v: string, auto?: boolean) => void;
  date?: string;
  /** Seçim değiştirilemiyor (ör. itirazla kilitli fatura; nedeni çağıran söyler): "değiştirin" ipucu gösterilmez. */
  locked?: boolean;
  /**
   * Bugünkü değer kendiliğinden mi seçildi (çağıran tutuyorsa; bileşen yeniden açılınca da bilinsin, ör. sihirbazda adım
   * değişimi). Verilmezse bileşen kendi açılışındaki önseçimi hatırlar.
   */
  autoPicked?: boolean;
}) {
  const { t: tr } = useTranslation("tariffs");
  const q = useQuery({
    queryKey: ["tariffs", carrierId],
    queryFn: () => tariffs.list(carrierId),
    enabled: Boolean(carrierId),
  });
  const list = q.data ?? [];
  const def = defaultTariffOf(list);
  const preferred = tariffForDate(list, date);
  // Son kendiliğinden seçilen tarife: kişi değiştirmediyse tarih değişince yenilenir (elle seçim korunur).
  const autoRef = useRef<string | null>(null);
  useEffect(() => {
    const auto = autoPicked === undefined ? autoRef.current : autoPicked ? value : null;
    const next = nextAutoPick(value, auto, preferred?.id ?? null);
    if (!next) return;
    autoRef.current = next;
    onChange(next, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, preferred?.id, autoPicked]);

  // pasif tarifeler listelenmez; seçili olan sonradan pasifleştiyse görünür ama yeniden seçilemez
  const shown = list.filter((t) => t.active || t.id === value);
  const sel = list.find((t) => t.id === value) ?? null;
  const day = date?.slice(0, 10);
  const outOfRange = sel && day ? !validOn(sel, day) : false;
  const none = q.isSuccess && shown.length === 0;

  const help = q.isError ? (
    tr("select.loadFailed")
  ) : locked ? (
    // itirazla kilitli: seçim değişmez, "tüm satırlar bu tarifeyle" ipucu kilit notuyla çelişir
    null
  ) : none ? (
    <>
      {tr("select.noneMarked")}{" "}
      <Link to={`/tariffs?carrier=${carrierId}`}>{tr("select.addTariff")}</Link>
    </>
  ) : outOfRange ? null : sel && day && sel.id === preferred?.id && sel.id !== def?.id ? (
    // K2: varsayılan değil, fatura gününde geçerli olan önseçildi
    tr("select.dateSelected", { date: fmtDate(day) })
  ) : sel && sel.id === def?.id ? (
    tr("select.defaultSelected")
  ) : sel ? (
    tr("select.allLines")
  ) : null;

  return (
    <Field label={tr("select.label")} htmlFor={id} help={help}>
      <select
        id={id}
        className="sel tariff-sel"
        value={none ? "" : value}
        disabled={q.isLoading || none}
        onChange={(e) => onChange(e.target.value)}
      >
        {none && <option value="">{tr("select.noTariffs")}</option>}
        {q.isLoading && <option value="">{tr("select.loading")}</option>}
        {shown.map((t) => (
          <option key={t.id} value={t.id} disabled={!t.active}>
            {tariffOptionLabel(t, tr)}
            {!t.active ? ` (${tr("select.inactiveLower")})` : ""}
          </option>
        ))}
      </select>
      {outOfRange && sel && (
        <span className="help warn-t">
          {tr("select.outOfRange", { date: fmtDate(day!), validity: validity(sel, tr) })}
        </span>
      )}
    </Field>
  );
}
