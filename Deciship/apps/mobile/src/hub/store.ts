import { kvGet, kvSet } from '../queue/db';
import { createHubCache } from './cache';

const KEY = 'hub.cache.v1';

export const hubCache = createHubCache({ get: () => kvGet(KEY), set: (value) => kvSet(KEY, value) });

/** Kişi çıkınca veya oturum/firma değişince son veri cihazda kalmasın. */
export const clearHubCache = () => hubCache.clear();
