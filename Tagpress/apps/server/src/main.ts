import { productionPorts } from "./adapters/index.ts";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { missingPorts } from "./ports.ts";
import { SecretKeyError } from "./services/secret-box.ts";

// `--yerel`: `pnpm dev` ve `pnpm start` yerel kipi kendisi verir (varsayılan kip platform; plan §2.6). Ortamda açıkça
// verilmiş `TAGPRESS_AUTH` korunur.
if (process.argv.includes("--yerel")) process.env.TAGPRESS_AUTH ??= "local";
const config = loadConfig();
// Gerçek paket bağlantıları: adapters/index.ts.
let built: Awaited<ReturnType<typeof buildApp>>;
try {
  built = await buildApp({ logger: true, ports: productionPorts(), seedDefaults: true });
} catch (err) {
  // Ana anahtar sorunu: düz metne düşülmez, uygulama açılmaz (mesajda anahtar yok).
  if (err instanceof SecretKeyError) {
    console.error(`API anahtarlarının ana anahtarı okunamadı: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
const { app, ctx } = built;

try {
  // Yerel kip yalnızca yerel arayüzde (dışarıdan erişilemez); platform kipi konteynerde, gateway arkasında.
  await app.listen({ port: config.port, host: config.auth === "platform" ? "0.0.0.0" : "127.0.0.1" });
} catch (err) {
  const busy = (err as NodeJS.ErrnoException)?.code === "EADDRINUSE";
  console.error(busy ? `Port ${config.port} kullanımda (uygulamanın başka bir kopyası açık olabilir: pnpm durum).` : err);
  await ctx.close();
  process.exit(1);
}

console.log(`TagPress (${config.auth === "platform" ? "platform kipi" : "yerel kip"}): port ${config.port}  ·  veri: ${config.dataDir}`);
const keys = ctx.secretsReport;
for (const n of keys.notes) console.log(`API anahtarları: ${n}`);
if (keys.created) console.log(`API anahtarları için yeni ana anahtar oluşturuldu: ${keys.source} (yedekleyin; kaybolursa anahtarlar yeniden girilir).`);
if (keys.migrated.length) console.log(`API anahtarları yeni şifreli biçime taşındı: ${keys.migrated.join(", ")}`);
if (keys.rotated.length) console.log(`API anahtarları geçerli ana anahtarla yeniden şifrelendi: ${keys.rotated.join(", ")}`);
for (const f of keys.failed) console.error(`API anahtarı çözülemedi (${f.provider}): ${f.reason} Eski kayıt yerinde bırakıldı. Ana anahtar kaynağı: ${keys.source}`);
for (const l of ctx.bootstrap?.imported ?? []) {
  console.log(`İçe alındı: ${l.languageId} (şablon ${l.templates}, referans ${l.references})`);
  for (const w of l.warnings) console.log(`  ! ${w}`);
}
for (const e of ctx.bootstrap?.errors ?? []) console.error(`Aktarım paketi okunamadı: ${e}`);
const missing = missingPorts(ctx.ports);
if (missing.length) console.log(`Bağlı olmayan yetenekler: ${missing.join(", ")}`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
