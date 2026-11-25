// 6: basılmış oturumun şablon anlık kopyası. "Basıldı" işaretlenince sayfaların şablonları (kağıt, yuvalar, kesim,
// hücre etiketi) JSON olarak saklanır (`{ şablonKimliği: PrintTemplate }`); basılmış oturumun önizlemesi, çıktısı ve
// yeniden basımı şablonun sonraki değişikliklerinden etkilenmez. Taslakta NULL.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  ALTER TABLE print_sessions ADD COLUMN template_snapshots TEXT;
  `;
