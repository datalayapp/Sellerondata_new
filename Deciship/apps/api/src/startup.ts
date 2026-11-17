import { env, invalidEnv, missingProductionEnv } from './env.ts';
import { disconnectPrisma, prisma, Prisma } from './db.ts';
import { schemaProblems, SCHEMA_RESET_HINT } from './lib/schemaCheck.ts';

/**
 * Açılış denetimi: HTTP girişi (`main.ts`) ve iş çalıştırıcı girişi (`worker.ts`) aynı kuralla açılır ya da açılmaz. İkisi aynı
 * imajdan aynı ortam dosyasıyla çalışır; bu yüzden üretim zorunluları (`missingProductionEnv`) ikisinde de aynıdır.
 * Sorun varsa süreç 1 ile çıkar.
 */
export async function checkStartup(): Promise<void> {
  const missing = missingProductionEnv();
  if (missing.length) {
    console.error(`Üretimde zorunlu ayarlar eksik: ${missing.join(', ')}`);
    process.exit(1);
  }
  // Her ortamda: bozuk değer sessizce varsayılana ya da "sınırsız"a düşmesin (ör. AI_DAILY_BUDGET_TRY).
  const invalid = invalidEnv();
  if (invalid.length) {
    console.error(`Invalid settings: ${invalid.join(', ')}`);
    process.exit(1);
  }
  if (env.aiDailyBudgetTry === null) console.warn('AI_DAILY_BUDGET_TRY=off: no system-wide daily AI spending cap');

  // Eski şemayla açılmaz: kısmi dizin ve bileşik anahtarlar veri bütünlüğünün parçası.
  try {
    const problems = await schemaProblems((sql) => prisma.$queryRaw<Record<string, unknown>[]>(Prisma.raw(sql)));
    if (problems.length) {
      console.error(`${SCHEMA_RESET_HINT}\n${problems.map((p) => ` - ${p}`).join('\n')}`);
      await disconnectPrisma();
      process.exit(1);
    }
  } catch (err) {
    // Veritabanına o an ulaşılamıyor: istekler 503 döner, işler sonraki yoklamada alınır. Denetim şema sorunu demek değil.
    console.warn('Şema denetimi yapılamadı', err);
  }
}
