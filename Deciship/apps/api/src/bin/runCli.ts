import { disconnectPrisma } from '../db.ts';

/**
 * Komut girişlerinin (src/bin/*.ts) ortak kabuğu: işi çalıştırır, bağlantıyı kapatır, çıkış koduyla biter.
 *
 * Kural: tsup girişi src/bin altında ince bir dosyadır, hiçbir modül onu içe aktarmaz ve "ana dosya mı" denetimi yapmaz.
 * Bölmede (splitting) başka girişin de içe aktardığı modülün gövdesi ortak parçaya taşınır: `import.meta` parçayı gösterir,
 * denetim hep yanlış döner ve komut hiçbir şey yapmadan 0 ile biter. Denetim: test/cli-entries.test.mjs.
 */
export function runCli(main: (argv: string[]) => Promise<number>): void {
  main(process.argv.slice(2))
    .then(async (code) => {
      await disconnectPrisma();
      process.exit(code);
    })
    .catch(async (err) => {
      console.error(err);
      await disconnectPrisma();
      process.exit(1);
    });
}
