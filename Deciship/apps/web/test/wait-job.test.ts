// KALANLAR 6.18: başlatılmış işi bekleme (fatura içe aktarma, tarife incelemesi): sonuç, iş hatası ve durdurma.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../src/api/client.ts';
import type { JobView } from '../src/api/types.ts';
import { JobLeft, JobStopped, waitJob } from '../src/lib/waitJob.ts';

const view = (over: Partial<JobView> = {}): JobView => ({
  id: 'j1',
  kind: 'INVOICE_IMPORT',
  status: 'QUEUED',
  progress: { done: 0, total: null, stage: null },
  label: 'buyuk.csv',
  ref: { type: 'File', id: 'f1' },
  attempt: 1,
  cancellable: true,
  cancelRequested: false,
  createdAt: '2026-11-16T00:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  elapsedMs: 0,
  ...over,
});

const seq = (...items: JobView[]) => {
  const calls: string[] = [];
  return {
    calls,
    get: async (id: string) => {
      calls.push(id);
      return items.shift() ?? items[items.length - 1]!;
    },
  };
};
const noWait = async () => undefined;

describe('waitJob', () => {
  it('iş bitene dek yoklar, her hâli bildirir; başarıda sonucu döner', async () => {
    const s = seq(
      view({ status: 'RUNNING', progress: { done: 0, total: null, stage: 'importCompare' } }),
      view({ status: 'SUCCEEDED', result: { invoice: { id: 'i1' } } }),
    );
    const seen: string[] = [];
    const r = await waitJob(view(), { get: s.get, wait: noWait, hidden: () => false, onUpdate: (j) => seen.push(j.status) });
    assert.deepEqual(r, { invoice: { id: 'i1' } });
    assert.deepEqual(seen, ['QUEUED', 'RUNNING', 'SUCCEEDED']);
    assert.deepEqual(s.calls, ['j1', 'j1']);
  });

  it('bitmiş işte yoklamaz', async () => {
    const s = seq();
    assert.equal(await waitJob(view({ status: 'SUCCEEDED', result: 7 }), { get: s.get, wait: noWait }), 7);
    assert.equal(s.calls.length, 0);
  });

  it('iş hatası eşzamanlı yanıtın hatası gibi ApiError olur (kod, durum, ayrıntı)', async () => {
    const s = seq(view({ status: 'FAILED', error: { statusCode: 409, code: 'MAPPING_UNVERIFIED', message: 'Kontrol edin', details: { issues: [] } } }));
    await assert.rejects(waitJob(view(), { get: s.get, wait: noWait, hidden: () => false }), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'MAPPING_UNVERIFIED');
      assert.deepEqual(e.details, { issues: [] });
      return true;
    });
  });

  it('geçici yoklama hatası (5xx, ağ) beklemeyi bitirmez: geri çekilerek yeniden dener; 404 hemen atılır; deneme tükenince son hata', async () => {
    const waits: number[] = [];
    const wait = async (ms: number) => {
      waits.push(ms);
    };
    const errs: unknown[] = [new ApiError(503, 'UNAVAILABLE', ''), new TypeError('Failed to fetch')];
    const flaky = async () => {
      const e = errs.shift();
      if (e) throw e;
      return view({ status: 'SUCCEEDED', result: 'ok' });
    };
    assert.equal(await waitJob(view(), { get: flaky, wait, hidden: () => false }), 'ok');
    assert.deepEqual(waits.slice(1), [1_000, 2_000]);

    let n = 0;
    const gone = async () => {
      n++;
      throw new ApiError(404, 'NOT_FOUND', '');
    };
    await assert.rejects(waitJob(view(), { get: gone, wait: noWait, hidden: () => false }), (e: unknown) => e instanceof ApiError && e.status === 404);
    assert.equal(n, 1);

    let m = 0;
    const down = async () => {
      m++;
      throw new ApiError(502, 'BAD_GATEWAY', '');
    };
    await assert.rejects(waitJob(view(), { get: down, wait: noWait, hidden: () => false }), (e: unknown) => e instanceof ApiError && e.status === 502);
    assert.equal(m, 6);
  });

  it('durdurulan iş JobStopped, bırakılan bekleme JobLeft', async () => {
    await assert.rejects(waitJob(view(), { get: seq(view({ status: 'CANCELLED' })).get, wait: noWait, hidden: () => false }), JobStopped);
    let alive = true;
    const s = seq(view({ status: 'RUNNING' }));
    await assert.rejects(
      waitJob(view(), {
        get: async (id) => {
          alive = false;
          return s.get(id);
        },
        alive: () => alive,
        wait: noWait,
        hidden: () => false,
      }),
      JobLeft,
    );
  });
});
