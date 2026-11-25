// 7: Figma eklentisinin (2026-10-10'da kaldırıldı) kalıntıları temizlenir; okurken eşleme gerekmesin diye eski değerler
// bugünkü karşılıklarına çevrilir. Eski durumlar onaylıdır (hepsi onaylı varyasyonla gitmişti); `figma-*` sorunları,
// şablonların Figma bağlantısı ve ayardaki eski Figma süresi silinir; baskı şablonu (ve basılmış oturumun şablon anlık
// kopyaları) kaynağı "figma" ise "manual", öğrenme önerisinin kaynağı "reference" olur.
// Kuyruk boştu, `variants.figma` hep NULL'du; kalibrasyon satırları aktarım paketinde (`data/aktarim/*/paket.json`) aynen var.
// Bu göç tablo ve sütun siler: göç 1'deki "göçler yalnızca ekler, tablo/sütun silinmez" notu artık geçerli değildir.
// JSON ifadeleri iç içe CASE ile korunur (AND'in kısa devresine güvenilmez): bozuk JSON'lu satır atlanır, göç düşmez.
// Göç metni değiştirilmez (yalnız dosyaya taşındı; uygulanmış veritabanı aynı metni bekler).
export const migration = `
  UPDATE jobs SET status = 'approved' WHERE status IN ('figma-queued', 'in-figma', 'figma-check', 'figma-withdraw');
  UPDATE jobs SET issues = (
    SELECT json_group_array(value) FROM json_each(jobs.issues)
    WHERE CASE WHEN type = 'object' THEN substr(coalesce(json_extract(value, '$.code'), ''), 1, 6) <> 'figma-' ELSE 1 END
  ) WHERE CASE WHEN json_valid(issues) THEN CASE WHEN json_type(issues) = 'array' THEN instr(issues, '"figma-') > 0 ELSE 0 END ELSE 0 END;
  UPDATE jobs SET run_issues = (
    SELECT json_group_array(value) FROM json_each(jobs.run_issues)
    WHERE CASE WHEN type = 'object' THEN substr(coalesce(json_extract(value, '$.code'), ''), 1, 6) <> 'figma-' ELSE 1 END
  ) WHERE CASE WHEN json_valid(run_issues) THEN CASE WHEN json_type(run_issues) = 'array' THEN instr(run_issues, '"figma-') > 0 ELSE 0 END ELSE 0 END;
  UPDATE templates SET data = json_remove(data, '$.figma')
    WHERE CASE WHEN json_valid(data) THEN json_type(data, '$.figma') IS NOT NULL ELSE 0 END;
  UPDATE print_templates SET data = json_set(data, '$.source', 'manual')
    WHERE CASE WHEN json_valid(data) THEN json_extract(data, '$.source') = 'figma' ELSE 0 END;
  UPDATE print_sessions SET template_snapshots = (
    SELECT json_group_object(key, CASE WHEN type = 'object' THEN
      CASE WHEN json_extract(value, '$.source') = 'figma' THEN json_set(value, '$.source', 'manual') ELSE value END
    ELSE value END)
    FROM json_each(print_sessions.template_snapshots)
  ) WHERE CASE WHEN json_valid(template_snapshots) THEN
    CASE WHEN json_type(template_snapshots) = 'object' THEN instr(template_snapshots, '"figma"') > 0 ELSE 0 END
  ELSE 0 END;
  UPDATE settings SET value = json_remove(value, '$.figmaStuckMinutes')
    WHERE key = 'app' AND CASE WHEN json_valid(value) THEN json_type(value, '$.figmaStuckMinutes') IS NOT NULL ELSE 0 END;
  UPDATE learn_proposals SET evidence = json_set(evidence, '$.origin', 'reference')
    WHERE CASE WHEN json_valid(evidence) THEN json_extract(evidence, '$.origin') = 'figma' ELSE 0 END;
  DROP TABLE figma_queue;
  DROP TABLE figma_calibration;
  ALTER TABLE variants DROP COLUMN figma;
  `;
