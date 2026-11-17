import { describe, expect, it, vi } from 'vitest';
import { openTestDb } from './helpers';

const open = vi.fn();
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: (...a: unknown[]) => open(...a) }));

import { getDb, kvGet, kvSet } from '../src/queue/db';

describe('11-B11: yerel veritabanı bir kez açılamazsa sonraki çağrıda yeniden denenir', () => {
  it('ilk açılış hata verir (ör. depolama dolu), ikinci çağrı açar; kayıt yazılıp okunur', async () => {
    open.mockRejectedValueOnce(new Error('disk I/O error'));
    open.mockResolvedValue(openTestDb());
    await expect(getDb()).rejects.toThrow('disk I/O error');
    await expect(kvSet('k', { a: 1 })).resolves.toBeUndefined();
    await expect(kvGet('k')).resolves.toEqual({ a: 1 });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('açıldıktan sonra yeniden açılmaz (tek bağlantı)', async () => {
    const before = open.mock.calls.length;
    await getDb();
    await getDb();
    expect(open.mock.calls.length).toBe(before);
  });
});
