// Komut girişi (imajda `node dist/ai-key.js …`). İnce dosya: hiçbir modül bunu içe aktarmaz. Ayrıntı: src/cli/aiKey.ts.
import { assertConfig, env } from './env.ts';
import { disconnectPrisma, getPrisma } from './db.ts';
import { readSecretFromStdin, runAiKeyCli } from './cli/aiKey.ts';
import { createProviderProbe } from './keystore/probe.ts';
import { KeyStore } from './keystore/store.ts';

let code = 1;
try {
  assertConfig();
  const keys = new KeyStore({ prisma: getPrisma(), ring: () => env.keyRing, probe: createProviderProbe({ baseUrls: () => env.providerBaseUrls }) });
  code = await runAiKeyCli(process.argv.slice(2), keys, {
    readSecret: () => readSecretFromStdin(process.stdin, (s) => process.stderr.write(s)),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
} catch (e) {
  // assertConfig metinleri gizli değer içermez; başka hatada yalnız tür.
  process.stderr.write(`${e instanceof Error && e.message.startsWith('ai-api açılamadı') ? e.message : `ai-key hatası (${(e as Error)?.name ?? 'Error'})`}\n`);
} finally {
  await disconnectPrisma();
}
process.exit(code);
