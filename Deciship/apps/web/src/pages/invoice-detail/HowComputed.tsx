import { useTranslation } from "react-i18next";
import type { Invoice } from "../../api/types";
import { fmtDateTime, fmtMoney, fmtMoneySigned, fmtNum } from "../../lib/format";
import { visibleByType, visibleSteps } from "./reportLogic";
import { foldDuplicateStep } from "@deciship/core";
import { DiffTypeLabel } from "../../components/TermHint";

/** "Nasıl hesaplandı?": fazla ödemenin türlere ve adımlara dökümü. `reconciliation` yoksa çağıran çizmez. */
export function HowComputed({ inv, notes }: { inv: Invoice; notes?: string[] }) {
  const { t } = useTranslation("invoiceDetail");
  const rec = inv.totals?.reconciliation;
  if (!rec) return null;
  const cur = inv.currency;
  const types = visibleByType(inv.totals?.overchargeByType);
  // mükerrer özet kutusunda Faturalanan'ın içinde: adımı "Faturalanan − beklenen"e katılır (toplam aynı)
  const steps = visibleSteps(foldDuplicateStep(rec.steps));
  const at = inv.basis?.calculatedAt;
  return (
    <details className="inv-how">
      <summary>{t("summary.how.title")}</summary>
      {types.length > 0 && (
        <section>
          <h4>{t("summary.how.byType")}</h4>
          <dl className="inv-how-rows">
            {types.map((r) => (
              <div key={r.type}>
                <dt>
                  <DiffTypeLabel type={r.type} label={t(`diffType.${r.type}`)} /> <span className="t3">({t("summary.how.lines", { count: r.lines, n: fmtNum(r.lines) })})</span>
                </dt>
                <dd className="num">{fmtMoney(r.amount, cur)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <section>
        <h4>{t("summary.how.steps")}</h4>
        <dl className="inv-how-rows">
          {steps.map((s) => (
            <div key={s.key}>
              <dt>{t(`summary.how.step.${s.key}`)}</dt>
              <dd className="num">{fmtMoneySigned(s.amount, cur)}</dd>
            </div>
          ))}
          <div className="sum">
            <dt>{t("summary.how.result")}</dt>
            <dd className="num">{fmtMoney(rec.overchargeTotal, cur)}</dd>
          </div>
        </dl>
      </section>
      {at && (
        <p className="inv-sum-fine">
          {t("summary.how.calculatedAt")} {fmtDateTime(at)}
        </p>
      )}
      {notes?.map((n) => (
        <p key={n} className="inv-sum-fine">
          {n}
        </p>
      ))}
    </details>
  );
}
