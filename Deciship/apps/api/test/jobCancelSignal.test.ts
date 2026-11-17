/**
 * KALANLAR 6.5: süren yapay zekâ çağrısına verilen sinyal yalnız kullanıcının durdurmasıyla (iş iptali) kesilir. Kapanış,
 * kira kaybı ve süre aşımı çağrıyı KESMEZ: iş yeniden denenir, süren çağrının sonucu önbelleğe girer ve yeniden denemede
 * ücretsiz alınır. Veritabanısız (`vitest.unit.config.ts`).
 */
import { describe, expect, it } from 'vitest';
import { JobAbort, jobCancelSignal } from '../src/services/jobs/runner.ts';

describe('jobCancelSignal', () => {
  it('iş iptali (cancel) çağrının sinyalini keser; neden aynı JobAbort', () => {
    const job = new AbortController();
    const call = jobCancelSignal(job.signal);
    expect(call.aborted).toBe(false);
    job.abort(new JobAbort('cancel'));
    expect(call.aborted).toBe(true);
    expect(call.reason).toBeInstanceOf(JobAbort);
    expect((call.reason as JobAbort).cause).toBe('cancel');
  });

  for (const cause of ['shutdown', 'lost', 'timeout'] as const) {
    it(`${cause}: çağrının sinyali kesilmez`, () => {
      const job = new AbortController();
      const call = jobCancelSignal(job.signal);
      job.abort(new JobAbort(cause));
      expect(job.signal.aborted).toBe(true);
      expect(call.aborted).toBe(false);
    });
  }

  it('nedeni JobAbort olmayan kesilme de çağrıyı kesmez', () => {
    const job = new AbortController();
    const call = jobCancelSignal(job.signal);
    job.abort(new Error('başka'));
    expect(call.aborted).toBe(false);
  });

  it('sinyal zaten kesilmişse: iptal ise kesik, değilse kesik olmayan sinyal döner', () => {
    const cancelled = new AbortController();
    cancelled.abort(new JobAbort('cancel'));
    expect(jobCancelSignal(cancelled.signal).aborted).toBe(true);
    const shutdown = new AbortController();
    shutdown.abort(new JobAbort('shutdown'));
    expect(jobCancelSignal(shutdown.signal).aborted).toBe(false);
  });
});
