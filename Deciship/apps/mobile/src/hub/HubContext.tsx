import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Linking } from 'react-native';
import { router, type Href } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { currentSessionScope, getServerUrl } from '../api/client';
import { getFormatTimeZone } from '../lib/format';
import { useToast } from '../ui/Toast';
import { APP_ENV } from '../version/client';
import { analyticsTools, canOpenMeasurements, hubScope, isOrgAdmin, overviewTools } from './access';
import { cacheOwnedBy } from './cache';
import { fetchMe } from './api';
import type { MeResponse, ProductKey } from './contracts';
import { isoDay, rangeDates, type FormatCtx, type RangeKey } from './format';
import { toHubError } from './http';
import { resolveHubLink, webOriginFor, type HubLink } from './links';
import { hubCache } from './store';
import type { ToolChoice } from './views';

/**
 * Web Merkez'in kökü (G6): elle verilen `EXPO_PUBLIC_WEB_ORIGIN`, geliştirme derlemesinde sunucu adresi, yoksa app.sellerondata.com.
 * Sunucu adresi geliştirmede değişebilir: her bağlantıda yeniden okunur.
 */
export const currentWebOrigin = () => webOriginFor({ envOrigin: process.env.EXPO_PUBLIC_WEB_ORIGIN, development: APP_ENV === 'development', serverUrl: getServerUrl() });

type Boot = 'loading' | 'ready' | 'failed' | 'denied';

type HubContextValue = {
  boot: Boot;
  me: MeResponse | null;
  scope: string;
  lng: string;
  fmt: FormatCtx;
  /** Genel Bakış'ta bölümü olan araçlar. */
  tools: ProductKey[];
  /** Rapor izni olan araçlar (web `overviewProducts`): Etkinlik akışları ve "Web'de aç" analiz kartı. */
  reportTools: ProductKey[];
  /** Firma sahibi veya yöneticisi: Ekip, çalışan ekleme ve hesap etkinliği. */
  canTeam: boolean;
  /** Araç seçimi (yalnız Genel Bakış): `null` = seçilmedi, ilk açık araç gösterilir (`overviewTool`). */
  tool: ToolChoice;
  setTool: (key: ToolChoice) => void;
  range: RangeKey;
  setRange: (key: RangeKey) => void;
  from: string;
  to: string;
  refreshMe: () => Promise<void>;
  linkOf: (href: string | null | undefined) => HubLink;
  open: (href: string | null | undefined) => void;
  /** Web Merkez'de tam adres (`/join` gibi). */
  webUrl: (path: string) => string;
  /** Uygulamada karşılığı olsa da web'i açar: rol değiştirme gibi işler yalnız orada. */
  openWeb: (path: string) => void;
};

const Ctx = createContext<HubContextValue | null>(null);

export function useHub(): HubContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useHub: HubProvider yok');
  return v;
}

export function HubProvider({ children }: { children: ReactNode }) {
  const { t, i18n } = useTranslation('hub');
  const toast = useToast();
  const lng = i18n.language === 'en' ? 'en' : 'tr';
  const [boot, setBoot] = useState<Boot>('loading');
  const [me, setMe] = useState<MeResponse | null>(null);
  const [picked, setPicked] = useState<ToolChoice>(null);
  const [range, setRange] = useState<RangeKey>('30d');

  const refreshMe = useCallback(async () => {
    const since = hubCache.generation();
    try {
      const fresh = await fetchMe();
      // Yanıt gelene kadar oturum değiştiyse eski kişi önbelleğe geri yazılmaz.
      if (hubCache.generation() !== since) return;
      hubCache.bind(hubScope(fresh), fresh);
      setMe(fresh);
      setBoot('ready');
    } catch (e) {
      if (hubCache.generation() !== since) return;
      const err = toHubError(e);
      if (err.status === 401 || err.kind === 'forbidden') {
        await hubCache.clear();
        setMe(null);
        setBoot('denied');
        return;
      }
      // Ağ yok: son bilinen kişiyle son veri gösterilir. Hiç kayıt yoksa açılamaz.
      // Kayıt elimizdeki jetonun sahibine ait değilse gösterilmez, silinir.
      const cached = hubCache.lastMe();
      const last = cacheOwnedBy(cached, currentSessionScope()) ? cached : null;
      if (cached && !last) await hubCache.clear();
      if (last) setMe((cur) => cur ?? last);
      setBoot(last ? 'ready' : 'failed');
    }
  }, []);

  // Önbellek sunucu cevabından önce gösterilmez: kişi değiştiyse başkasının verisi bir an bile görünmesin.
  useEffect(() => {
    void hubCache.load().then(refreshMe);
  }, [refreshMe]);

  // Firma saat dilimi (Y132; oturum `setFormatTimeZone` ile verir), yoksa telefonun saati: web Merkez ile aynı dönem.
  const timeZone = getFormatTimeZone();
  const today = isoDay(new Date(), timeZone);
  const period = useMemo(() => rangeDates(range, new Date(), timeZone),
    // Gün dönünce dönem de kayar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [range, today, timeZone]);

  const value = useMemo<HubContextValue>(() => {
    const tools = me ? overviewTools(me) : [];
    const reportTools = me ? analyticsTools(me) : [];
    const canTeam = me ? isOrgAdmin(me) : false;
    const access = { team: canTeam, measurements: me ? canOpenMeasurements(me) : false };
    const linkOf = (href: string | null | undefined) => resolveHubLink(href, access, currentWebOrigin());
    const openUrl = (url: string) => {
      Linking.openURL(url).catch(() => toast.show({ text: t('error.openLink'), kind: 'error' }));
    };
    return {
      boot,
      me,
      scope: me ? hubScope(me) : '',
      lng,
      fmt: { lng, timeZone, units: { days: t('unit.days'), points: t('unit.points'), thousand: t('unit.thousand'), million: t('unit.million') } },
      tools,
      reportTools,
      canTeam,
      tool: picked,
      setTool: setPicked,
      range,
      setRange,
      from: period.from,
      to: period.to,
      refreshMe,
      linkOf,
      open: (href) => {
        const link = linkOf(href);
        if (link.kind === 'app') {
          if (link.path.startsWith('/hub')) router.replace(link.path as Href);
          else router.push(link.path as Href);
        } else if (link.kind === 'web') {
          openUrl(link.url);
        }
      },
      webUrl: (path) => `${currentWebOrigin()}${path}`,
      openWeb: (path) => openUrl(`${currentWebOrigin()}${path}`),
    };
  }, [boot, me, lng, timeZone, t, picked, range, period, refreshMe, toast]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
