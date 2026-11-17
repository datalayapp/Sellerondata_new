import net from 'node:net';
import { afterAll } from 'vitest';

/**
 * 15-B5: veritabanısız testlerin bekçisi (`vitest.unit.config.ts` `setupFiles`). Dosya Postgres'e bağlanmaya kalkarsa
 * (doğrudan pg, Prisma, `getApp` ya da bir yardımcı üzerinden) bağlantı ağa çıkmadan düşer ve dosyanın sonunda test
 * kırılır; hata bir yerde yutulsa bile. Böyle bir dosya `test/unitFiles.ts` listesinden çıkar, veritabanı işinde koşar.
 */
const dbPort = (() => {
  try {
    return Number(new URL(process.env.DATABASE_URL ?? '').port) || 5432;
  } catch {
    return 5432;
  }
})();
// 5434: Docker Postgres, 5435: Docker'sız yerel Postgres (aynı roller)
const BLOCKED = new Set([dbPort, 5432, 5434, 5435]);
const hits: string[] = [];

type ConnectArgs = Parameters<net.Socket['connect']>;
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(this: net.Socket, ...args: unknown[]) {
  // net.connect normalleştirilmiş [seçenekler, geri çağırma] dizisiyle çağırır; pg doğrudan (port, host)
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const port = Number(first && typeof first === 'object' ? (first as net.TcpNetConnectOpts).port : first);
  if (BLOCKED.has(port)) {
    hits.push(String(port));
    // i18n-ok: test bekçisinin iç hatası
    const err = Object.assign(new Error(`Veritabanısız testte Postgres bağlantısı (port ${port})`), { code: 'ECONNREFUSED' });
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return realConnect.apply(this, args as ConnectArgs);
} as typeof realConnect;

afterAll(() => {
  if (hits.length) {
    // i18n-ok: test bekçisinin iç hatası
    throw new Error(`Veritabanısız test dosyası Postgres'e bağlanmaya çalıştı (${hits.length} kez). Dosyayı test/unitFiles.ts listesinden çıkarın.`);
  }
});
