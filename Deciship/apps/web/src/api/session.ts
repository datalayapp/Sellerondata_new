import { createSessionClient, currentLocale } from '@sellerondata/shell';
import { bindSessionFetch } from './client';
import { goToLogin } from '../lib/sessionLost';

/**
 * Tek oturum istemcisi: HttpOnly çerez, `X-SOD-CSRF: 1`, `Accept-Language`, 401/TOKEN_STALE/TOKEN_EXPIRED için tek seferlik
 * yenileme + tekrar (ARCHITECTURE §5). Yenileme de başarısızsa kalınan yeri hatırlayarak Merkez girişine gider.
 */
export const sessionClient = createSessionClient({
  getLocale: currentLocale,
  onSessionLost: goToLogin,
});

bindSessionFetch((path, init) => sessionClient.raw(path, init));
