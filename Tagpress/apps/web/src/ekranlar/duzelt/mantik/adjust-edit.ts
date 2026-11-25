import { editIsEffective, editsKey, type FontSpan, type LineEdit, normalizeSpans, type VariantAdjust } from "@tagpress/domain";

/**
 * Düzelt penceresinde ELLE metin/font düzenlemesi (saf mantık, istemci). Düzenleme yalnızca bu varyasyona aittir
 * (işin müşteri metni değişmez); `placed` (motorun ölçtüğü satır) sunucudan gelir, burada yalnızca niyet yazılır.
 */

/** Satırın düzenlemesi (yoksa undefined). */
export function editOf(a: VariantAdjust, index: number): LineEdit | undefined {
  return a.edits?.find((e) => e.index === index);
}

/** Düzenlemeyi yazar; etkisizse listeden çıkar. `placed` atılır (motor yeniden ölçecek). */
export function setEdit(a: VariantAdjust, edit: LineEdit): VariantAdjust {
  const { placed: _placed, ...clean } = edit;
  const rest = (a.edits ?? []).filter((e) => e.index !== edit.index);
  const edits = editIsEffective(clean) ? [...rest, clean].sort((x, y) => x.index - y.index) : rest;
  const { edits: _drop, ...head } = a;
  return edits.length ? { ...head, edits } : head;
}

/** Yalnızca düzenlemeleri değiştirir (konum/boyut/kalınlık aynı kalır). */
export function withEdits(a: VariantAdjust, edits: readonly LineEdit[] | undefined): VariantAdjust {
  const { edits: _drop, ...head } = a;
  return edits?.length ? { ...head, edits: [...edits] } : head;
}

/** İki düzeltmenin düzenlemeleri aynı mı (`placed` hariç)? */
export function sameEdits(a: VariantAdjust, b: VariantAdjust): boolean {
  return editsKey(a.edits) === editsKey(b.edits);
}

/**
 * Metin değişince parça fontlarını yeni metne taşır: ortak baş ve son korunur; değişen bölgeye düşen başlangıç bölgenin
 * başına, bitiş bölgenin (yeni) sonuna oturur (parçanın içine yazılan metin parçada kalır). Boşalan parça atılır.
 */
export function remapSpans(oldText: string, newText: string, spans: readonly FontSpan[] | undefined): FontSpan[] {
  if (!spans?.length) return [];
  if (oldText === newText) return normalizeSpans(spans, newText.length);
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText[p] === newText[p]) p++;
  let s = 0;
  while (s < max - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
  const oldEnd = oldText.length - s;
  const newEnd = newText.length - s;
  const delta = newText.length - oldText.length;
  const mapStart = (o: number) => (o <= p ? o : o >= oldEnd ? o + delta : p);
  const mapEnd = (o: number) => (o <= p ? o : o >= oldEnd ? o + delta : newEnd);
  return normalizeSpans(
    spans.map((sp) => ({ ...sp, start: mapStart(sp.start), end: mapEnd(sp.end) })),
    newText.length,
  );
}

/**
 * Satırın metnini değiştirir. `original`: motorun özgün satır metni (aynıysa metin düzenlemesi kalkar); `current`:
 * düzenlemeden önceki görünen metin (parça fontları buna göre taşınır). Kenar boşlukları atılır.
 */
export function withText(a: VariantAdjust, index: number, draft: string, original: string, current: string): VariantAdjust {
  const prev = editOf(a, index);
  const text = draft.replace(/[\r\n]+/g, " ").trim();
  const spans = remapSpans(current, text, prev?.spans);
  return setEdit(a, {
    index,
    ...(text !== original ? { text } : {}),
    ...(prev?.fontId !== undefined ? { fontId: prev.fontId } : {}),
    ...(spans.length ? { spans } : {}),
  });
}

/**
 * Satır(lar)ın fontu: satır fontu yazılır, parça fontları kalkar. `baseFont(i)`: motorun satır fontu (aynıysa satır
 * fontu düzenlemesi kalkar).
 */
export function withLineFont(a: VariantAdjust, indices: readonly number[], fontId: string, baseFont: (i: number) => string | undefined): VariantAdjust {
  let out = a;
  for (const i of indices) {
    const prev = editOf(out, i);
    out = setEdit(out, { index: i, ...(prev?.text !== undefined ? { text: prev.text } : {}), ...(fontId !== baseFont(i) ? { fontId } : {}) });
  }
  return out;
}

/** Satır içindeki `[start, end)` parçasının fontu (UTF-16 ofsetleri, satırın görünen metninde). */
export function withSpanFont(a: VariantAdjust, index: number, start: number, end: number, fontId: string, textLength: number): VariantAdjust {
  const prev = editOf(a, index);
  const s = Math.max(0, Math.min(start, end));
  const e = Math.min(textLength, Math.max(start, end));
  if (e <= s) return a;
  const spans = normalizeSpans([...(prev?.spans ?? []), { start: s, end: e, fontId }], textLength);
  return setEdit(a, { index, ...(prev?.text !== undefined ? { text: prev.text } : {}), ...(prev?.fontId !== undefined ? { fontId: prev.fontId } : {}), spans });
}

/** Bir parça fontunu kaldırır. */
export function withoutSpan(a: VariantAdjust, index: number, span: FontSpan): VariantAdjust {
  const prev = editOf(a, index);
  if (!prev?.spans) return a;
  const spans = prev.spans.filter((s) => !(s.start === span.start && s.end === span.end && s.fontId === span.fontId));
  return setEdit(a, { ...prev, spans });
}

/** Satırın görünen fontu: düzenlemedeki satır fontu, yoksa motorunki. */
export function lineFontOf(a: VariantAdjust, index: number, baseFont: string | undefined): string | undefined {
  return editOf(a, index)?.fontId ?? baseFont;
}

/** Seçili satırların ortak fontu; satırlar farklıysa (ya da parça fontu varsa) null. */
export function commonFont(a: VariantAdjust, indices: readonly number[], baseFont: (i: number) => string | undefined): string | null {
  let out: string | undefined;
  for (const i of indices) {
    if (editOf(a, i)?.spans?.length) return null;
    const f = lineFontOf(a, i, baseFont(i));
    if (f === undefined) return null;
    if (out === undefined) out = f;
    else if (out !== f) return null;
  }
  return out ?? null;
}

/** Düzenlenmiş metni olan satır sayısı. */
export function editedTextCount(a: VariantAdjust): number {
  return (a.edits ?? []).filter((e) => e.text !== undefined).length;
}

/** Kenar boşluğu atılmış taslak için seçim aralığını (UTF-16) uyarlar. */
export function trimRange(draft: string, start: number, end: number): { text: string; start: number; end: number } {
  const lead = draft.length - draft.trimStart().length;
  const text = draft.trim();
  const clamp = (v: number) => Math.max(0, Math.min(text.length, v - lead));
  return { text, start: clamp(Math.min(start, end)), end: clamp(Math.max(start, end)) };
}
