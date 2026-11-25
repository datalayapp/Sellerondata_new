/**
 * Derleme profili `APP_ENV` ile seçilir (development | preview | production; varsayılan development).
 * preview ve production'da `EXPO_PUBLIC_API_URL` zorunlu ve https:// ile başlamalıdır; yoksa derleme durur.
 * Açık metin HTTP yalnız geliştirme derlemesinde ve http adresine derlenirken açıktır.
 */
const APP_ENVS = ['development', 'preview', 'production'];
const DEV_API_URL = 'http://127.0.0.1:8088';

function allowsCleartext(apiUrl) {
  return !String(apiUrl ?? '').trim().toLowerCase().startsWith('https://');
}

function withCleartextPolicy(config, apiUrl) {
  const plugins = (config.plugins ?? []).map((plugin) => {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') return plugin;
    const [name, options = {}] = plugin;
    return [name, { ...options, android: { ...options.android, usesCleartextTraffic: allowsCleartext(apiUrl) } }];
  });
  return { ...config, plugins };
}

function withIosCleartextPolicy(config, apiUrl) {
  if (!allowsCleartext(apiUrl)) return config;
  const ios = config.ios ?? {};
  const infoPlist = ios.infoPlist ?? {};
  return {
    ...config,
    ios: { ...ios, infoPlist: { ...infoPlist, NSAppTransportSecurity: { NSAllowsArbitraryLoads: true } } },
  };
}

function resolveBuildEnv(env = process.env) {
  const raw = String(env.APP_ENV ?? '').trim().toLowerCase();
  const appEnv = raw === '' ? 'development' : raw;
  if (!APP_ENVS.includes(appEnv)) {
    throw new Error(`APP_ENV=${appEnv}: geçerli değerler ${APP_ENVS.join(' | ')}`);
  }
  const given = String(env.EXPO_PUBLIC_API_URL ?? '').trim();
  if (appEnv !== 'development' && (given === '' || !given.toLowerCase().startsWith('https://'))) {
    throw new Error(`APP_ENV=${appEnv}: EXPO_PUBLIC_API_URL zorunlu ve https:// ile başlamalı`);
  }
  return { appEnv, apiUrl: given === '' ? DEV_API_URL : given };
}

function buildConfig(config, env = process.env) {
  const { appEnv, apiUrl } = resolveBuildEnv(env);
  const versionCode = config.android?.versionCode ?? null;
  const withPolicy = withCleartextPolicy(config, appEnv === 'development' ? apiUrl : 'https://');
  const withIos = withIosCleartextPolicy(withPolicy, appEnv === 'development' ? apiUrl : 'https://');
  return { ...withIos, extra: { ...(config.extra ?? {}), sod: { appEnv, apiUrl, versionCode } } };
}

module.exports = ({ config }) => buildConfig(config);
module.exports.allowsCleartext = allowsCleartext;
module.exports.withCleartextPolicy = withCleartextPolicy;
module.exports.withIosCleartextPolicy = withIosCleartextPolicy;
module.exports.resolveBuildEnv = resolveBuildEnv;
module.exports.buildConfig = buildConfig;
