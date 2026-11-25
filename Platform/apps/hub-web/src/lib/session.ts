import { createSessionClient, currentLocale } from '@sellerondata/shell';

const PUBLIC = /^\/(login|register|join|invite|forgot-password|reset-password|verify-email)(\/|$)/;

/** Merkez'in tek oturum istemcisi. Oturum kaybolunca kaldığı yeri hatırlayarak girişe gönderir. */
export const client = createSessionClient({
  getLocale: currentLocale,
  onSessionLost: () => {
    const { pathname, search } = window.location;
    if (PUBLIC.test(pathname)) return;
    window.location.assign(`/login?next=${encodeURIComponent(pathname + search)}`);
  },
});
