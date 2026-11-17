import type { ImportHeadline, ImportIssue } from '../api/types';
import { i18n } from '../i18n';
import { fmtNum } from './format';

/**
 * Tarife içe aktarma özeti: hata → "Bu haliyle yüklenemez", uyarı → "N konuya bakın", temiz → "Dosya uygun".
 * Sunucu `headline` gönderir; bu yalnızca eski sunucu (headline yok) ve sahte API için.
 */
export function headlineOf(
  checks: ImportIssue[],
  { canApply = true, fixable = false, okLines }: { canApply?: boolean; fixable?: boolean; okLines: string[] },
): ImportHeadline {
  const errors = checks.filter((c) => c.severity === 'error');
  const warns = checks.filter((c) => c.severity === 'warning');
  if (errors.length || !canApply)
    return {
      status: 'error',
      title: i18n.t('importHeadline.error'),
      lines: [...errors.map((c) => c.title), ...(fixable ? [i18n.t('importHeadline.fixable')] : [])].slice(0, 3),
    };
  if (warns.length) return { status: 'warning', title: i18n.t('importHeadline.warnings', { count: warns.length, n: fmtNum(warns.length) }), lines: warns.slice(0, 3).map((c) => c.title) };
  return { status: 'ok', title: i18n.t('importHeadline.ok'), lines: okLines.slice(0, 3) };
}
