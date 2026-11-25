import { useCallback, useEffect, useRef, useState } from 'react';
import { nextPage, type ActivitySource, type AuditPage } from './activity';
import { fetchAudit, fetchProductActivity } from './api';
import type { HubActivityPage } from './contracts';
import { useHub } from './HubContext';
import { toHubError, type HubErrorKind } from './http';
import { useHubResource, type HubResource } from './useHubResource';

export type FeedPage = HubActivityPage | AuditPage;

export type Feed = {
  source: ActivitySource;
  /** İlk sayfa: önbellek + ağ (diğer Merkez bölümleri gibi). */
  first: HubResource<FeedPage>;
  /** Yüklenen bütün sayfalar, ilk sayfa dahil. */
  pages: FeedPage[];
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => Promise<HubErrorKind | null>;
};

const load = (source: ActivitySource, page: number): Promise<FeedPage> => (source === 'platform' ? fetchAudit(page) : fetchProductActivity(source, page));

/**
 * Bir kaynağın akışı. İlk sayfa önbellekli; "Daha fazla" sayfaları yalnız bellekte. İlk sayfa yenilenince (çekip yenileme,
 * sekmeye dönüş) ek sayfalar düşer: eski sayfa yeni ilk sayfayla karışıp aynı kaydı iki kez göstermesin.
 */
export function useFeed(source: ActivitySource, enabled: boolean): Feed {
  const { scope, lng } = useHub();
  const first = useHubResource<FeedPage>(enabled ? `${scope}:${lng}:activity:${source}` : null, () => load(source, 1));
  const [extra, setExtra] = useState<{ base: FeedPage | null; pages: FeedPage[] }>({ base: null, pages: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const base = useRef<FeedPage | null>(null);
  base.current = first.data;
  useEffect(() => {
    setLoadingMore(false);
  }, [first.data]);

  const more = extra.base !== null && extra.base === first.data ? extra.pages : [];
  const pages = first.data ? [first.data, ...more] : [];
  const next = enabled ? nextPage(pages.at(-1)) : null;

  const loadMore = useCallback(async (): Promise<HubErrorKind | null> => {
    const from = base.current;
    if (next === null || !from) return null;
    setLoadingMore(true);
    try {
      const page = await load(source, next);
      // Bu arada ilk sayfa yenilendiyse sonuç atılır.
      if (base.current !== from) return null;
      setExtra((cur) => ({ base: from, pages: [...(cur.base === from ? cur.pages : []), page] }));
      return null;
    } catch (e) {
      return toHubError(e).kind;
    } finally {
      if (base.current === from) setLoadingMore(false);
    }
  }, [next, source]);

  return { source, first, pages, hasMore: next !== null, loadingMore, loadMore };
}
