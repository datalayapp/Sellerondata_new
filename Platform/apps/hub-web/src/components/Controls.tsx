import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { HubFilterDef } from '@sellerondata/contracts';
import { Button, Field, Icon, formatDateRange } from '@sellerondata/shell';
import { RANGE_PRESETS, type RangeKey } from '../lib/period.ts';
import { useDebounced, useIsPhone } from '../lib/hooks.ts';
import type { Filters } from '../api/hub.ts';

/** Dışına tıklayınca ya da Esc ile kapanan açılır kutu. Kapanınca odak düğmeye döner. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  return { open, setOpen, wrap, trigger };
}

/**
 * Tarih aralığı: tek düğme, seçili aralığı söyler ("Son 30 gün"). Açılınca hazır aralıklar, özel aralık en sonda.
 * Bant üstünde durur (D09 `.btn-s`).
 */
export function PeriodControl({
  range,
  from,
  to,
  onChange,
}: {
  range: RangeKey;
  from: string;
  to: string;
  onChange: (r: RangeKey, custom?: { from: string; to: string }) => void;
}) {
  const { t, i18n } = useTranslation();
  const pop = usePopover();
  const popId = useId();
  const [draftFrom, setFrom] = useState(from);
  const [draftTo, setTo] = useState(to);
  useEffect(() => {
    setFrom(from);
    setTo(to);
  }, [from, to]);
  const fromId = useId();
  const toId = useId();
  const [custom, setCustom] = useState(range === 'custom');
  useEffect(() => setCustom(range === 'custom'), [range]);
  const valid = draftFrom && draftTo && draftFrom <= draftTo;
  const label = range === 'custom' ? formatDateRange(from, to, i18n.language) : t(`period.last.${range}`);
  return (
    <div className="hub-period" ref={pop.wrap}>
      <button
        ref={pop.trigger}
        type="button"
        className="btn btn-secondary hub-period-btn"
        aria-label={t('period.button', { range: label })}
        aria-expanded={pop.open}
        aria-controls={pop.open ? popId : undefined}
        onClick={() => pop.setOpen((v) => !v)}
      >
        <Icon name="calendar" />
        <span className="hub-range">{label}</span>
        <Icon name="chev" size={14} />
      </button>
      {pop.open && (
        <div className="hub-pop hub-period-pop" id={popId} role="group" aria-label={t('period.label')}>
          {RANGE_PRESETS.map((k) => (
            <button
              key={k}
              type="button"
              className="hub-pop-item"
              aria-pressed={range === k && !custom}
              onClick={() => {
                setCustom(false);
                pop.setOpen(false);
                pop.trigger.current?.focus();
                onChange(k);
              }}
            >
              <span>{t(`period.last.${k}`)}</span>
              {range === k && !custom && <Icon name="check" />}
            </button>
          ))}
          <button type="button" className="hub-pop-item" aria-pressed={custom} aria-expanded={custom} onClick={() => setCustom((v) => !v)}>
            <span>{t('period.custom')}</span>
            {custom && <Icon name="check" />}
          </button>
          {custom && (
            <form
              className="hub-period-custom"
              onSubmit={(e) => {
                e.preventDefault();
                if (!valid) return;
                pop.setOpen(false);
                pop.trigger.current?.focus();
                onChange('custom', { from: draftFrom, to: draftTo });
              }}
            >
              <Field label={t('period.from')} htmlFor={fromId}>
                <input id={fromId} type="date" className="inp sm" value={draftFrom} max={draftTo} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label={t('period.to')} htmlFor={toId}>
                <input id={toId} type="date" className="inp sm" value={draftTo} min={draftFrom} onChange={(e) => setTo(e.target.value)} />
              </Field>
              <Button kind="secondary" small type="submit" disabled={!valid}>
                {t('period.apply')}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

/** Çoklu seçim: açılır kutu listesi. Yerel `select multiple` kullanıcıyı Ctrl tuşuna zorlar. */
function MultiSelect({ def, value, onChange, id }: { def: Extract<HubFilterDef, { kind: 'select' }>; value: string[]; onChange: (v: string[]) => void; id: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);
  const summary = !value.length ? t('filter.all') : value.length === 1 ? (def.options.find((o) => o.value === value[0])?.label ?? value[0]) : t('filter.selected', { count: value.length });
  return (
    <div className="hub-multi" ref={wrap}>
      <button id={id} type="button" className="sel sm hub-multi-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ellipsis">{summary}</span>
      </button>
      {open && (
        <div className="hub-multi-pop">
          {def.options.map((o) => (
            <label key={o.value} className="check">
              <input
                type="checkbox"
                checked={value.includes(o.value)}
                onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function TextFilter({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const debounced = useDebounced(draft);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (debounced !== value) onChange(debounced);
    // yalnız yazma durunca gönderilir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  return <input id={id} className="inp sm w-md" value={draft} onChange={(e) => setDraft(e.target.value)} />;
}

/** Sözleşmedeki süzgeç tanımlarını çizer. Etiketler üründen gelir. */
/** Hedef ülke: sözleşmede metin süzgeci, değer ISO kodu. Kişi kod bilmek zorunda kalmasın. */
const COUNTRY_CODES = ['TR', 'DE', 'US', 'GB', 'NL', 'FR', 'IT', 'ES', 'BE', 'AT', 'CH', 'SE', 'DK', 'NO', 'FI', 'PL', 'CZ', 'RO', 'BG', 'GR', 'IE', 'PT', 'HU', 'SA', 'AE', 'QA', 'KW', 'IQ', 'AZ', 'RU', 'UA', 'CA', 'AU', 'JP', 'CN', 'KR'];

export function FilterControls({
  defs,
  value,
  onChange,
  visible,
  defaults,
}: {
  defs: HubFilterDef[];
  value: Filters;
  onChange: (f: Filters) => void;
  /** Bu kadarı açık durur, kalanı "Filtreler" düğmesiyle. Etkin süzgeç hep görünür. */
  visible?: number;
  /** Seçim yokken gerçekte uygulanan değer. Bu süzgeçte "Tümü" yazılmaz: yanlış olurdu. */
  defaults?: Record<string, string>;
}) {
  const { t, i18n } = useTranslation();
  const base = useId();
  const [open, setOpen] = useState(false);
  const set = (id: string, v: string | string[]) => {
    const next = { ...value };
    if ((Array.isArray(v) && !v.length) || v === '') delete next[id];
    else next[id] = v;
    onChange(next);
  };
  if (!defs.length) return null;
  const active = Object.keys(value).length > 0;
  const limit = visible ?? defs.length;
  const shown = defs.filter((d, i) => open || i < limit || value[d.id] !== undefined);
  const hidden = defs.length - shown.length;
  const activeCount = Object.keys(value).length;
  return (
    <>
      {shown.map((d) => {
        const id = `${base}-${d.id}`;
        const raw = value[d.id];
        if (d.kind === 'text' && (d.id === 'from' || d.id === 'to')) {
          // Sözleşmede tarih türü yok; gün süzgeçleri `from`/`to` adıyla gelir.
          return (
            <Field key={d.id} label={d.label} htmlFor={id}>
              <input id={id} type="date" className="inp sm w-sm" value={typeof raw === 'string' ? raw : ''} onChange={(e) => set(d.id, e.target.value)} />
            </Field>
          );
        }
        if (d.kind === 'text' && d.id === 'country') {
          const code = typeof raw === 'string' ? raw.toUpperCase() : '';
          const names = new Intl.DisplayNames([i18n.language], { type: 'region' });
          const codes = Array.from(new Set([...(code ? [code] : []), ...COUNTRY_CODES]));
          return (
            <Field key={d.id} label={d.label} htmlFor={id}>
              <select id={id} className="sel sm w-md" value={code} onChange={(e) => set(d.id, e.target.value)}>
                <option value="">{t('filter.all')}</option>
                {codes.map((c) => (
                  <option key={c} value={c}>
                    {names.of(c) ?? c}
                  </option>
                ))}
              </select>
            </Field>
          );
        }
        if (d.kind === 'text') {
          return (
            <Field key={d.id} label={d.label} htmlFor={id}>
              <TextFilter id={id} value={typeof raw === 'string' ? raw : ''} onChange={(v) => set(d.id, v)} />
            </Field>
          );
        }
        if (d.multiple) {
          return (
            <Field key={d.id} label={d.label} htmlFor={id}>
              <MultiSelect id={id} def={d} value={Array.isArray(raw) ? raw : raw ? [raw] : []} onChange={(v) => set(d.id, v)} />
            </Field>
          );
        }
        const fixed = d.default ?? defaults?.[d.id];
        const options = fixed && !d.options.some((o) => o.value === fixed) ? [{ value: fixed, label: fixed }, ...d.options] : d.options;
        return (
          <Field key={d.id} label={d.label} htmlFor={id}>
            <select id={id} className="sel sm w-md" value={typeof raw === 'string' ? raw : (fixed ?? '')} onChange={(e) => set(d.id, e.target.value === fixed ? '' : e.target.value)}>
              {!fixed && <option value="">{t('filter.all')}</option>}
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        );
      })}
      {(hidden > 0 || open) && limit < defs.length && (
        <button type="button" className="btn btn-secondary btn-sm hub-clear" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <Icon name="filter" /> {open ? t('filter.less') : activeCount ? t('filter.moreActive', { count: activeCount }) : t('filter.more')}
        </button>
      )}
      {active && (
        <button type="button" className="btn btn-ghost plain btn-sm hub-clear" onClick={() => onChange({})}>
          <Icon name="close" /> {t('filter.clear')}
        </button>
      )}
    </>
  );
}

/**
 * "Filtre (2)" düğmesi ve paneli: masaüstünde sayfa içi satır, telefonda alttan açılan sayfa.
 * Süzgeçler anında uygulanır. Düğme çubukta, panel altında durduğu için kanca: ikisi ayrı yere konur.
 */
export function useFilterPanel(count: number, title: string): { button: ReactNode; render: (children: ReactNode) => ReactNode } {
  const { t } = useTranslation();
  const phone = useIsPhone();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open, phone]);
  return {
    button: (
      <button type="button" className={`btn btn-secondary btn-sm hub-filter-btn${count > 0 ? ' has-active' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="filter" /> {count > 0 ? t('filter.button', { count }) : t('filter.buttonIdle')}
      </button>
    ),
    render: (children) =>
      phone ? (
        <dialog ref={dialog} className="hub-sheet-dialog" aria-label={title} onClose={() => setOpen(false)}>
          <div className="hub-sheet-dialog-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label={t('common.dismiss')} onClick={() => setOpen(false)}>
              <Icon name="close" />
            </button>
          </div>
          <div className="hub-sheet-dialog-body">{children}</div>
          <div className="hub-sheet-dialog-foot">
            <Button onClick={() => setOpen(false)}>{t('filter.done')}</Button>
          </div>
        </dialog>
      ) : open ? (
        <div className="hub-filter-panel">{children}</div>
      ) : null,
  };
}

/** Süzgeçler adreste: `filter.<id>=değer` (tekrar edebilir). */
export function readFilters(params: URLSearchParams): Filters {
  const out: Filters = {};
  for (const key of new Set(params.keys())) {
    if (!key.startsWith('filter.')) continue;
    const all = params.getAll(key);
    out[key.slice(7)] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

export function writeFilters(params: URLSearchParams, filters: Filters): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of Array.from(next.keys())) if (key.startsWith('filter.')) next.delete(key);
  for (const [k, v] of Object.entries(filters)) for (const item of Array.isArray(v) ? v : [v]) next.append(`filter.${k}`, item);
  next.delete('page');
  return next;
}
