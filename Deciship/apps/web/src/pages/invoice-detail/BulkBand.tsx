import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { jobs } from "../../api/endpoints";
import type { JobRefType } from "../../api/types";
import { Icon } from "../../components/Icon";
import { fmtNum } from "../../lib/format";
import { creepPercent, jobElapsedMs, jobPercent } from "../../lib/jobs";
import { useJob } from "../../lib/useJob";
import { announceBulkOutcome } from "./bulkAnnounce";
import { INVOICE_REFRESH_KEYS, activeApplyJob, bandNumbers, bulkFollowUp, bulkOutcome, firstAnnouncement, type BulkFollowUp } from "./recalc";

/**
 * Sayfada süren "eski faturaları geçir" işi varsa üstte bilgi bandı: metin ve ilerleme, eylem yok. Bitince bilgi iletisi çıkar
 * ve fatura sorguları tazelenir. `ns`: bant metninin bulunduğu sözlük (`bulkBand` anahtarı; tarife düzenleyici ve Ayarlar).
 * `onStale` (K4): atlanan ya da kapsamda kalan fatura varsa (`bulkFollowUp`) ileti yerine sayfanın penceresi açılır
 * (`useRecalcFlow` `showStale`).
 */
export function BulkBand({
  refType,
  refId,
  ns,
  onStale,
}: {
  refType: Extract<JobRefType, "Tariff" | "Company">;
  refId: string | undefined;
  ns: "tariffEditor" | "settings";
  onStale?: (follow: BulkFollowUp) => void;
}) {
  const { t } = useTranslation(ns);
  const { t: tr } = useTranslation("invoiceDetail");
  const qc = useQueryClient();
  const key = ["jobs-active", "BULK_RECOMPARE_APPLY", refType, refId];
  const list = useQuery({
    queryKey: key,
    queryFn: () => jobs.list({ active: true, kind: "BULK_RECOMPARE_APPLY", refType, refId }),
    enabled: Boolean(refId),
    staleTime: 0,
    meta: { silent: true },
  });
  const first = activeApplyJob(list.data ?? []);
  const { job, receivedAt } = useJob(first?.id, {
    initial: first,
    onFinish: (j) => {
      // aynı işi pencere de izliyorsa ileti bir kez çıkar
      // iş nasıl biterse bitsin kısmen yazılmış olabilir: sorgular hep tazelenir
      for (const k of INVOICE_REFRESH_KEYS) qc.invalidateQueries({ queryKey: [...k] });
      const o = bulkOutcome("apply", j);
      if (firstAnnouncement(j.id)) {
        const follow = bulkFollowUp(o);
        if (onStale && follow) onStale(follow);
        else announceBulkOutcome(tr, o, refType === "Tariff" ? "tariff" : "settings");
      }
      qc.setQueryData(key, []);
    },
  });
  if (!first || !job || job.status === "SUCCEEDED" || job.status === "FAILED" || job.status === "CANCELLED") return null;
  const { done, total } = bandNumbers(job);
  const pct = jobPercent(job.progress) ?? creepPercent(jobElapsedMs(job, receivedAt, receivedAt) / 1000);
  return (
    <div className="notif info" role="status" aria-live="polite" data-testid="bulk-band">
      <Icon name="spin" className="spin" />
      <div className="grow">
        {t("bulkBand", { done: fmtNum(done), total: fmtNum(total) })}
        <div className="lp-bar mt8" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}
