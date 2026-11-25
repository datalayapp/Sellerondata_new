import { AI_PROVIDERS, type AiAdminKey, type AiProvider } from '@sellerondata/contracts';
import { SealError } from '../keystore/seal.ts';
import { KeyFormatError, staleWarning, type KeyActor, type KeyStore } from '../keystore/store.ts';

/**
 * Acil durum komutu (Merkez açılamıyorsa): `docker compose exec ai-api node dist/ai-key.js <komut>`.
 *   set <anthropic|gemini> --operator <ad> [--no-test]   anahtar STANDART GİRDİDEN okunur (argüman olarak verilmez: kabuk
 *                                                         geçmişine ve süreç listesine düşmesin); önce sınanır
 *   remove <sağlayıcı> --operator <ad>
 *   test <sağlayıcı> --operator <ad>                      ücretsiz sınama
 *   status                                                her sağlayıcının durumu (anahtar yok; son 4 hane) ve güncel ana
 *                                                         anahtarla mühürlenmemiş satırlar
 *   rotate-master --operator <ad>                         eski ana anahtarla mühürlü satırları AI_KEY_MASTER ile yeniden mühürler;
 *                                                         sonra hâlâ eski mühürlü satır kalırsa uyarır ve 1 döner
 * Çıktıda anahtar hiçbir zaman yoktur. Her değişiklik yönetici kaydına `cli:<ad>` ile yazılır.
 */

export type CliIo = {
  readSecret: () => Promise<string>;
  out: (line: string) => void;
  err: (line: string) => void;
};

const USAGE = [
  'Kullanım:',
  '  ai-key set <anthropic|gemini> --operator <ad> [--no-test]   (anahtar standart girdiden)',
  '  ai-key remove <anthropic|gemini> --operator <ad>',
  '  ai-key test <anthropic|gemini> --operator <ad>',
  '  ai-key status',
  '  ai-key rotate-master --operator <ad>',
].join('\n');

const OPERATOR_RE = /^[\p{L}\p{N} ._@-]{1,60}$/u;

function describe(k: AiAdminKey): string {
  if (k.state === 'missing') return `${k.provider}: yok`;
  const test = k.lastTest ? `, son sınama ${k.lastTest.at} ${k.lastTest.ok ? 'geçti' : `geçmedi${k.lastTest.httpStatus ? ` (HTTP ${k.lastTest.httpStatus})` : ''}`}` : ', sınanmadı';
  return `${k.provider}: ${k.state === 'ok' ? 'var' : 'sağlayıcı reddediyor'} (…${k.last4}), giren ${k.setBy}, ${k.setAt}${test}`;
}

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let operator: string | null = null;
  let noTest = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--operator') operator = argv[++i] ?? '';
    else if (a.startsWith('--operator=')) operator = a.slice('--operator='.length);
    else if (a === '--no-test') noTest = true;
    else if (a.startsWith('--')) return { error: `bilinmeyen seçenek: ${a.slice(0, 40)}` } as const;
    else positional.push(a);
  }
  return { positional, operator, noTest } as const;
}

export async function runAiKeyCli(argv: string[], keys: KeyStore, io: CliIo): Promise<number> {
  const args = parseArgs(argv);
  if ('error' in args) {
    io.err(`${args.error}\n${USAGE}`);
    return 2;
  }
  const [command, providerArg] = args.positional;
  if (args.positional.length > 2) {
    // Değer yansıtılmaz: anahtar yanlışlıkla argüman olarak verilmiş olabilir.
    io.err(`Fazla argüman. Anahtarı argüman olarak vermeyin (kabuk geçmişine düşer); standart girdiden okunur.\n${USAGE}`);
    return 2;
  }
  if (command === 'status') {
    for (const k of await keys.list()) io.out(describe(k));
    const seal = await keys.sealStatus();
    if (seal.stale.length > 0) io.out(staleWarning(seal));
    else if (seal.previousKeys > 0) io.out('Tüm anahtarlar güncel ana anahtarla mühürlü: AI_KEY_MASTER_PREVIOUS ortamdan çıkarılabilir.');
    return 0;
  }
  const needsProvider = command === 'set' || command === 'remove' || command === 'test';
  if (!command || (!needsProvider && command !== 'rotate-master')) {
    io.err(USAGE);
    return 2;
  }
  if (args.operator === null || !OPERATOR_RE.test(args.operator.trim())) {
    io.err(`--operator <ad> zorunlu (yönetici kaydına yazılır).\n${USAGE}`);
    return 2;
  }
  const name = args.operator.trim();
  const actor: KeyActor = { id: `cli:${name}`, name };
  let provider: AiProvider | null = null;
  if (needsProvider) {
    if (!providerArg || !(AI_PROVIDERS as readonly string[]).includes(providerArg)) {
      io.err(`sağlayıcı ${AI_PROVIDERS.join(' ya da ')} olmalı.\n${USAGE}`);
      return 2;
    }
    provider = providerArg as AiProvider;
  }

  try {
    if (command === 'set') {
      const secret = await io.readSecret();
      let result;
      try {
        result = await keys.set(provider!, secret, actor, { skipTest: args.noTest });
      } catch (e) {
        if (e instanceof KeyFormatError) {
          io.err('Anahtar biçimi geçersiz (20..512 görünür karakter, boşluksuz). Kaydedilmedi.');
          return 1;
        }
        throw e;
      }
      if (!result.ok) {
        io.err(
          result.reason === 'rejected'
            ? `Sağlayıcı anahtarı kabul etmedi${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}. Kaydedilmedi.`
            : `Sağlayıcıya ulaşılamadı${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ''}. Kaydedilmedi; ulaşılamıyorsa --no-test ile yeniden deneyin.`,
        );
        return 1;
      }
      io.out(`Kaydedildi. ${describe(result.key)}`);
      return 0;
    }
    if (command === 'remove') {
      io.out(`Kaldırıldı. ${describe(await keys.remove(provider!, actor))}`);
      return 0;
    }
    if (command === 'test') {
      const k = await keys.test(provider!, actor);
      if (!k) {
        io.err(`${provider}: kayıtlı anahtar yok.`);
        return 1;
      }
      io.out(describe(k));
      return k.lastTest?.ok ? 0 : 1;
    }
    const r = await keys.rotateMaster(actor);
    const done = `Ana anahtar döndürüldü: ${r.resealed} / ${r.total} satır yeniden mühürlendi.`;
    // Döndürmeden sonra yeniden bakılır: eski ortamla çalışan bir süreç bu arada eski anahtarla yazmış olabilir.
    const seal = await keys.sealStatus();
    if (seal.stale.length > 0) {
      io.out(done);
      io.err(staleWarning(seal));
      return 1;
    }
    io.out(seal.previousKeys > 0 ? `${done} Artık AI_KEY_MASTER_PREVIOUS ortamdan çıkarılabilir.` : done);
    return 0;
  } catch (e) {
    if (e instanceof SealError) {
      io.err(`Mühür açılamadı (${e.reason}): AI_KEY_MASTER / AI_KEY_MASTER_PREVIOUS doğru mu? Hiçbir şey değişmedi.`);
      return 1;
    }
    // Yalnız hata türü: ileti gizli değer taşıyabilir.
    io.err(`Beklenmeyen hata (${(e as Error)?.name ?? 'Error'}). Hiçbir şey yazdırılmadı.`);
    return 1;
  }
}

/** Standart girdiden gizli değer: terminalde yankısız, borudan tamamı (ilk satır). */
export async function readSecretFromStdin(stdin: NodeJS.ReadStream, prompt: (s: string) => void): Promise<string> {
  if (stdin.isTTY) {
    prompt('Anahtar (yazdıkça görünmez), Enter ile bitirin: ');
    return new Promise((resolve, reject) => {
      let buf = '';
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      const done = (value: string | null) => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        prompt('\n');
        if (value === null) reject(new Error('iptal'));
        else resolve(value);
      };
      const onData = (chunk: string) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') return done(buf);
          if (ch === '\u0003') return done(null);
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1);
          else buf += ch;
        }
      };
      stdin.on('data', onData);
    });
  }
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}
