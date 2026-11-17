/**
 * Oturum dönemi. Çıkışta (bu sekmede ya da başka sekmede), girişte ve firma değişiminde artar. `/me` başlarken dönemi alır;
 * yanıt geldiğinde dönem değiştiyse yanıt eski kişinin ya da eski firmanındır: oturum belleğine yazılmaz, dil ve saat
 * dilimi atanmaz, bekleyen dil gönderilmez. Önbellek temizliği süren isteği durdurmaz; bu sayaç yan etkisini durdurur.
 */
let epoch = 0;
let lastPersonChange = -1;

export function sessionEpoch(): number {
  return epoch;
}

/**
 * `logout`: kişi çıktı. `login`: yeni oturum açıldı (giriş, kayıt, davetle katılma). İkisinde de eski yanıt "oturum yok"
 * sayılır. `org`: firma değişti, sayfa baştan yüklenecek.
 */
export function endSessionEpoch(reason: 'logout' | 'login' | 'org') {
  epoch += 1;
  if (reason !== 'org') lastPersonChange = epoch;
}

/** `since` döneminden beri çıkış ya da giriş oldu mu. */
export function loggedOutSince(since: number): boolean {
  return lastPersonChange > since;
}
