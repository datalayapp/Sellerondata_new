import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Trans, useTranslation } from 'react-i18next';
import { turkeyDate } from '@deciship/core';
import { ApiError } from '../../api/client';
import type { DisputeChannel, DisputeRound, DisputeSendBody, Invoice, InvoiceDispute } from '../../api/types';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { Affix, Field, Modal, ModalAction } from '../../components/ui';
import { amountValid, hasLiveRecovery, needsRefetch, recoveryTotals, validateSend, type RevertableResult } from '../../lib/disputes';
import { fmtDate, fmtMoney, fmtNum, numToInput, parseTrNumber } from '../../lib/format';
import { useLocaleSwitch } from '../../lib/localeSwitch';
import { relocalizeNumberText } from '../../lib/weightChoice';
import { disputeErrorText } from '../disputes/parts';

const CHANNELS: DisputeChannel[] = ['EMAIL', 'PORTAL', 'OTHER'];
const REASON_MAX = 1000;
const CREDIT_NOTE_MAX = 64;

/**
 * İtiraz değiştiricisi: başarıda faturanın itirazı önbellekte hemen güncellenir, ilgili listeler yenilenir.
 * Hatada (başkası değiştirmiş olabilir) güncel kayıt okunur; hata iletişim kutusunda gösterilsin diye yeniden atılır.
 */
export function useDisputeAction(invoiceId: string) {
  const qc = useQueryClient();
  return async (fn: () => Promise<InvoiceDispute>, okMsg: string) => {
    try {
      const d = await fn();
      if (d && typeof d === 'object' && 'status' in d) qc.setQueryData<Invoice>(['invoice', invoiceId], (old) => (old ? { ...old, dispute: d } : old));
      toast.ok(okMsg);
    } catch (e) {
      if (e instanceof ApiError && needsRefetch(e.code)) void qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
      throw e;
    }
    void qc.invalidateQueries({ queryKey: ['invoice', invoiceId] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
    void qc.invalidateQueries({ queryKey: ['disputes'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
}
export type DisputeRun = ReturnType<typeof useDisputeAction>;

/** Gönderimden dönen hata: iletişim kutusunun üstünde, ne yapılacağını söyleyen tek satır. */
function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <div className="notif err" role="alert">
      <Icon name="err" />
      <span>{disputeErrorText(error)}</span>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (fn: () => Promise<void>, onDone: () => void, onFail?: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e);
      onFail?.();
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit, clearError: () => setError(null) };
}

const label = (inv: Invoice) => [inv.carrier?.name, inv.invoiceNo].filter(Boolean).join(' · ');

/** İşaretlenecek küme: itiraz metninden (metnin satır sayısı, toplamı ve özeti) ya da faturanın gönderilecek satırlarından. */
export type SendSelection = { lineCount: number; total?: number; selectionDigest?: string | null };

/**
 * "Gönderildi olarak işaretle" ve "Yeniden gönder": tarih (varsayılan bugün), kanal, gerekirse açıklama, taşıyıcı vaka no.
 * 10-B3: işaretleme taşıyıcıya yollanan metnin kümesini taşır (`draft`: itiraz metni penceresinden; yoksa kartta görünen
 * gönderilecek satırlar). Sunucu kümenin özetini kilit altında karşılaştırır; arada değiştiyse 409 SELECTION_CHANGED: metinden
 * gelindiyse kayıt durur ve metni yeniden alma bağlantısı çıkar.
 */
export function SendDialog({
  invoice,
  round,
  draft,
  showPrices,
  run,
  send,
  onClose,
  onReopenText,
}: {
  invoice: Invoice;
  /** verilirse yeniden gönderme */
  round?: DisputeRound | null;
  /** itiraz metni penceresinden gelindiyse metnin kümesi */
  draft?: SendSelection | null;
  showPrices: boolean;
  run: DisputeRun;
  send: (b: DisputeSendBody) => Promise<InvoiceDispute>;
  onClose: () => void;
  /** küme değiştiğinde "itiraz metnini yeniden al" bağlantısı */
  onReopenText?: () => void;
}) {
  const { t } = useTranslation('disputes');
  const today = turkeyDate(new Date());
  const [sentOn, setSentOn] = useState(today);
  const [channel, setChannel] = useState<DisputeChannel>('EMAIL');
  const [channelNote, setChannelNote] = useState('');
  const [reference, setReference] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, submit } = useSubmit();
  const selectionChanged = error instanceof ApiError && error.code === 'SELECTION_CHANGED';
  // metnin kümesi artık geçerli değil: aynı metinle yeniden kaydedilemez (kartta görünen küme ise yenilenince güncellenir)
  const staleDraft = !!draft && selectionChanged;
  const d = invoice.dispute;
  const sel: SendSelection = draft ?? { lineCount: d?.sendableLineCount ?? 0, total: d?.sendableAmount, selectionDigest: d?.selectionDigest };
  const n = sel.lineCount;
  const errs = validateSend({ sentOn, today, invoiceDate: invoice.invoiceDate, channel, channelNote });
  const errText = (k?: string) => (!tried || !k ? null : k === 'future' ? t('field.future') : k === 'beforeInvoice' ? t('field.beforeInvoice') : t('field.required'));
  const resend = !!round;

  const save = () => {
    setTried(true);
    if (Object.keys(errs).length || staleDraft) return;
    void submit(
      () =>
        run(
          () =>
            send({
              sentOn,
              channel,
              channelNote: channel === 'OTHER' ? channelNote.trim() : undefined,
              reference: reference.trim() || undefined,
              ...(sel.selectionDigest ? { selectionDigest: sel.selectionDigest } : {}),
            }),
          resend ? t('send.resendToast') : t('send.toast'),
        ),
      onClose,
    );
  };

  return (
    <Modal
      busy={busy}
      label={label(invoice)}
      title={resend ? t('send.resendTitle') : t('send.title')}
      onClose={onClose}
      className="dsp-dlg"
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('send.cancel')}
          </ModalAction>
          <ModalAction kind="prim" icon="check" loading={busy} onClick={save} disabled={n === 0 || staleDraft}>
            {resend ? t('send.resendSave') : t('send.save')}
          </ModalAction>
        </>
      }
    >
      {selectionChanged ? (
        <div className="notif err" role="alert">
          <Icon name="err" />
          <span>
            {t('errors.SELECTION_CHANGED')}
            {onReopenText && (
              <>
                {' '}
                <button type="button" className="link-btn" onClick={onReopenText}>
                  {t('send.reopenText')}
                </button>
              </>
            )}
          </span>
        </div>
      ) : (
        <ErrorNote error={error} />
      )}
      {resend && <p className="dsp-dlg-intro">{t('send.resendIntro')}</p>}
      <p className="dsp-dlg-intro">
        {n === 0 ? (
          t('card.nothingToSend')
        ) : showPrices && sel.total != null ? (
          <Trans t={t} i18nKey="send.intro" count={n} values={{ n: fmtNum(n), amount: fmtMoney(sel.total, invoice.currency) }} components={{ b: <b className="num" /> }} />
        ) : (
          t('send.introNoPrice', { count: n, n: fmtNum(n) })
        )}
      </p>
      {(d?.recalcPendingLines ?? 0) > 0 && (
        <div className="notif warn" role="status">
          <Icon name="warn" />
          <span>{t('send.pendingLines', { count: d!.recalcPendingLines, n: fmtNum(d!.recalcPendingLines!) })}</span>
        </div>
      )}
      <div className="form-stack">
        <Field label={t('send.sentOn')} htmlFor="ds-on" className="req" error={errText(errs.sentOn)}>
          <input
            id="ds-on"
            type="date"
            className="inp w-md"
            value={sentOn}
            max={today}
            min={invoice.invoiceDate?.slice(0, 10)}
            aria-invalid={(tried && !!errs.sentOn) || undefined}
            onChange={(e) => setSentOn(e.target.value)}
          />
        </Field>
        <Field label={t('send.channel')}>
          <div className="seg" role="group" aria-label={t('send.channel')}>
            {CHANNELS.map((c) => (
              <button key={c} type="button" className={channel === c ? 'on' : ''} aria-pressed={channel === c} onClick={() => setChannel(c)}>
                {t(`channel.${c}`)}
              </button>
            ))}
          </div>
        </Field>
        {channel === 'OTHER' && (
          <Field label={t('send.channelNote')} htmlFor="ds-note" className="req" error={tried && errs.channelNote ? t('field.required') : null}>
            <input
              id="ds-note"
              className="inp"
              maxLength={200}
              value={channelNote}
              aria-invalid={(tried && !!errs.channelNote) || undefined}
              onChange={(e) => setChannelNote(e.target.value)}
            />
          </Field>
        )}
        <Field label={t('send.reference')} htmlFor="ds-ref">
          <input id="ds-ref" className="inp w-lg" maxLength={64} value={reference} onChange={(e) => setReference(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

const symbolOf = (cur: string) => fmtMoney(0, cur).replace(/[\d.,\s\u00A0−-]/g, '') || cur;

/** Sonuç girişi: bekleyen satırlar seçilir; geri alındıysa dekont no, tarih ve satır başına tutar (kısmi olabilir), reddedildiyse neden. */
export function ResultDialog({
  invoice,
  round,
  showPrices,
  run,
  onClose,
  add,
}: {
  invoice: Invoice;
  round: DisputeRound;
  showPrices: boolean;
  run: DisputeRun;
  add: (b: { kind: 'RECOVERED' | 'REJECTED'; resultOn: string; creditNoteNo?: string; reason?: string; lines: { disputeLineId: string; amount?: number }[] }) => Promise<InvoiceDispute>;
  onClose: () => void;
}) {
  const { t } = useTranslation('disputes');
  const today = turkeyDate(new Date());
  const cur = round.currency || invoice.currency || '';
  const pending = round.lines.filter((l) => l.outcome === 'PENDING');
  const [kind, setKind] = useState<'RECOVERED' | 'REJECTED'>('RECOVERED');
  const [picked, setPicked] = useState<Set<string>>(() => new Set(pending.map((l) => l.id)));
  const [amounts, setAmounts] = useState<Record<string, string>>(() =>
    Object.fromEntries(pending.map((l) => [l.id, l.claimedAmount != null ? numToInput(l.claimedAmount, 2) : ''])),
  );
  // K36 incelemesi: arayüz dili değişince yazılmış sayılar anlamını korur (Türkçe "6.000" İngilizcede 6 olmasın)
  useLocaleSwitch((from, to) => setAmounts((a) => Object.fromEntries(Object.entries(a).map(([id, v]) => [id, relocalizeNumberText(v, from, to)]))));
  const [creditNoteNo, setCreditNoteNo] = useState('');
  const [resultOn, setResultOn] = useState(today);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, submit, clearError } = useSubmit();
  const recovered = kind === 'RECOVERED';

  const amountOf = (id: string) => parseTrNumber(amounts[id] ?? '');
  const rows = pending.filter((l) => picked.has(l.id));
  const badAmount = (id: string, claimed?: number) => recovered && picked.has(id) && !amountValid(amountOf(id), claimed);
  const tot = recoveryTotals(rows.map((l) => ({ claimed: l.claimedAmount, amount: recovered ? amountOf(l.id) : 0 })));
  const dateErr = !/^\d{4}-\d{2}-\d{2}$/.test(resultOn)
    ? t('field.required')
    : resultOn > today
      ? t('field.future')
      : resultOn < round.sentOn
        ? t('field.beforeSent')
        : null;
  const errs = {
    pick: rows.length === 0,
    creditNote: recovered && !creditNoteNo.trim(),
    amount: rows.some((l) => badAmount(l.id, l.claimedAmount)),
    reason: !recovered && !reason.trim(),
    date: !!dateErr,
  };
  const lineName = (l: (typeof pending)[number]) => l.trackingNo ?? (l.lineNo != null ? t('card.lines.lineNo', { n: l.lineNo }) : '—');

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const save = () => {
    setTried(true);
    if (Object.values(errs).some(Boolean)) {
      // alan hatası gösterilirken önceki sunucu iletisi kalmasın
      clearError();
      return;
    }
    void submit(
      () =>
        run(
          () =>
            add({
              kind,
              resultOn,
              creditNoteNo: recovered ? creditNoteNo.trim() : undefined,
              reason: recovered ? undefined : reason.trim(),
              lines: rows.map((l) => ({ disputeLineId: l.id, ...(recovered ? { amount: amountOf(l.id) ?? undefined } : {}) })),
            }),
          recovered ? t('result.toastRecovered') : t('result.toastRejected'),
        ),
      onClose,
      // sunucu hatasında (ör. STALE sonrası yeniden okunan tur) yalnız o ileti görünsün, alan hataları bir sonraki denemede
      () => setTried(false),
    );
  };

  return (
    <Modal
      busy={busy}
      label={label(invoice)}
      title={t('result.title')}
      size="wide"
      onClose={onClose}
      className="dsp-dlg"
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('result.cancel')}
          </ModalAction>
          <ModalAction kind="prim" icon="check" loading={busy} onClick={save} disabled={!pending.length}>
            {t('result.save')}
          </ModalAction>
        </>
      }
    >
      <ErrorNote error={error} />
      {!pending.length ? (
        <p className="dsp-dlg-intro">{t('result.noPending')}</p>
      ) : (
        <div className="form-stack">
          <Field label={t('result.kind')}>
            <div className="seg" role="group" aria-label={t('result.kind')}>
              {(['RECOVERED', 'REJECTED'] as const).map((k) => (
                <button key={k} type="button" className={kind === k ? 'on' : ''} aria-pressed={kind === k} onClick={() => setKind(k)}>
                  {k === 'RECOVERED' ? t('result.recovered') : t('result.rejected')}
                </button>
              ))}
            </div>
          </Field>
          <Field label={t('result.pickLines')} error={tried && errs.pick ? t('result.errPick') : null}>
            <div className="dsp-pick" role="group" aria-label={t('result.pickLines')}>
              {pending.map((l) => {
                const bad = tried && badAmount(l.id, l.claimedAmount);
                return (
                  <div className="dsp-pick-row" key={l.id}>
                    <label className="check">
                      <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />{' '}
                      <span>
                        <span className="mono">{lineName(l)}</span>
                        {showPrices && l.claimedAmount != null && <span className="sub">{t('result.claim', { amount: fmtMoney(l.claimedAmount, cur) })}</span>}
                      </span>
                    </label>
                    {recovered && (
                      <Affix sfx={symbolOf(cur)}>
                        <input
                          className="inp num"
                          inputMode="decimal"
                          aria-label={t('result.amountFor', { line: lineName(l) })}
                          aria-invalid={bad || undefined}
                          disabled={!picked.has(l.id)}
                          value={amounts[l.id] ?? ''}
                          onChange={(e) => setAmounts((a) => ({ ...a, [l.id]: e.target.value }))}
                        />
                      </Affix>
                    )}
                    {bad && <span className="err">{t('result.errAmount')}</span>}
                  </div>
                );
              })}
            </div>
            {recovered && showPrices && tot.shortfall > 0 && (
              <p className="dsp-tot" aria-live="polite">
                {t('result.shortfall', { amount: fmtMoney(tot.shortfall, cur) })}
              </p>
            )}
          </Field>
          {recovered ? (
            <div className="form-grid">
              <Field label={t('result.creditNoteNo')} htmlFor="dr-cn" className="req" error={tried && errs.creditNote ? t('result.errCreditNote') : null}>
                <input
                  id="dr-cn"
                  className="inp"
                  maxLength={CREDIT_NOTE_MAX}
                  value={creditNoteNo}
                  aria-invalid={(tried && errs.creditNote) || undefined}
                  onChange={(e) => setCreditNoteNo(e.target.value)}
                />
              </Field>
              <Field label={t('result.creditNoteDate')} htmlFor="dr-on" className="req" error={tried ? dateErr : null}>
                <input id="dr-on" type="date" className="inp w-md" min={round.sentOn} max={today} value={resultOn} onChange={(e) => setResultOn(e.target.value)} />
              </Field>
            </div>
          ) : (
            <>
              <Field label={t('result.rejectedOn')} htmlFor="dr-on" className="req" error={tried ? dateErr : null}>
                <input id="dr-on" type="date" className="inp w-md" min={round.sentOn} max={today} value={resultOn} onChange={(e) => setResultOn(e.target.value)} />
              </Field>
              <Field label={t('result.reason')} htmlFor="dr-reason" className="req" error={tried && errs.reason ? t('result.errReason') : null}>
                <textarea
                  id="dr-reason"
                  className="txt"
                  maxLength={REASON_MAX}
                  value={reason}
                  aria-invalid={(tried && errs.reason) || undefined}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Neden isteyen onay: sonuç girişini geri alma ve itirazı geri çekme. `children`: neyin geri alındığı (seçim). */
function ReasonDialog({
  invoice,
  title,
  intro,
  blocked,
  saveLabel,
  okMsg,
  run,
  act,
  onClose,
  danger,
  children,
}: {
  invoice: Invoice;
  title: string;
  intro?: ReactNode;
  blocked?: string | null;
  saveLabel: string;
  okMsg: string;
  run: DisputeRun;
  act: (reason: string) => Promise<InvoiceDispute>;
  onClose: () => void;
  danger?: boolean;
  children?: ReactNode;
}) {
  const { t } = useTranslation('disputes');
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const { busy, error, submit } = useSubmit();
  const save = () => {
    setTried(true);
    if (!reason.trim() || blocked) return;
    void submit(() => run(() => act(reason.trim()), okMsg), onClose);
  };
  return (
    <Modal
      busy={busy}
      label={label(invoice)}
      title={title}
      onClose={onClose}
      className="dsp-dlg"
      actions={
        <>
          <ModalAction kind="dark" onClick={onClose}>
            {t('revert.cancel')}
          </ModalAction>
          <ModalAction kind={danger ? 'danger' : 'prim'} loading={busy} onClick={save} disabled={!!blocked}>
            {saveLabel}
          </ModalAction>
        </>
      }
    >
      <ErrorNote error={error} />
      {blocked ? (
        <div className="notif warn" role="status">
          <Icon name="warn" />
          <span>{blocked}</span>
        </div>
      ) : (
        <>
          {intro && <p className="dsp-dlg-intro">{intro}</p>}
          {children}
          <Field label={t('revert.reason')} htmlFor="dx-reason" className="req" error={tried && !reason.trim() ? t('field.required') : null}>
            <textarea
              id="dx-reason"
              className="txt"
              maxLength={REASON_MAX}
              value={reason}
              aria-invalid={(tried && !reason.trim()) || undefined}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
        </>
      )}
    </Modal>
  );
}

/**
 * Yanlış sonuç girişini geri alır (silinmez, izde kalır). Birden çok giriş varsa hangisi seçilir; en yenisi önseçili.
 * 10-B12: yerini yeniye bırakmış turdaki giriş de listededir (satırları yeniden talep edilmemişse); onda tur no yazılır ve
 * satırın itiraz listesine döneceği söylenir.
 */
export function RevertDialog({
  invoice,
  results,
  activeRoundId,
  showPrices,
  cur,
  run,
  act,
  onClose,
}: {
  invoice: Invoice;
  /** geri alınabilecek girişler, yeni önce (`revertableResults`) */
  results: RevertableResult[];
  activeRoundId: string | null;
  showPrices: boolean;
  cur: string;
  run: DisputeRun;
  act: (picked: RevertableResult, reason: string) => Promise<InvoiceDispute>;
  onClose: () => void;
}) {
  const { t } = useTranslation('disputes');
  const [pick, setPick] = useState(results[0]?.result.id ?? '');
  const picked = results.find((x) => x.result.id === pick) ?? results[0];
  const old = (x: RevertableResult) => x.round.id !== activeRoundId;
  const what = ({ result: r, round }: RevertableResult) =>
    [
      old({ result: r, round }) ? t('card.round', { n: round.round }) : null,
      r.kind === 'RECOVERED' ? t('history.recovered', { no: r.creditNoteNo ?? '—' }) : t('history.rejected'),
      showPrices && r.amount != null ? fmtMoney(r.amount, cur) : null,
      fmtDate(r.resultOn),
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <ReasonDialog
      invoice={invoice}
      title={t('revert.title')}
      intro={picked && old(picked) ? t('revert.introOld') : t('revert.intro')}
      saveLabel={t('revert.save')}
      okMsg={t('revert.toast')}
      run={run}
      act={(reason) => act(picked!, reason)}
      onClose={onClose}
    >
      {results.length > 1 ? (
        <Field label={t('revert.which')}>
          <div className="dsp-which" role="radiogroup" aria-label={t('revert.which')}>
            {results.map((x) => (
              <label key={x.result.id} className="check">
                <input type="radio" name="dx-which" checked={pick === x.result.id} onChange={() => setPick(x.result.id)} /> {what(x)}
              </label>
            ))}
          </div>
        </Field>
      ) : (
        results[0] && <p className="dsp-dlg-intro sb">{what(results[0])}</p>
      )}
    </ReasonDialog>
  );
}

export function WithdrawDialog({
  invoice,
  round,
  run,
  act,
  onClose,
}: {
  invoice: Invoice;
  round: DisputeRound;
  run: DisputeRun;
  act: (reason: string) => Promise<InvoiceDispute>;
  onClose: () => void;
}) {
  const { t } = useTranslation('disputes');
  return (
    <ReasonDialog
      invoice={invoice}
      title={t('withdraw.title')}
      intro={t('withdraw.intro')}
      blocked={hasLiveRecovery(round) ? t('withdraw.blocked') : null}
      saveLabel={t('withdraw.save')}
      okMsg={t('withdraw.toast')}
      run={run}
      act={act}
      onClose={onClose}
      danger
    />
  );
}
