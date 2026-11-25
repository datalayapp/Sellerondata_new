// Geliştirme kapısının araç hedefleri (kayıttan). Ayrı dosya: dev-gateway.mjs içe aktarılınca sunucu açılır, bu işlev sınanabilsin.

/**
 * Kayıttaki araçların geliştirme hedefleri: { anahtar -> { api?: port, web?: port } }.
 * Port: `<ANAHTAR>_API_PORT` / `<ANAHTAR>_WEB_PORT` ya da kayıttaki `deploy.<yön>.dev`.
 * Port yoksa araç o yönde yönlendirilmez; sessiz bırakılmaz, `warn` ile açıkça uyarılır.
 */
export function productTargets(registry, env = process.env, warn = console.warn) {
  const out = {};
  for (const e of registry) {
    const name = e.key.toUpperCase();
    const api = e.deploy?.api && Number(env[`${name}_API_PORT`] ?? e.deploy.api.dev);
    const web = e.deploy?.web && Number(env[`${name}_WEB_PORT`] ?? e.deploy.web.dev);
    if (e.deploy?.api && !api) warn(`dev-gateway UYARI: ${e.key} API'si yönlendirilmiyor (kayıtta deploy.api.dev yok; ${name}_API_PORT verilebilir)`);
    if (e.deploy?.web && !web) warn(`dev-gateway UYARI: ${e.key} web'i yönlendirilmiyor (kayıtta deploy.web.dev yok; ${name}_WEB_PORT verilebilir)`);
    if (api || web) out[e.key] = { api: api || undefined, web: web || undefined };
  }
  return out;
}
