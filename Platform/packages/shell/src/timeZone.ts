/**
 * Firma saat dilimi, kabukta tek kaynak (rapor Y132). `/me` gelince `activeOrg.timeZone` buraya yazılır (`session/provider.tsx`);
 * kabuk biçimlemesi (`format.ts`), Merkez dönemleri ve DeciShip paneli anları bu saat diliminde güne ve saate çevirir.
 *
 * Atanmamışsa (`/me` henüz gelmedi, firma yok, eski sunucu alanı göndermiyor, çıkış yapıldı) `undefined` döner ve her yer
 * tarayıcının saatini kullanır: bugünkü davranış.
 *
 * React'siz ve içe aktarımsız: Merkez ve DeciShip birim testleri bu dosyayı düz Node ile `@sellerondata/shell/time-zone`
 * yoluyla yükler. Uygulamada ana giriş (`./timeZone.ts`) ile alt giriş aynı dosyaya çözülür (Vite `preserveSymlinks`,
 * aynı bağlantı yolu): durum tek kopyadır.
 */
let zone: string | undefined;

function valid(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Saat dilimini atar. Boş ya da geçersiz değer temizler (tarayıcı saatine döner). */
export function setShellTimeZone(value: string | null | undefined): void {
  zone = typeof value === 'string' && value.trim() && valid(value) ? value : undefined;
}

/** Etkin firmanın saat dilimi; bilinmiyorsa `undefined` (tarayıcı saati). */
export function shellTimeZone(): string | undefined {
  return zone;
}
