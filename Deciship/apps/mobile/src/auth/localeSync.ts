import type { Locale } from '@sellerondata/contracts';

export type LocaleSyncResult =
  /** Sunucuya yazıldı. */
  | 'synced'
  /** Yerelde uygulandı, bağlantı gelince yazılacak. */
  | 'pending'
  /** Sunucu kabul etmedi, seçim düştü. */
  | 'rejected'
  /** Bekleyen seçim yok. */
  | 'none';

export type LocaleSyncDeps = {
  /** Kişinin bekleyen seçimi. Kişi başına ayrı durur, başkasına uygulanmaz. */
  read: (personId: string) => Promise<Locale | null>;
  write: (personId: string, locale: Locale | null) => Promise<void>;
  /** Kişi ayarına yazar (`PATCH /api/account/me`). Elimizdeki jetonun kişisine yazar. */
  send: (locale: Locale) => Promise<unknown>;
  /** Elimizdeki jetonun kişisi. */
  currentPerson: () => string | null;
  isPermanent: (e: unknown) => boolean;
  onSynced?: (personId: string, locale: Locale) => void | Promise<void>;
};

/** Yeniden denemenin anlamı olmayan red: bağlantı, oturum, hız ve sunucu hataları geçicidir. */
export function isPermanentLocaleError(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/**
 * Dil seçimi kişi ayarına yazılır, web kabuğuyla aynı alan. Seçim önce yerelde tutulur ve uygulanır:
 * çevrimdışı da çalışır, bağlantı gelince eşitlenir. Bekleyen seçim varken sunucudan gelen eski dil onu ezmez.
 */
export function createLocaleSync(deps: LocaleSyncDeps) {
  const running = new Map<string, Promise<LocaleSyncResult>>();

  const run = async (personId: string): Promise<LocaleSyncResult> => {
    for (;;) {
      const wanted = await deps.read(personId);
      if (!wanted) return 'none';
      // Jeton başka kişininse o kişinin ayarına yazılırdı. Bu denetim gönderimle aynı adımda.
      if (deps.currentPerson() !== personId) return 'pending';
      try {
        await deps.send(wanted);
      } catch (e) {
        if (!deps.isPermanent(e)) return 'pending';
        if ((await deps.read(personId)) === wanted) await deps.write(personId, null);
        return 'rejected';
      }
      // Gönderim sürerken başka dil seçildiyse onu da gönder.
      if ((await deps.read(personId)) !== wanted) continue;
      await deps.write(personId, null);
      await deps.onSynced?.(personId, wanted);
      return 'synced';
    }
  };

  const flush = (personId: string): Promise<LocaleSyncResult> => {
    const active = running.get(personId);
    if (active) return active;
    const started = run(personId).finally(() => running.delete(personId));
    running.set(personId, started);
    return started;
  };

  return {
    flush,
    async choose(personId: string, locale: Locale): Promise<LocaleSyncResult> {
      await deps.write(personId, locale);
      // Gönderim sürüyorsa döngü yeni seçimi görür; bitmeden başlayan ikinci gönderim olmaz.
      const active = running.get(personId);
      if (active) await active;
      return flush(personId);
    },
    /** Ekranda geçerli dil: bekleyen seçim varsa o, yoksa sunucunun söylediği. */
    async effective(personId: string, serverLocale: Locale): Promise<Locale> {
      return (await deps.read(personId)) ?? serverLocale;
    },
  };
}

export type LocaleSync = ReturnType<typeof createLocaleSync>;
