import { ApiError } from './client';
import { i18n } from '../i18n';

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'measure', ...opts });

export type FriendlyError = { title: string; text: string; code: string };

/** API hatasını çalışanın anlayacağı, ne yapılacağını söyleyen (etkin dilde) metne çevirir. */
export function friendlyError(e: unknown, action: 'save' | 'delete' | 'restore' | 'load' = 'save'): FriendlyError {
  const title = t(`errors.title.${action}`);
  if (!(e instanceof ApiError)) {
    return { title, text: t('errors.unknown'), code: 'UNKNOWN' };
  }
  switch (e.code) {
    case 'NETWORK':
      return { title: t('errors.network.title'), text: t('errors.network.text'), code: e.code };
    case 'TIMEOUT':
      return { title: t('errors.timeout.title'), text: t('errors.timeout.text'), code: e.code };
    case 'PHOTO_REQUIRED':
      return { title: t('errors.photoRequired.title'), text: e.message || t('errors.photoRequired.text'), code: e.code };
    case 'NEWER_EXISTS':
      return {
        title: t('errors.title.restore'),
        text: e.message || t('errors.newerExists'),
        code: e.code,
      };
    case 'NOT_LATEST_VERSION':
      return { title, text: e.message || t('errors.notLatest'), code: e.code };
    case 'NOT_FOUND':
      return { title, text: e.message || t('errors.notFound'), code: e.code };
    case 'FORBIDDEN':
      return { title, text: e.message || t('errors.forbidden'), code: e.code };
    case 'VALIDATION':
      return { title, text: e.message || t('errors.validation'), code: e.code };
    case 'FILE_TOO_LARGE':
      return { title, text: e.message || t('errors.fileTooLarge'), code: e.code };
    case 'MEASURED_AT_INVALID':
      return { title, text: e.message || t('errors.measuredAtInvalid'), code: e.code };
    default:
      if (e.status >= 500) return { title, text: t('errors.server'), code: e.code };
      return { title, text: e.message || t('errors.http', { status: e.status }), code: e.code };
  }
}
