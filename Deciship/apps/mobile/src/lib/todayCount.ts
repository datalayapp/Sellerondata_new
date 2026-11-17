/**
 * "Bugün" ekranındaki "Ölçülen" sayısı (11-B13). Liste sunucudan en çok 200 ölçüm alır; sayı sunucunun bugün sayacından
 * (`GET /measurements/stats/today`, firma saat dilimiyle) gelir ve telefonda henüz gönderilmemiş bugünkü ölçümler eklenir.
 * Sayaç yoksa (eski sunucu, hata, çevrimdışı ilk açılış) listeden sayılır. Sayaç alındıktan sonra gönderilen ölçüm
 * listede görünür: sayı listeden aşağı düşmez.
 */
export function todayCount(p: { listCount: number; serverCount: number | null; unsentToday: number }): number {
  const server = p.serverCount;
  if (server === null || !Number.isInteger(server) || server < 0) return p.listCount;
  return Math.max(p.listCount, server + p.unsentToday);
}
