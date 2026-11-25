import net from 'node:net';

/**
 * Windows'ta libuv 1.52 öncesi (Node 24.0-24.15, Node 24.15.0 = libuv 1.51.0) hatası: uv__tcp_keepalive,
 * RtlGetVersion'a boyut alanı başlatılmamış OSVERSIONINFOW verir. Yığındaki rastgele değere göre yapı taşar,
 * /GS denetimi __fastfail(2) ile süreci sessizce düşürür: çıkış kodu 3221226505 (0xC0000409), stderr ve WER
 * kaydı yok. Her pg bağlantısı keepAlive açtığından (src/db.ts POOL_DEFAULTS) test çalışanı rastgele bir dosyada
 * ölüyordu. Düzeltme libuv aabb7651de, Node 24.16.0 ile geldi (nodejs/node#62561, nodejs/node#63620).
 *
 * Testler TCP keepalive sondalarına dayanmaz (ilk sonda 10 sn sonra). Etkilenen sürümlerde çağrı atlanır;
 * Node >= 24.16 (libuv >= 1.52) kurulunca bu dosya kendiliğinden devre dışı kalır. Üretim Linux'ta etkilenmez.
 */
function affected(): boolean {
  if (process.platform !== 'win32') return false;
  const [major, minor] = process.versions.uv.split('.').map(Number);
  return major === 1 && minor < 52;
}

if (affected()) {
  net.Socket.prototype.setKeepAlive = function setKeepAlive(this: net.Socket) {
    return this;
  };
}
