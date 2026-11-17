import { useRef, useState, type ClipboardEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Icon } from '../../components/Icon';
import { toast } from '../../components/Toast';
import { NumberChoiceDialog } from '../../components/NumberChoiceDialog';
import { WeightChoice } from '../../components/WeightChoice';
import { Button } from '../../components/ui';
import { fmtNum, numToInput, parseTrNumber } from '../../lib/format';
import { weightChoice } from '../../lib/weightChoice';
import { bandText } from '../tariff-import/shared';
import { curSym, duplicateZoneColumns, emptyRow, nextZoneName, normalize, pasteAmbiguity, pasteBlock, removeZone as dropZone, renameZone as setZoneName, type Draft } from './draft';
import { Sec, useTariffReadOnly } from './Sec';

export function RateGrid({ d, setDraft }: { d: Draft; setDraft: (d: Draft) => void }) {
  const { t } = useTranslation('tariffEditor');
  const readOnly = useTariffReadOnly();
  const tableRef = useRef<HTMLTableElement>(null);
  const [askPaste, setAskPaste] = useState<{ r: number; c: number; text: string; header: boolean; example: string; asTr: number; asEn: number } | null>(null);

  const applyPaste = (r: number, c: number, text: string, header: boolean, format?: 'tr' | 'en') => {
    const next = pasteBlock(d, r, c, text, header, format);
    if (!next) return false;
    setDraft(next);
    toast.info(t('grid.pasted'), t('grid.size', { rows: t('units.rows', { count: next.rows.length, formatted: fmtNum(next.rows.length) }), zones: t('units.zones', { count: next.zones.length, formatted: fmtNum(next.zones.length) }) }));
    return true;
  };

  const onPaste = (r: number, c: number, header = false) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    // biçimi belli olmayan sayıda tahmin yok: tek hücre dahil kullanıcıya sorulur
    const ambiguity = pasteAmbiguity(text, c, header);
    if (ambiguity) {
      e.preventDefault();
      setAskPaste({ r, c, text, header, ...ambiguity });
      return;
    }
    if (!text.includes('\t') && !text.includes('\n')) return;
    if (applyPaste(r, c, text, header)) e.preventDefault();
  };

  const focusCell = (r: number, c: number) => {
    const el = tableRef.current?.querySelector<HTMLInputElement>(`[data-cell="${r}:${c}"]`);
    el?.focus();
    el?.select();
  };
  const onKey = (r: number, c: number) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (r === d.rows.length - 1 && e.key === 'Enter') {
        setDraft(normalize({ ...d, rows: [...d.rows, emptyRow()] }));
        setTimeout(() => focusCell(r + 1, c), 0);
      } else focusCell(r + 1, c);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      focusCell(r - 1, c);
    }
  };

  const setCell = (r: number, c: number, v: string) =>
    setDraft({
      ...d,
      rows: d.rows.map((row, i) => (i !== r ? row : c === -1 ? { ...row, upto: v } : { ...row, prices: row.prices.map((p, j) => (j === c ? v : p)) })),
    });

  // Ülke eşlemesi sütuna bağlı: ad yazılırken bir an başka bölgenin adına denk gelse de ülkeler yer değiştirmez (10-B1).
  const renameZone = (c: number, v: string) => setDraft(setZoneName(d, c, v));
  const removeZone = (c: number) => setDraft(dropZone(d, c));
  const dupCols = duplicateZoneColumns(d.zones);

  const togglePk = (r: number) => setDraft({ ...d, rows: d.rows.map((row, i) => (i === r ? { ...row, perKg: !row.perKg } : row)) });
  /** lower bound of a band = the largest smaller weight in the table */
  const lowerOf = (w: number) => d.rows.reduce((lo, x) => {
    const v = parseTrNumber(x.upto);
    return v !== null && v < w && v > lo ? v : lo;
  }, 0);
  const sym = curSym(d.currency);
  const pkCount = d.rows.filter((x) => x.perKg).length;

  const sortRows = () => {
    const rows = [...d.rows].sort((a, b) => (parseTrNumber(a.upto) ?? Infinity) - (parseTrNumber(b.upto) ?? Infinity));
    setDraft({ ...d, rows });
  };

  return (
    <Sec
      id="te-rates"
      title={t('grid.title')}
      desc={t(readOnly ? 'grid.descView' : 'grid.desc')}
      actions={
        <>
          <Button kind="ghost" small onClick={sortRows}>
            {t('grid.sort')}
          </Button>
          <Button kind="secondary" small icon="plus" onClick={() => setDraft(normalize({ ...d, zones: [...d.zones, nextZoneName(d.zones)] }))}>
            {t('grid.addZone')}
          </Button>
        </>
      }
    >
      <div className="rg-meta">
        <span>
          <Trans t={t} i18nKey="grid.pricesIn" values={{ currency: d.currency }} components={{ b: <b /> }} />
        </span>
        <span className="num">
          {t('grid.size', { rows: t('units.rows', { count: d.rows.length, formatted: fmtNum(d.rows.length) }), zones: t('units.zones', { count: d.zones.length, formatted: fmtNum(d.zones.length) }) })}
          {pkCount > 0 && ` · ${t('grid.perKgBands', { count: pkCount, formatted: fmtNum(pkCount) })}`}
        </span>
      </div>
      <div className="rg-wrap" role="group" aria-label={t('grid.scrollableAria')}>
        <table className="rg" ref={tableRef}>
          <thead>
            <tr>
              <th scope="col" className="rg-w">
                {t('weight.steps.upto')} <span className="rg-unit">kg</span>
              </th>
              {d.zones.map((z, c) => (
                <th key={c} scope="col" className="rg-z">
                  <div className="rg-zh">
                    <input
                      aria-label={t('grid.zoneNameAria', { n: c + 1 })}
                      className={`cell${!z.trim() || dupCols.includes(c) ? ' invalid' : ''}`}
                      aria-invalid={!z.trim() || dupCols.includes(c) || undefined}
                      value={z}
                      onChange={(e) => renameZone(c, e.target.value)}
                      onPaste={onPaste(0, c, true)}
                    />
                    {!readOnly && (
                      <button type="button" className="rg-x" aria-label={t('grid.deleteZoneAria', { zone: z })} title={t('grid.deleteZone')} onClick={() => removeZone(c)} disabled={d.zones.length <= 1}>
                        <Icon name="close" size={14} />
                      </button>
                    )}
                  </div>
                </th>
              ))}
              {!readOnly && (
                <th className="rg-act">
                  <span className="sr-only">{t('grid.deleteRow')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((row, r) => {
              const wv = parseTrNumber(row.upto);
              // K36: "1.500" seçilene dek kırmızı; seçim alanın altında
              const wBad = (row.upto.trim() !== '' && (wv ?? 0) <= 0) || weightChoice(row.upto) !== null;
              return (
                <tr key={r} className={row.perKg ? 'rg-pkrow' : undefined}>
                  <td className="rg-w">
                    <div className="rg-wc">
                      <input
                        data-cell={`${r}:-1`}
                        aria-label={t('grid.rowWeightAria', { n: r + 1 })}
                        className={`cell num${wBad ? ' invalid' : ''}`}
                        inputMode="decimal"
                        value={row.upto}
                        placeholder="kg"
                        onChange={(e) => setCell(r, -1, e.target.value)}
                        onPaste={onPaste(r, -1)}
                        onKeyDown={onKey(r, -1)}
                      />
                      {!readOnly && (
                        <button
                          type="button"
                          className={`rg-pk${row.perKg ? ' on' : ''}`}
                          aria-pressed={row.perKg}
                          aria-label={t('grid.perKgAria', { weight: row.upto || r + 1 })}
                          title={t(row.perKg ? 'grid.perKgOn' : 'grid.perKgOff')}
                          onClick={() => togglePk(r)}
                        >
                          /kg
                        </button>
                      )}
                    </div>
                    {!readOnly && <WeightChoice value={row.upto} onPick={(v) => setCell(r, -1, v)} />}
                    {row.perKg && <span className="rg-band num">{wv && wv > 0 ? `${bandText(lowerOf(wv), wv)} · ${t('grid.perKg')}` : t('grid.perKg')}</span>}
                  </td>
                  {row.prices.map((p, c) => (
                    <td key={c} className={row.perKg ? 'rg-pkc' : undefined}>
                      <input
                        data-cell={`${r}:${c}`}
                        aria-label={t(row.perKg ? 'grid.cellPerKgAria' : 'grid.cellAria', { weight: row.upto || r + 1, zone: d.zones[c] })}
                        className={`cell num${p.trim() && parseTrNumber(p) === null ? ' invalid' : ''}`}
                        inputMode="decimal"
                        value={p}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        onPaste={onPaste(r, c)}
                        onKeyDown={onKey(r, c)}
                      />
                      {row.perKg && (
                        <span className="rg-pku" aria-hidden="true">
                          {sym}/kg
                        </span>
                      )}
                    </td>
                  ))}
                  {!readOnly && (
                    <td className="rg-act">
                      <button
                        type="button"
                        className="rg-x"
                        aria-label={t('grid.deleteRowAria', { n: r + 1 })}
                        title={t('grid.deleteRow')}
                        onClick={() => setDraft({ ...d, rows: d.rows.length > 1 ? d.rows.filter((_, j) => j !== r) : [emptyRow(d.zones.length)] })}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="rg-w rg-over" title={t('grid.overflowHint')}>
                {t('grid.overflow')}
              </th>
              {d.overflow.map((o, c) => (
                <td key={c}>
                  <input
                    aria-label={t('grid.overflowAria', { zone: d.zones[c] })}
                    className={`cell num${o.trim() && parseTrNumber(o) === null ? ' invalid' : ''}`}
                    inputMode="decimal"
                    placeholder="—"
                    value={o}
                    onChange={(e) => setDraft({ ...d, overflow: d.overflow.map((x, j) => (j === c ? e.target.value : x)) })}
                  />
                </td>
              ))}
              {!readOnly && <td className="rg-act" />}
            </tr>
          </tfoot>
        </table>
      </div>
      {!readOnly && (
        <div className="rg-foot">
          <Button kind="ghost" small icon="plus" onClick={() => setDraft(normalize({ ...d, rows: [...d.rows, emptyRow()] }))}>
            {t('grid.addRow')}
          </Button>
          <span className="rg-hint">
            <Trans t={t} i18nKey="grid.help" values={{ sym }} components={{ b: <b /> }} />
          </span>
        </div>
      )}
      {askPaste && (
        <NumberChoiceDialog
          title={t('grid.ambiguous.title')}
          body={t('grid.ambiguous.body', { example: askPaste.example, asTr: numToInput(askPaste.asTr), asEn: numToInput(askPaste.asEn) })}
          hint={t('grid.ambiguous.hint')}
          cancel={t('grid.ambiguous.cancel')}
          readAs={(value) => t('grid.ambiguous.readAs', { example: askPaste.example, value })}
          asTr={askPaste.asTr}
          asEn={askPaste.asEn}
          onClose={() => setAskPaste(null)}
          onPick={(format) => {
            applyPaste(askPaste.r, askPaste.c, askPaste.text, askPaste.header, format);
            setAskPaste(null);
          }}
        />
      )}
    </Sec>
  );
}
