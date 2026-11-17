import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { jobs } from '../api/endpoints';
import type { JobView } from '../api/types';
import { isJobFinished, jobPollMs } from './jobs';

export interface UseJobOptions {
  /** 202 yanıtındaki iş: ilk çizim beklemeden görünür. */
  initial?: JobView | null;
  /** İş bitince (başarı, hata ya da durdurma) bir kez çağrılır. */
  onFinish?: (job: JobView) => void;
}

/**
 * İş bitene dek `GET /jobs/:id` yoklar. Sayfa gizliyken seyrek yoklar, bileşen kalkınca durur (sorgunun izleyicisi kalmaz).
 * `jobId` boşsa hiçbir şey yapmaz. İş bulunamazsa (404) yoklama durur ve `error` dolar.
 */
export function useJob(jobId: string | null | undefined, { initial, onFinish }: UseJobOptions = {}) {
  const qc = useQueryClient();
  const sinceRef = useRef<{ id: string; at: number } | null>(null);
  useEffect(() => {
    sinceRef.current = jobId ? { id: jobId, at: Date.now() } : null;
  }, [jobId]);

  const q = useQuery({
    queryKey: ['job', jobId],
    queryFn: () => jobs.get(jobId as string),
    enabled: Boolean(jobId),
    initialData: initial && initial.id === jobId ? initial : undefined,
    staleTime: 0,
    refetchIntervalInBackground: true,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data && isJobFinished(data.status)) return false;
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false;
      const since = sinceRef.current;
      return jobPollMs(since ? Date.now() - since.at : 0, typeof document !== 'undefined' && document.hidden);
    },
    meta: { silent: true },
  });

  const finishRef = useRef(onFinish);
  useEffect(() => {
    finishRef.current = onFinish;
  });
  const firedRef = useRef<string | null>(null);
  const job = q.data;
  useEffect(() => {
    if (!job || !isJobFinished(job.status) || firedRef.current === job.id) return;
    firedRef.current = job.id;
    finishRef.current?.(job);
  }, [job]);

  const [stopPending, setStopPending] = useState(false);
  /** `POST /jobs/:id/cancel`; sonucu önbelleğe yazar. İş bu arada bittiyse (409) gerçek durum yoklamayla gelir. */
  const stop = useCallback(async () => {
    if (!jobId) return;
    setStopPending(true);
    try {
      qc.setQueryData(['job', jobId], await jobs.cancel(jobId));
    } catch {
      await qc.invalidateQueries({ queryKey: ['job', jobId] });
    } finally {
      setStopPending(false);
    }
  }, [jobId, qc]);

  return { job: job ?? null, error: q.error, receivedAt: q.dataUpdatedAt, stop, stopping: stopPending };
}
