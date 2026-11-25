// 8: profildeki son Figma adlı bölüm. `figma.frameName` (baskıda sipariş adı deseni, canlı) `printing.orderNamePattern`
// olur; ölü `figma.maxShrink` ve `figma.maxShiftPx` ile birlikte `figma` bölümü silinir. Yeni alan zaten varsa eski
// adlı değer üstüne yazılır (`upgradeProfileInput` ile aynı kural); `printing` nesne değilse ya da desen metin değilse
// yalnız `figma` silinir (şema varsayılanı geçer). Bozuk JSON'lu ya da nesne olmayan satır atlanır (göç 7'deki iç içe CASE kalıbı).
// Dışarıdan gelen eski veri (dil paketi, aktarım paketi) okunurken `upgradeProfileInput` ile aynı çeviriyi görür.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  UPDATE profile_versions SET data = json_remove(
    CASE WHEN json_type(data, '$.figma.frameName') = 'text'
      AND coalesce(json_type(data, '$.printing'), 'object') = 'object'
      THEN json_set(data, '$.printing.orderNamePattern', json_extract(data, '$.figma.frameName'))
      ELSE data END,
    '$.figma')
  WHERE CASE WHEN json_valid(data) THEN
    CASE WHEN json_type(data) = 'object' THEN json_type(data, '$.figma') IS NOT NULL ELSE 0 END
  ELSE 0 END;
  `;
