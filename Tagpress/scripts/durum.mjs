/**
 * `pnpm durum`: uygulama bu makinede açık mı? Sunucunun sağlık ucunu (`/api/health`) yoklar; hiçbir şeyi
 * başlatmaz, durdurmaz ya da değiştirmez. Port, sunucuyla aynı: PORT (varsayılan 5420).
 *
 * Çıkış kodu: 0 = uygulama açık, 1 = port boş (uygulama kapalı), 2 = portu başka bir program kullanıyor.
 */
const port = Number(process.env.PORT ?? 5420);
const base = `http://127.0.0.1:${port}`;

async function main() {
  let res;
  try {
    res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
  } catch (err) {
    const code = err?.cause?.code;
    if (code === "ECONNREFUSED") {
      console.log(`Uygulama kapalı: ${port} portunu dinleyen yok.`);
      return 1;
    }
    console.log(`Port ${port} yanıt vermedi (${code ?? err?.name ?? "bilinmeyen hata"}); başka bir program kullanıyor olabilir.`);
    return 2;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body?.ok !== true) {
    console.log(`Port ${port} başka bir program tarafından kullanılıyor (yanıt: HTTP ${res.status}).`);
    return 2;
  }
  console.log(`Uygulama açık: ${base}`);
  if (body.version) console.log(`  sürüm: ${body.version}`);
  if (typeof body.languages === "number") console.log(`  tasarım dili: ${body.languages}`);
  if (Array.isArray(body.missingPorts) && body.missingPorts.length) console.log(`  eksik bağlantı: ${body.missingPorts.join(", ")}`);
  return 0;
}

process.exitCode = await main();
