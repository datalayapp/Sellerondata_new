import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { disputes } from '../../api/endpoints';
import type { DisputeResultView, DisputeRound, DisputeSums, Invoice } from '../../api/types';
import { useHoldsPermission, usePermission } from '../../auth/AuthContext';
import { Icon } from '../../components/Icon';
import { ActionMenu, Button, StatusPill } from '../../components/ui';
import { revertableResults, timelineOf, type TimelineEvent } from '../../lib/disputes';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../../lib/format';
import { InvoiceDisputeTag, OutcomeTag } from '../disputes/parts';
import { ResultDialog, RevertDialog, SendDialog, WithdrawDialog, useDisputeAction } from './DisputeDialogs';

type Dlg = 'send' | 'resend' | 'result' | 'withdraw' | 'revert' | null;

/**
 * Faturanın itiraz kartı: durum, toplamlar, satır sonuçları; geçmiş (denetim izi) katlı.
 * Her durumda tek ana eylem (gönderilmedi → Gönderildi olarak işaretle; gönderimden sonra listeye satır eklendiyse →
 * Yeniden gönder; gönderildi → Sonuç gir); diğerleri "Diğer" menüsünde. Toplamlar faturanın toplamıdır (önceki turda geri
 * alınan para da sayılır), satır tablosu etkin turundur. Eylemler `deciship.disputes.manage` ister; izni olmayan salt okur.
 */
export function DisputeCard({ inv, compact }: { inv: Invoice; compact?: boolean }) {
  const { t } = useTranslation('disputes');
  const canManage = usePermission('deciship.disputes.manage');
  const holdsManage = useHoldsPermission('deciship.disputes.manage');
  const holdsDecide = useHoldsPermission('deciship.lines.decide');
  const showPrices = usePermission('deciship.prices.view');
  const run = useDisputeAction(inv.id);
  const [dlg, setDlg] = useState<Dlg>(null);
  const d = inv.dispute;
  if (!d) return null;
  const a = d.active;
  if (!a && !d.history.length && d.sendableLineCount === 0) return null;
  const cur = a?.currency || inv.currency || '';
  const pending = a?.lines.filter((l) => l.outcome === 'PENDING').length ?? 0;
  // 10-B12: etkin turun girişleri ve önceki turdaki, satırı yeniden talep edilmemiş girişler (yanlış dekont düzeltilebilsin);
  // yeniden gönderilen tur geri çekildiyse etkin tur yoktur ama önceki turun dekontu yine düzeltilebilir
  const revertable = revertableResults(d);
  // gönderimden sonra listeye eklenen satırlar: ana eylem yeniden göndermedir
  const unsent = a ? (d.unsentLineCount ?? 0) : 0;
  const sums = d.sums ?? a?.sums;
  const close = () => setDlg(null);
  const tag = a ? <InvoiceDisputeTag status={d.status} recovered={sums?.recoveredAmount} /> : <StatusPill tone="yellow">{t('listStatus.UNSENT')}</StatusPill>;

  if (compact) {
    return (
      <section className="card dsp-card compact" aria-label={t('card.aria')}>
        <h2 className="tt">{t('card.title')}</h2>
        {tag}
        {a && showPrices && sums && (
          <span className="t2 s13">
            {t('card.sums.claimed')} <b className="num">{fmtMoney(sums.claimedAmount, cur)}</b> · {t('card.sums.recovered')}{' '}
            <b className="num green">{fmtMoney(sums.recoveredAmount, cur)}</b>
          </span>
        )}
      </section>
    );
  }

  const more = a
    ? [
        ...(unsent > 0 && pending > 0 ? [{ label: t('card.addResult'), icon: 'edit' as const, onSelect: () => setDlg('result') }] : []),
        ...(unsent === 0 && d.sendableLineCount > 0 ? [{ label: t('card.resend'), icon: 'refresh' as const, onSelect: () => setDlg('resend') }] : []),
        ...(revertable.length ? [{ label: t('card.revert'), icon: 'back' as const, onSelect: () => setDlg('revert') }] : []),
        { label: t('card.withdraw'), icon: 'close' as const, onSelect: () => setDlg('withdraw') },
      ]
    : revertable.length
      ? [{ label: t('card.revert'), icon: 'back' as const, onSelect: () => setDlg('revert') }]
      : [];
  const actions = canManage && (
    <div className="dsp-acts">
      {!a && d.sendableLineCount > 0 && (
        <Button kind="secondary" small icon="check" onClick={() => setDlg('send')}>
          {t('card.markSent')}
        </Button>
      )}
      {a && unsent > 0 ? (
        <Button small icon="refresh" onClick={() => setDlg('resend')}>
          {t('card.resend')}
        </Button>
      ) : (
        a &&
        pending > 0 && (
          <Button small icon="edit" onClick={() => setDlg('result')}>
            {t('card.addResult')}
          </Button>
        )
      )}
      {more.length > 0 && <ActionMenu className="dsp-more" items={more} />}
    </div>
  );

  const events = timelineOf(d);
  const multiRound = d.history.length > 0;

  return (
    <section className="card dsp-card" aria-label={t('card.aria')}>
      <div className="card-h">
        <h2 className="tt">
          {t('card.title')}
          {tag}
          {a && multiRound && <span className="t3">{t('card.round', { n: a.round })}</span>}
        </h2>
        {actions}
      </div>

      {!a ? (
        <p className="dsp-lead">
          {d.sendableLineCount === 0 ? (
            t('card.nothingToSend')
          ) : showPrices && d.sendableAmount != null ? (
            <Trans
              t={t}
              i18nKey="card.unsent"
              count={d.sendableLineCount}
              values={{ n: fmtNum(d.sendableLineCount), amount: fmtMoney(d.sendableAmount, inv.currency) }}
              components={{ b: <b className="num" /> }}
            />
          ) : (
            t('card.unsentNoPrice', { count: d.sendableLineCount, n: fmtNum(d.sendableLineCount) })
          )}
        </p>
      ) : (
        <>
          {unsent > 0 && (
            <p className="dsp-lead dsp-unsent" role="status">
              {showPrices && d.unsentAmount != null
                ? t('card.unsentAfterSend', { count: unsent, n: fmtNum(unsent), amount: fmtMoney(d.unsentAmount, cur) })
                : t('card.unsentAfterSendNoPrice', { count: unsent, n: fmtNum(unsent) })}
            </p>
          )}
          <ActiveRound round={a} sums={sums ?? a.sums} cur={cur} showPrices={showPrices} />
        </>
      )}

      {!holdsManage && (
        <p className="dsp-hint">
          <Icon name="lock" size={14} /> {holdsDecide ? t('card.hintPrepare') : t('card.hintReadOnly')}
        </p>
      )}

      {events.length > 0 && (
        <details className="dsp-history">
          <summary>{t('history.title')}</summary>
          <Timeline events={events} cur={cur} showPrices={showPrices} multiRound={multiRound} />
        </details>
      )}

      {dlg === 'send' && <SendDialog invoice={inv} showPrices={showPrices} run={run} send={(b) => disputes.send(inv.id, b)} onClose={close} />}
      {dlg === 'resend' && a && (
        <SendDialog invoice={inv} round={a} showPrices={showPrices} run={run} send={(b) => disputes.resend(a.id, { ...b, version: a.version })} onClose={close} />
      )}
      {dlg === 'result' && a && (
        <ResultDialog invoice={inv} round={a} showPrices={showPrices} run={run} add={(b) => disputes.addResult(a.id, { ...b, version: a.version })} onClose={close} />
      )}
      {dlg === 'withdraw' && a && (
        <WithdrawDialog invoice={inv} round={a} run={run} act={(reason) => disputes.withdraw(a.id, { version: a.version, reason })} onClose={close} />
      )}
      {dlg === 'revert' && revertable.length > 0 && (
        <RevertDialog
          invoice={inv}
          results={revertable}
          activeRoundId={a?.id ?? null}
          showPrices={showPrices}
          cur={cur}
          run={run}
          // sürüm, girişin turunun sürümü (önceki turdaki girişte o turun)
          act={(x, reason) => disputes.revertResult(x.result.id, { version: x.round.version, reason })}
          onClose={close}
        />
      )}
    </section>
  );
}

function ActiveRound({ round: a, sums: s, cur, showPrices }: { round: DisputeRound; sums: DisputeSums; cur: string; showPrices: boolean }) {
  const { t } = useTranslation('disputes');
  const short = s.shortfallAmount ?? 0;
  return (
    <>
      <div className="dsp-sentline">
        <span>{t('card.sentLine', { date: fmtDate(a.sentOn), channel: t(`channel.${a.channel}`), name: a.sentBy.name })}</span>
        {/* zamanında olduğu özet satırında yazar; burada yalnız geç gönderim uyarısı */}
        {a.ttk === 'LATE' && (
          <StatusPill tone="yellow" small>
            {t('card.ttkLate')}
          </StatusPill>
        )}
        {a.reference && <span className="t3">{t('card.reference', { ref: a.reference })}</span>}
      </div>
      {showPrices && s.claimedAmount != null && (
        <dl className="dsp-sums">
          <div>
            <dt>{t('card.sums.claimed')}</dt>
            <dd className="num">{fmtMoney(s.claimedAmount, cur)}</dd>
          </div>
          <div className={(s.recoveredAmount ?? 0) > 0 ? 'good' : ''}>
            <dt>{t('card.sums.recovered')}</dt>
            <dd className="num">{fmtMoney(s.recoveredAmount, cur)}</dd>
          </div>
          {(s.pendingAmount ?? 0) > 0 && (
            <div>
              <dt>{t('card.sums.pending')}</dt>
              <dd className="num">{fmtMoney(s.pendingAmount, cur)}</dd>
            </div>
          )}
          {(s.rejectedAmount ?? 0) > 0 && (
            <div className="bad">
              <dt>{t('card.sums.rejected')}</dt>
              <dd className="num">{fmtMoney(s.rejectedAmount, cur)}</dd>
            </div>
          )}
          {short > 0 && (
            <div className="short">
              <dt>{t('card.sums.shortfall')}</dt>
              <dd className="num">{fmtMoney(short, cur)}</dd>
            </div>
          )}
        </dl>
      )}
      <div className="table-wrap mt16">
        <table className="dt dt-cards compact dsp-lines">
          <thead>
            <tr>
              <th>{t('card.lines.line')}</th>
              {showPrices && <th className="r">{t('card.lines.claimed')}</th>}
              <th>{t('card.lines.outcome')}</th>
              {showPrices && <th className="r">{t('card.lines.recovered')}</th>}
            </tr>
          </thead>
          <tbody>
            {a.lines.map((l) => {
              const lineShort = l.outcome === 'RECOVERED' && l.claimedAmount != null && l.recoveredAmount != null ? l.claimedAmount - l.recoveredAmount : 0;
              return (
                <tr key={l.id}>
                  <td className="card-title">
                    <span className="id mono">{l.trackingNo ?? (l.lineNo != null ? t('card.lines.lineNo', { n: l.lineNo }) : '—')}</span>
                  </td>
                  {showPrices && (
                    <td data-label={t('card.lines.claimed')} className="r num">
                      {fmtMoney(l.claimedAmount, cur)}
                    </td>
                  )}
                  <td data-label={t('card.lines.outcome')}>
                    <OutcomeTag outcome={l.outcome} small />
                  </td>
                  {showPrices && (
                    <td data-label={t('card.lines.recovered')} className="r num">
                      {l.outcome === 'RECOVERED' ? (
                        <span className="dsp-cell r">
                          <span className="green sb">{fmtMoney(l.recoveredAmount, cur)}</span>
                          {lineShort > 0.004 && <span className="sub warn-t">{t('row.shortfall', { amount: fmtMoney(lineShort, cur) })}</span>}
                        </span>
                      ) : (
                        <span className="t3">—</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Denetim izi: kim, ne zaman, ne girdi. Geri alınan giriş üstü çizili kalır; geri çekilen ve yerini yeniye bırakan turlar da yazılır. */
function Timeline({ events, cur, showPrices, multiRound }: { events: TimelineEvent[]; cur: string; showPrices: boolean; multiRound: boolean }) {
  const { t } = useTranslation('disputes');
  const amt = (n?: number) => (showPrices && n != null ? <> · <span className="num">{fmtMoney(n, cur)}</span></> : null);
  const who = (name: string | undefined, at: string) => <span className="dsp-ev-w">{t('history.by', { name: name ?? '—', at: fmtDateTime(at) })}</span>;
  const reason = (r: string | null) => (r ? <span className="dsp-ev-d">{t('history.reason', { reason: r })}</span> : null);
  const resultTitle = (x: DisputeResultView) => (x.kind === 'RECOVERED' ? t('history.recovered', { no: x.creditNoteNo ?? '—' }) : t('history.rejected'));
  return (
    <ol className="dsp-tl">
      {events.map((e, i) => {
        const key = `${e.kind}-${e.round.id}-${'result' in e ? e.result.id : ''}-${i}`;
        if (e.kind === 'sent') {
          const r = e.round;
          return (
            <li key={key} className="sent">
              <div className="dsp-ev">
                <span className="dsp-ev-t">{multiRound ? t('history.sent', { n: r.round }) : t('history.sentOnly')}</span>
                {who(e.by.name, e.at)}
              </div>
              <span className="dsp-ev-d">{[fmtDate(r.sentOn), t(`channel.${r.channel}`), r.channelNote, r.reference].filter(Boolean).join(' · ')}</span>
            </li>
          );
        }
        if (e.kind === 'result') {
          const x = e.result;
          const rec = x.kind === 'RECOVERED';
          return (
            <li key={key} className={`${rec ? 'recovered' : 'rejected'}${x.revertedAt ? ' voided' : ''}`}>
              <div className="dsp-ev">
                <span className="dsp-ev-t">
                  {resultTitle(x)}
                  {amt(x.amount)}
                </span>
                {who(e.by.name, e.at)}
              </div>
              <span className="dsp-ev-d">
                {t('history.resultLines', { count: x.lines.length, n: fmtNum(x.lines.length) })} · {fmtDate(x.resultOn)}
              </span>
              {!rec && reason(x.reason)}
            </li>
          );
        }
        if (e.kind === 'reverted') {
          return (
            <li key={key} className="undone">
              <div className="dsp-ev">
                <span className="dsp-ev-t">{t('history.reverted', { what: resultTitle(e.result) })}</span>
                {who(e.by?.name, e.at)}
              </div>
              {reason(e.result.revertReason)}
            </li>
          );
        }
        if (e.kind === 'withdrawn') {
          return (
            <li key={key} className="withdrawn">
              <div className="dsp-ev">
                <span className="dsp-ev-t">{t('history.withdrawn', { n: e.round.round })}</span>
                {who(e.by?.name, e.at)}
              </div>
              {reason(e.round.withdrawReason)}
            </li>
          );
        }
        return (
          <li key={key} className="withdrawn">
            <div className="dsp-ev">
              <span className="dsp-ev-t t2">{t('history.superseded', { n: e.round.round, next: e.next })}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
