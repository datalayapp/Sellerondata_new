import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { PRODUCTS, PRODUCT_KEYS, productRole, type HubActivityItem, type HubActivityPage, type AuditMemberChange, type ProductKey } from '@sellerondata/contracts';
import { ApiError, Button, Empty, ErrorState, Field, Icon, PageHeader, ProductMark, Skel, currentLocale, formatDate, shellTimeZone, useMe } from '@sellerondata/shell';
import { fetchActivity } from '../api/hub.ts';
import { asList, type AuditItem, type AuditPage, type OrgMember } from '../api/types.ts';
import { useFilterPanel } from '../components/Controls.tsx';
import { SmartLink } from '../components/values.tsx';
import { isOrgAdmin, overviewProducts } from '../lib/access.ts';
import { useScope } from '../lib/hooks.ts';
import { isoDay } from '../lib/period.ts';
import { client } from '../lib/session.ts';

type Source = 'platform' | ProductKey;
type Item = HubActivityItem & { source: Source };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_DELAY = 300;

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/** "Üyeliği değiştirdi" neyin değiştiğini söyler: `details.changes` (AuditMemberChange). */
function memberChange(item: AuditItem, t: Translate): string | null {
  const changes = (item.details ?? item.meta)?.changes as AuditMemberChange[] | undefined;
  if (!changes?.length) return null;
  const locale = currentLocale();
  return changes
    .map((c) => {
      if (c.field === 'status') return t(c.to === 'SUSPENDED' ? 'activity.member.suspended' : 'activity.member.resumed');
      if (c.field === 'orgRole') return t('activity.member.orgRole', { role: t(`team.orgRoles.${c.to}`) });
      const k = c.product as ProductKey;
      const tool = PRODUCTS[k]?.name ?? c.product;
      // Değişiklik anındaki ad (`toLabel`; özel rol sonradan silinse de okunur), eski kayıtta katalog adı, o da yoksa anahtar.
      return c.to ? t('activity.member.toolRole', { tool, role: c.toLabel ?? productRole(k, c.to)?.label[locale] ?? c.to }) : t('activity.member.noAccess', { tool });
    })
    .join(', ');
}

/** Hesap denetim izi kod ve kimlik taşır; kişi adı üyelik listesinden, eylem metni çeviriden gelir. */
function readAudit(item: AuditItem, t: Translate, names: Map<string, string>): HubActivityItem {
  const metaName = item.targetName ?? (typeof item.meta?.name === 'string' ? item.meta.name : undefined);
  return {
    id: item.id,
    at: item.at,
    actor: item.actor,
    action: item.action === 'member.updated' ? (memberChange(item, t) ?? t('activity.actions.member.updated')) : t(`activity.actions.${item.action}`, { defaultValue: item.label ?? t('activity.actions.unknown') }),
    target: metaName ?? (item.target ? names.get(item.target) : undefined),
  };
}

function useFeed(source: Source, enabled: boolean, scope: readonly string[], audit: (item: AuditItem) => HubActivityItem) {
  return useInfiniteQuery<HubActivityPage>({
    queryKey: [...scope, 'activity', source],
    enabled,
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      if (source !== 'platform') return fetchActivity(source, pageParam as number);
      const page = await client.get<AuditPage>(`/api/account/org/audit?page=${pageParam}&pageSize=30`);
      return { ...page, items: page.items.map(audit) };
    },
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
  });
}

/** Etkinlik: platform + araç denetim izi tek zaman çizelgesinde. Bir kaynak yanıt vermezse yalnız o kaynak hata gösterir. */
export function Activity() {
  const { t, i18n } = useTranslation();
  const lng = i18n.language;
  const { me } = useMe();
  const scope = useScope();
  const admin = isOrgAdmin(me);
  const products = overviewProducts(me).map((p) => p.key);
  // Her araç için bir akış. Kayıt modül sabiti olduğu için kanca sayısı hiçbir çizimde değişmez; açık olan `overviewProducts(me)`.
  const members = useQuery({ queryKey: [...scope, 'members'], enabled: admin, queryFn: async () => asList<OrgMember>(await client.get('/api/account/org/members')) });
  const names = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m.name])), [members.data]);
  const audit = (item: AuditItem) => readAudit(item, t as Translate, names);
  const platform = useFeed('platform', admin && !members.isPending, scope, audit);
  // eslint-disable-next-line react-hooks/rules-of-hooks -- PRODUCT_KEYS modül sabiti: kanca sayısı ve sırası değişmez.
  const toolFeeds = PRODUCT_KEYS.map((key) => ({ key, q: useFeed(key, products.includes(key), scope, audit) }));

  const feeds = useMemo(
    () =>
      [
        { source: 'platform' as Source, q: platform, on: admin, name: t('activity.platform') },
        ...toolFeeds.map((f) => ({ source: f.key as Source, q: f.q, on: products.includes(f.key), name: PRODUCTS[f.key].name })),
      ].filter((f) => f.on && !(f.q.error instanceof ApiError && f.q.error.status === 403)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `toolFeeds` her çizimde yeni dizi; sorgu sonuçları değişince yeniden hesaplanır.
    [platform, ...toolFeeds.map((f) => f.q), admin, products, t],
  );
  // Süzgeçler adreste: `?source=&q=&person=&action=&from=&to=`. Yenileyince ve geri gelince korunur; geçersiz değer yok sayılır.
  const [params, setParams] = useSearchParams();
  const sourceParam = params.get('source');
  const filter: Source | 'all' = feeds.find((f) => f.source === sourceParam)?.source ?? 'all';
  const urlText = params.get('q') ?? '';
  const person = params.get('person') ?? '';
  const action = params.get('action') ?? '';
  const fromParam = params.get('from') ?? '';
  const toParam = params.get('to') ?? '';
  const fromDay = DAY.test(fromParam) ? fromParam : '';
  const toDay = DAY.test(toParam) ? toParam : '';
  const setParam = (key: string, value: string, replace = false) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      },
      { replace },
    );
  // Arama kutusu yerel durumla yazılır, 300 ms sonra adrese geçer (her tuş geçmişe kayıt eklemesin).
  const [text, setText] = useState(urlText);
  useEffect(() => setText(urlText), [urlText]);
  useEffect(() => {
    if (text.trim() === urlText) return;
    const id = window.setTimeout(() => setParam('q', text.trim(), true), SEARCH_DELAY);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `setParam` her çizimde yeni; yalnız yazılan metin ve adres değeri izlenir.
  }, [text, urlText]);
  const visible = feeds.filter((f) => filter === 'all' || f.source === filter);

  const items = useMemo(() => {
    const merged: Item[] = visible.flatMap((f) => (f.q.data?.pages ?? []).flatMap((p) => p.items.map((it) => ({ ...it, source: f.source }))));
    merged.sort((a, b) => b.at.localeCompare(a.at));
    // Daha fazla kaydı olan akışın son yüklenen kaydından eskileri tutma: sıra yanıltmasın.
    const horizon = visible
      .filter((f) => f.q.hasNextPage)
      .map((f) => f.q.data?.pages.at(-1)?.items.at(-1)?.at)
      .filter((x): x is string => !!x)
      .sort()
      .at(-1);
    return horizon ? merged.filter((m) => m.at >= horizon) : merged;
  }, [visible]);

  const people = useMemo(() => [...new Set(items.map((i) => i.actor ?? t('activity.system')))].sort((a, b) => a.localeCompare(b, lng)), [items, t, lng]);
  const actions = useMemo(() => [...new Set(items.map((i) => i.action))].sort((a, b) => a.localeCompare(b, lng)), [items, lng]);
  const narrowed = !!(text.trim() || urlText || person || action || fromDay || toDay);
  // Arama hep açık; kişi, işlem ve tarih "Filtre" düğmesinin arkasında (masaüstünde satır, telefonda alt sayfa).
  const narrowCount = [person, action, fromDay, toDay].filter(Boolean).length;
  const filterPanel = useFilterPanel(narrowCount, t('filter.panelTitle'));
  // Süzme yüklenmiş kayıtlarda çalışır: uçlar bu süzgeçleri henüz almıyor. "Daha fazla" ile aralık genişler.
  // Gün süzgeci ve gün grubu firma saat diliminde (Y132): sunucunun gün sınırıyla aynı; atanmamışsa tarayıcı saati.
  const timeZone = shellTimeZone();
  const matching = useMemo(() => {
    const needle = text.trim().toLocaleLowerCase('tr');
    return items.filter((i) => {
      const day = isoDay(new Date(i.at), timeZone);
      if (fromDay && day < fromDay) return false;
      if (toDay && day > toDay) return false;
      if (person && (i.actor ?? t('activity.system')) !== person) return false;
      if (action && i.action !== action) return false;
      if (needle && ![i.actor, i.action, i.target].some((x) => x?.toLocaleLowerCase('tr').includes(needle))) return false;
      return true;
    });
  }, [items, text, person, action, fromDay, toDay, t, timeZone]);

  const groups = useMemo(() => {
    const out: { day: string; items: Item[] }[] = [];
    for (const it of matching) {
      const day = isoDay(new Date(it.at), timeZone);
      const last = out.at(-1);
      if (last?.day === day) last.items.push(it);
      else out.push({ day, items: [it] });
    }
    return out;
  }, [matching, timeZone]);

  const loading = visible.some((f) => f.q.isPending);
  const more = visible.some((f) => f.q.hasNextPage);
  const fetchingMore = visible.some((f) => f.q.isFetchingNextPage);
  const errors = visible.filter((f) => f.q.isError);

  const filterFields = (
    <div className="hub-filter-fields">
      <Field label={t('activity.person')} htmlFor="act-person">
        <select id="act-person" className="sel sm" value={person} onChange={(e) => setParam('person', e.target.value)}>
          <option value="">{t('filter.all')}</option>
          {people.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('activity.action')} htmlFor="act-action">
        <select id="act-action" className="sel sm" value={action} onChange={(e) => setParam('action', e.target.value)}>
          <option value="">{t('filter.all')}</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('activity.from')} htmlFor="act-from">
        <input id="act-from" type="date" className="inp sm" value={fromDay} max={toDay || undefined} onChange={(e) => setParam('from', e.target.value)} />
      </Field>
      <Field label={t('activity.to')} htmlFor="act-to">
        <input id="act-to" type="date" className="inp sm" value={toDay} min={fromDay || undefined} onChange={(e) => setParam('to', e.target.value)} />
      </Field>
      {narrowed && (
        <button
          type="button"
          className="btn btn-ghost plain btn-sm hub-clear"
          onClick={() => {
            setText('');
            setParams(
              (prev) => {
                const next = new URLSearchParams(prev);
                for (const k of ['q', 'person', 'action', 'from', 'to']) next.delete(k);
                return next;
              },
              { replace: true },
            );
          }}
        >
          <Icon name="close" /> {t('filter.clear')}
        </button>
      )}
    </div>
  );

  return (
    <>
      <PageHeader title={t('nav.activity')} />
      <div className="hub-page hub-wrap is-short">
        {errors.map((f) => (
          <ErrorState key={f.source} error={f.q.error} onRetry={() => f.q.refetch()} title={t('activity.sourceError', { name: f.name })} />
        ))}
        {/* EK-D09 `.bar`: kaynak sekmeleri solda, arama ve filtre sağda. */}
        <div className="hub-bar hub-activity-bar">
          {feeds.length > 1 ? (
            <div className="hub-tabs" role="group" aria-label={t('activity.source')}>
              <button type="button" aria-pressed={filter === 'all'} onClick={() => setParam('source', '')}>
                {t('activity.all')}
              </button>
              {feeds.map((f) => (
                <button key={f.source} type="button" aria-pressed={filter === f.source} onClick={() => setParam('source', f.source)}>
                  {f.name}
                </button>
              ))}
            </div>
          ) : (
            <span />
          )}
          <div className="hub-bar-end">
            <label className="hub-search-box">
              <Icon name="search" />
              <span className="sr-only">{t('activity.search')}</span>
              <input id="act-q" type="search" placeholder={t('activity.search')} value={text} onChange={(e) => setText(e.target.value)} />
            </label>
            {filterPanel.button}
          </div>
        </div>
        {filterPanel.render(filterFields)}
        {narrowed && more && <p className="hub-dataset-note">{t('activity.filterLoadedOnly')}</p>}
        <section className="hub-sheet hub-feed" aria-busy={loading}>
          {loading && items.length === 0 && (
            <div className="hub-skel-stack pad">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skel key={i} h={18} />
              ))}
            </div>
          )}
          {!loading && items.length === 0 && !errors.length && (
            <Empty compact icon="pulse" title={t('activity.emptyTitle')}>
              {t('activity.emptyBody')}
            </Empty>
          )}
          {!loading && items.length > 0 && matching.length === 0 && (
            <Empty compact icon="search" title={t('activity.noMatchTitle')}>
              {t('activity.noMatchBody')}
            </Empty>
          )}
          {groups.map((g) => (
            <div key={g.day} className="hub-feed-day">
              <h2>{formatDate(g.day, lng, { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' })}</h2>
              <ul>
                {g.items.map((it) => (
                  <li key={`${it.source}-${it.id}`} className="hub-feed-row">
                    <time dateTime={it.at}>{formatDate(it.at, lng, { hour: '2-digit', minute: '2-digit' })}</time>
                    <span className="hub-feed-src" title={it.source === 'platform' ? t('activity.platform') : PRODUCTS[it.source].name}>
                      {it.source === 'platform' ? <Icon name="building" size={16} /> : <ProductMark product={it.source} size={16} />}
                      <span className="sr-only">{it.source === 'platform' ? t('activity.platform') : PRODUCTS[it.source].name}</span>
                    </span>
                    <span className="hub-feed-text">
                      <b>{it.actor ?? t('activity.system')}</b> {it.action}
                      {it.target && <> · {it.href ? <SmartLink href={it.href}>{it.target}</SmartLink> : <span className="hub-feed-target">{it.target}</span>}</>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {more && (
            <div className="hub-feed-more">
              <Button kind="secondary" small loading={fetchingMore} onClick={() => visible.forEach((f) => f.q.hasNextPage && f.q.fetchNextPage())}>
                {t('activity.more')}
              </Button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
