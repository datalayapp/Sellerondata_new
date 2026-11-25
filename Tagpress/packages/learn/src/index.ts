/**
 * "Düzeltmelerimden öğren": kullanıcının bitmiş etiketleri (referanslar) ile programın önerisi arasındaki
 * fark → sağlam istatistikle toplama → profil/şablon yaması önerisi → ayrılmış kümede (split: test) AI'sız tekrarla
 * önce/sonra; uygulamadaki hafif düzeltmelerden (adjust_log) şablon hedef merkezi önerisi. Ayrıca tasarım dili becerisi için ölçülmüş tarz özeti ve motor denemesi.
 */
export * from "./stats.ts";
export * from "./lines.ts";
export * from "./diff.ts";
export * from "./aggregate.ts";
export * from "./patch.ts";
export * from "./metrics.ts";
export * from "./env.ts";
export * from "./preview.ts";
export * from "./propose.ts";
export * from "./evaluate.ts";
export * from "./adjust.ts";
export * from "./run.ts";
export * from "./measure.ts";
export * from "./trial.ts";
