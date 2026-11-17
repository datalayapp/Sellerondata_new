import { assertConfig, env, localAddressWarning } from './env.ts';
import { prisma } from './db.ts';
import { assertNoDemoAccounts } from './lib/demo.ts';
import { buildApp } from './app.ts';
import { disconnectPrisma } from './db.ts';
import { startDispatcher } from './lib/dispatcher.ts';
import { configureMailer, drainMail } from './lib/mailer.ts';
import { startMaintenance } from './lib/maintenance.ts';

/** Compose `stop_grace_period: 20s`: süren davet isteğinin en çok 8 sn'si (`app.close`) ve bu bekleme sığar. */
const SHUTDOWN_MAIL_WAIT_MS = 6000;

try {
  const { warnings: launchWarnings } = assertConfig();
  await assertNoDemoAccounts(prisma);
  const app = await buildApp({ logger: true });
  for (const warning of launchWarnings) app.log.warn(warning);
  configureMailer({ log: app.log });
  const dispatcher = startDispatcher({ log: app.log });
  const stopMaintenance = startMaintenance(app.log);

  const shutdown = async () => {
    stopMaintenance();
    await dispatcher.stop();
    await app.close();
    const unsent = await drainMail(SHUTDOWN_MAIL_WAIT_MS);
    if (unsent) app.log.warn({ unsent }, 'kapanışta gönderilemeyen e-posta kaldı');
    await disconnectPrisma();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ port: env.port, host: env.host });
  const addressWarning = localAddressWarning();
  if (addressWarning) app.log.warn(addressWarning);
  if (!env.smtpUrl) app.log.warn('SMTP_URL yok: postalar gönderilmiyor, MailLog ve günlüğe yazılıyor (yalnız geliştirme)');
  // Kapalı deneme (2026-11-12): kayıt kipi açılışta görünsün; üretimde açık kayıt bilinçli bir seçim olmalı.
  if (env.signupMode === 'open' && env.isProduction) app.log.warn('SIGNUP_MODE=open: herkes davetsiz firma açabilir');
  else app.log.info({ signupMode: env.signupMode, registrationEnabled: env.registrationEnabled }, 'kayıt kipi');
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
