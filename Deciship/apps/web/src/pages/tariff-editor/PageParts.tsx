import type { Ref } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { TariffVersion } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Button, Modal, ModalAction } from '../../components/ui';
import { fmtDateTime, fmtNum } from '../../lib/format';
import type { Notice } from './draft';
import { noticeInvoices } from './noticeInvoices';
import { bulkSkipped } from '../invoice-detail/recalc';

/** Import / restore / created result with the follow-up actions (re-compare invoices, undo). */
export function ImportNotice({
  notice,
  noticeRef,
  recomparing,
  onRecompare,
  undoing,
  onUndo,
  onClose,
}: {
  notice: Notice;
  noticeRef: Ref<HTMLDivElement>;
  recomparing: boolean;
  onRecompare: () => void;
  undoing: boolean;
  onUndo: (versionId: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('tariffEditor');
  const { suggestRecompare, otherInvoices } = noticeInvoices(notice);
  return (
    <div className="notif ok te-notice" role="status" ref={noticeRef}>
      <Icon name="ok" />
      <div>
        {notice.kind === 'created' ? (
          <Trans
            t={t}
            i18nKey={notice.fileName ? 'notice.createdFromFile' : 'notice.created'}
            values={{ file: notice.fileName }}
            components={{ b: <b /> }}
          />
        ) : (
          <>
            <b>{t(notice.versionId ? 'notice.updatedKept' : 'notice.updated')}</b>{' '}
            {notice.kind !== 'saved' && t(notice.kind === 'restore' ? 'notice.restored' : 'notice.applied')}
            {notice.check && (
              <>
                {' '}
                {t('notice.currencyChanged')}{' '}
                <button type="button" className="link-btn" onClick={() => scrollToSection(notice.check === 'surcharges' ? 'te-sur' : 'te-rates')}>
                  {t(notice.check === 'surcharges' ? 'notice.checkSurcharges' : 'notice.checkOverflow')}
                </button>
              </>
            )}
          </>
        )}
        {suggestRecompare && (
          <p className="te-notice-p">
            <Trans
              t={t}
              i18nKey={notice.kind === 'created' ? 'notice.affectedCreated' : 'notice.affectedOld'}
              count={notice.affected}
              values={{ formatted: fmtNum(notice.affected) }}
              components={{ b: <b /> }}
            />
          </p>
        )}
        {otherInvoices > 0 && (
          <p className="te-notice-p">
            <Trans t={t} i18nKey="notice.otherInvoices" count={otherInvoices} values={{ formatted: fmtNum(otherInvoices) }} components={{ b: <b /> }} />
          </p>
        )}
        {notice.recompared && (
          <p className="te-notice-p">
            {t('notice.recompared', {
              invoices: t('units.invoices', { count: notice.recompared.invoices, formatted: fmtNum(notice.recompared.invoices) }),
            })}
            {bulkSkipped(notice.recompared) > 0 && ` ${t('notice.recomparedSkipped', { n: fmtNum(bulkSkipped(notice.recompared)) })}`}
          </p>
        )}
        <div className="te-notice-acts">
          {suggestRecompare && (
            <Button kind="secondary" small icon="refresh" loading={recomparing} onClick={onRecompare}>
              {t('notice.recompare')}
            </Button>
          )}
          {notice.versionId && (
            <Button kind="ghost" small icon="back" loading={undoing} onClick={() => onUndo(notice.versionId!)}>
              {t('notice.undo')}
            </Button>
          )}
        </div>
      </div>
      <Button kind="plain" small icon="close" aria-label={t('notice.close')} className="te-notice-x" onClick={onClose} />
    </div>
  );
}

/** Editör bölümüne kaydırır (Sec başlığının kimliği `<id>-h`) ve başlığa odaklanır. */
function scrollToSection(id: string) {
  const h = document.getElementById(`${id}-h`);
  if (!h) return;
  h.closest('section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
}

/** 10-B17: kaydedilmemiş taslak açıkken tarife başka yerde kaydedildi. Taslak ezilmez; güncel hâli yüklemek ya da bilerek üzerine yazmak seçilir. */
export function StaleNotice({ boxRef, saving, onReload, onOverwrite }: { boxRef: Ref<HTMLDivElement>; saving: boolean; onReload: () => void; onOverwrite: () => void }) {
  const { t } = useTranslation('tariffEditor');
  return (
    <div className="notif warn te-notice te-stale" role="alert" ref={boxRef}>
      <Icon name="warn" />
      <div>
        <b>{t('page.stale.title')}</b> {t('page.stale.body')}
        <div className="te-notice-acts">
          <Button kind="secondary" small icon="refresh" disabled={saving} onClick={onReload}>
            {t('page.stale.reload')}
          </Button>
          <Button kind="ghost" small loading={saving} onClick={onOverwrite}>
            {t('page.stale.overwrite')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ErrorList({ errors, boxRef }: { errors: string[]; boxRef: Ref<HTMLDivElement> }) {
  const { t } = useTranslation('tariffEditor');
  return (
    <div className="notif err" role="alert" ref={boxRef} tabIndex={-1}>
      <Icon name="err" />
      <div>
        <b>{t('errorList.title')}</b>
        <ul className="te-errlist">
          {errors.slice(0, 6).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function SaveBar({
  dirty,
  isNew,
  errCount,
  backTo,
  saving,
  canSave,
  onSave,
}: {
  dirty: boolean;
  isNew: boolean;
  errCount: number;
  backTo: string;
  saving: boolean;
  canSave: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation('tariffEditor');
  return (
    // is-dirty = gerçek kaydedilmemiş değişiklik (güncelleme bandı buna bakıp onay sorar); boş yeni taslak yalnız görünüşte uyarı rengi alır
    <div className={`savebar${dirty ? ' is-dirty' : isNew ? ' is-new' : ''}`} role="region" aria-label={t('savebar.save')}>
      <div className="savebar-in">
        <div className="savebar-state" aria-live="polite">
          {errCount > 0 ? (
            <>
              <Icon name="err" />
              <span>
                <b>{t('units.issues', { count: errCount, formatted: fmtNum(errCount) })}</b> <span className="sub">{t('savebar.fixFirst')}</span>
              </span>
            </>
          ) : dirty || isNew ? (
            <>
              <span className="savebar-dot" aria-hidden="true" />
              <span>
                <b>{t(isNew ? 'savebar.notSavedYet' : 'savebar.unsaved')}</b>
              </span>
            </>
          ) : (
            <>
              <Icon name="ok" />
              <span>{t('savebar.allSaved')}</span>
            </>
          )}
        </div>
        <div className="savebar-actions">
          <Link className="btn btn-secondary" to={backTo}>
            {t(dirty ? 'common.cancel' : 'savebar.backToList')}
          </Link>
          <Button icon="check" loading={saving} disabled={!canSave} onClick={onSave}>
            {t('savebar.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function RestoreConfirm({
  version: v,
  dirty,
  loading,
  onCancel,
  onConfirm,
}: {
  version: TariffVersion;
  dirty: boolean;
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('tariffEditor');
  return (
    <Modal
      label={t('versions.title')}
      title={t('restore.title')}
      onClose={onCancel}
      actions={
        <>
          <ModalAction kind="dark" onClick={onCancel}>
            {t('common.cancel')}
          </ModalAction>
          <ModalAction kind="prim" icon="check" loading={loading} onClick={onConfirm}>
            {t('versions.restore')}
          </ModalAction>
        </>
      }
    >
      <p>
        <Trans t={t} i18nKey="restore.body" values={{ date: fmtDateTime(v.createdAt), label: v.label }} components={{ b: <b /> }} />
      </p>
      <p className="t2 mt8 num">
        {t('units.rates', { count: v.rateCount, formatted: fmtNum(v.rateCount) })} · {t('units.zones', { count: v.zoneCount, formatted: fmtNum(v.zoneCount) })} ·{' '}
        {t('units.countries', { count: v.countryCount, formatted: fmtNum(v.countryCount) })} · {v.currency}
      </p>
      <div className="notif info mt16">
        <Icon name="info" />
        <span>{t('restore.info')}</span>
      </div>
      {dirty && (
        <div className="notif warn mt8">
          <Icon name="warn" />
          <span>{t('restore.dirtyWarn')}</span>
        </div>
      )}
    </Modal>
  );
}
