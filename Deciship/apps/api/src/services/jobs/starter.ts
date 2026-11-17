/**
 * KALANLAR 6.18 (inceleme): iş kuyrukta beklerken başlatan üye çıkarılmış ya da yetkisi alınmış olabilir. İçe aktarma,
 * tarife incelemesi ve toplu yeniden hesap (önizleme, uygulama; izin kapsamdan) işi başlarken başlatanın yerel üye kaydına
 * bakar (`Member.active`, geçerli izinler; istekteki jetonla aynı kural, `lib/access.ts` `memberPermissions`). Uymuyorsa iş
 * 403 `JOB_STARTER_FORBIDDEN` ile düşer (ileti `job.starterForbidden`: işi bugünkü yetkisiyle biri yeniden başlatmalı; isteği
 * yapanın yetkisizliği `FORBIDDEN`'dan ayrı), hiçbir şey yazılmaz.
 *
 * Aboneliğin salt okunur olması yerelde tutulmaz (jetonla gelir, auth-kit denetler): başlatma ucu denetler, kuyrukta
 * beklerken değişirse burada görülmez.
 */
import type { Permission } from '@sellerondata/contracts';
import { AppError } from '../../errors.ts';
import { m } from '../../i18n/index.ts';
import { loadMemberAccess, memberPermissions } from '../../lib/access.ts';
import type { ClaimedJob } from './types.ts';

export async function assertStarterMayRun(job: Pick<ClaimedJob, 'companyId' | 'createdById'>, permission: Permission): Promise<void> {
  const [member] = job.createdById ? await loadMemberAccess(job.companyId, [job.createdById]) : [];
  if (!member || !member.active || !memberPermissions(member).includes(permission)) {
    throw new AppError(403, 'JOB_STARTER_FORBIDDEN', m('job.starterForbidden'));
  }
}
