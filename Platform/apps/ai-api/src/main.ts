import { assertConfig, env } from './env.ts';
import { buildApp } from './app.ts';
import { disconnectPrisma, getPrisma } from './db.ts';
import { startupSealWarning } from './keystore/store.ts';

try {
  const { warnings } = assertConfig();
  const app = await buildApp({ logger: true });
  for (const w of warnings) app.log.warn(w);
  // Ana anahtar döndürmesi yarım kaldıysa (eski anahtarla mühürlü satır) eski anahtar çıkarılmasın diye her açılışta söylenir.
  const seal = await startupSealWarning(getPrisma(), env.keyRing, (errName) => app.log.warn({ errName }, 'ai-api: mühür durumu okunamadı'));
  if (seal) app.log.warn(seal);

  const shutdown = async () => {
    await app.close();
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.port, host: env.host });
} catch (err) {
  // assertConfig metinleri gizli değer içermez; başka hatada yalnız tür.
  console.error(err instanceof Error && err.message.startsWith('ai-api açılamadı') ? err.message : `ai-api açılamadı (${(err as Error)?.name ?? 'Error'})`);
  process.exit(1);
}
