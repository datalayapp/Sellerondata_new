import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../../i18n/index.ts";

/**
 * Klavye kısayollarının tek kaydı. Düğme ipucu, rozet, `aria-keyshortcuts` ve `?` listesi buradan okunur.
 *
 * - Her ekran kendi `kisayollar.ts` dosyasında `defineCommands([...])` çağırır (içe aktarıldığı anda kaydolur).
 * - Ekran `useCommands(kapsam, { komutKimliği: işleyici })` ile o an etkin işleyicileri verir.
 * - Pencerede tek `keydown` dinleyicisi (yakalama evresinde). Kapsam önceliği: alt kip (`modal`) > ekran > tuval > genel;
 *   aynı düzeyde sonra kaydolan kazanır. Yazı alanında yalnız `inInput` işaretli komutlar; açık pencerede yalnız `modal`
 *   kayıtlar çalışır.
 * - Tuş adları: "mod+s" (Ctrl / ⌘), "shift+n", "alt+1", "1-9", "space", "enter", "escape", "delete", "arrowleft", "?", "/".
 * - Kimlik ve sözlük anahtarı: genel ve tuval komutları `shortcuts:<kimlik>` (ör. "canvas.fit" → `shortcuts:canvas.fit`);
 *   ekran komutlarının kimliği `<kapsam>.<ad>` biçimindedir ve adı `<ekran ad alanı>:shortcuts.<ad>` anahtarındadır
 *   (ör. "uretim.approve" → `production:shortcuts.approve`).
 */
export type Scope =
  | "genel"
  | "tuval"
  | "uretim"
  | "duzelt"
  | "iceAktar"
  | "baskiMasa"
  | "baskiSablon"
  | "tasarimDili"
  | "sablonlar"
  | "ayarlar"
  | "kurulum";

export type CommandId = string;

export interface Command {
  id: CommandId;
  scope: Scope;
  /** Bir ya da birkaç tuş (ilki rozette görünür). */
  keys: string[];
  /** Grup adının sözlük anahtarı (ör. "shortcuts:groups.canvas", "production:shortcuts.groups.queue"). */
  group: string;
  /** Rozet: `primary` birincil düğmede, `frequent` ekranın en sık 2–4 işinde. Rozetsiz komut yalnız ipucunda. */
  badge?: "primary" | "frequent";
  /** Yazı alanındayken de çalışır (Esc, Ctrl Enter, Ctrl S gibi). */
  inInput?: boolean;
  /** Tuş basılı tutulunca yinelenir (ok tuşlarıyla kaydırma gibi). */
  repeat?: boolean;
  /**
   * İşleyicisi kayıtta olmayan komut (basılı tutulan Boşluk gibi; işi başka yerde yapılır). `?` listesinde kapsamı
   * etkinken her zaman görünür. `tuval` kapsamının diğer komutları yalnız bir işleyici varken görünür.
   */
  passive?: boolean;
}

/** Kapsamın sözlük ad alanı. */
export const SCOPE_NS: Record<Scope, string> = {
  genel: "shortcuts",
  tuval: "shortcuts",
  uretim: "production",
  duzelt: "adjust",
  iceAktar: "importDesk",
  baskiMasa: "printDesk",
  baskiSablon: "printTemplates",
  tasarimDili: "designLanguage",
  sablonlar: "templates",
  ayarlar: "settings",
  kurulum: "setup",
};

/** Tuval kullanan ekran kapsamları: bunlarda `tuval` komutları da aynı anda etkindir (çakışma denetimi buna göre). */
export const CANVAS_SCOPES: readonly Scope[] = ["duzelt", "baskiMasa", "baskiSablon", "sablonlar", "tasarimDili"];

const SHARED_SCOPES = new Set<Scope>(["genel", "tuval"]);
const RANK: Record<"genel" | "tuval" | "screen", number> = { genel: 0, tuval: 1, screen: 2 };
const rankOf = (s: Scope) => (s === "genel" ? RANK.genel : s === "tuval" ? RANK.tuval : RANK.screen);

// ---------------------------------------------------------------- kayıt

const registry = new Map<CommandId, Command>();

export function defineCommands(list: Command[]): void {
  for (const c of list) {
    if (!SHARED_SCOPES.has(c.scope) && !c.id.startsWith(`${c.scope}.`)) {
      throw new Error(`Kısayol kimliği kapsamıyla başlamalı: ${c.id} (${c.scope}.…)`); // i18n-ok: geliştirici hatası
    }
    const old = registry.get(c.id);
    if (old && old.scope !== c.scope) throw new Error(`Kısayol kimliği iki kapsamda: ${c.id}`); // i18n-ok: geliştirici hatası
    // Aynı kimlik aynı kapsamda yeniden tanımlanabilir (geliştirmede modül yeniden yüklenince).
    registry.set(c.id, c);
  }
}

export function getCommand(id: CommandId): Command | undefined {
  return registry.get(id);
}

export function allCommands(): Command[] {
  return [...registry.values()];
}

export function commandsIn(scope: Scope): Command[] {
  return allCommands().filter((c) => c.scope === scope);
}

/** Komut adının sözlük anahtarı. */
export function labelKey(c: Pick<Command, "id" | "scope">): string {
  if (SHARED_SCOPES.has(c.scope)) return `shortcuts:${c.id}`;
  return `${SCOPE_NS[c.scope]}:shortcuts.${c.id.slice(c.scope.length + 1)}`;
}

// ---------------------------------------------------------------- tuş adları

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || "");

interface Spec {
  /** Ctrl (Windows) / ⌘ (Mac); kayıtta "mod" ya da "ctrl" yazılır. */
  mod: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseSpec(spec: string): Spec {
  const s = spec.toLowerCase();
  // "+" tuşu: tek başına ("+") ya da bileşimin sonunda ("mod++").
  const parts = s === "+" ? ["+"] : s.endsWith("++") ? [...s.slice(0, -2).split("+").filter(Boolean), "+"] : s.split("+");
  const key = parts.pop() ?? "";
  return { mod: parts.includes("mod") || parts.includes("ctrl"), shift: parts.includes("shift"), alt: parts.includes("alt"), key };
}

const NAMED: Record<string, string> = {
  " ": "space",
  spacebar: "space",
  esc: "escape",
  del: "delete",
};
const isLetter = (k: string) => k.length === 1 && k.toLowerCase() !== k.toUpperCase();
const isDigit = (k: string) => /^[0-9]$/.test(k);

/** Olayın tuşu, kayıttaki biçimde (küçük harf, adlı tuşlar adla). */
function eventKey(e: KeyboardEvent): string {
  const code = e.code ?? "";
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code)?.[1];
  if (digit) return digit;
  if (e.altKey && /^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  const k = e.key ?? "";
  if (k === "İ") return "i"; // i18n-ok: Türkçe klavyede Shift+i
  const low = k.length === 1 ? k.toLowerCase() : k.toLowerCase();
  return NAMED[low] ?? low;
}

/** Simge tuşu ("=", "[", "?", ","): harf, rakam ya da adlı tuş değil. */
const isSymbol = (k: string) => k.length === 1 && !isLetter(k) && !isDigit(k);

/**
 * Eşleşme türü. `char`: simge, ÜRETİLEN karakterle (`e.key`) eşleşti; karakterin hangi tuş bileşimiyle yazıldığı
 * önemsiz (Türkçe Q'da "=" Shift 0, "[" AltGr 8). `key`: harf, rakam ve adlı tuş fiziksel/harf eşleşmesiyle.
 */
export type MatchKind = "char" | "key";

/** Tek tuş tanımı olayla eşleşiyor mu; eşleşiyorsa nasıl? */
export function matchSpecKind(spec: string, e: KeyboardEvent): MatchKind | null {
  const p = parseSpec(spec);
  const mac = isMac();
  if (isSymbol(p.key)) {
    if ((e.key ?? "") !== p.key) return null;
    // Shift, AltGr (Windows'ta Ctrl + Alt) ve Mac'te Option karakteri yazmak içindir: yok sayılır.
    const altGr = !mac && e.ctrlKey && e.altKey;
    const modDown = mac ? e.metaKey : e.ctrlKey && !altGr;
    if (p.mod !== modDown) return null;
    if (mac ? e.ctrlKey : e.metaKey) return null;
    if (p.alt && !e.altKey) return null;
    if (!p.alt && e.altKey && !altGr && !mac) return null;
    return "char";
  }
  const key = eventKey(e);
  if (p.key.includes("-") && p.key.length === 3 && isDigit(p.key[0]!) && isDigit(p.key[2]!)) {
    const [lo, hi] = [Number(p.key[0]), Number(p.key[2])];
    if (!isDigit(key) || Number(key) < lo || Number(key) > hi) return null;
  } else if ((NAMED[p.key] ?? p.key) !== key) return null;
  const modDown = mac ? e.metaKey : e.ctrlKey;
  if (p.mod !== modDown) return null;
  if (mac ? e.ctrlKey : e.metaKey) return null;
  if (p.alt !== e.altKey) return null;
  if (p.shift !== e.shiftKey) return null;
  return "key";
}

/** Tek tuş tanımı olayla eşleşiyor mu? */
export function matchSpec(spec: string, e: KeyboardEvent): boolean {
  return matchSpecKind(spec, e) !== null;
}

/** Komutun tuşlarından biri eşleşiyor mu; karakter eşleşmesi fiziksel eşleşmeden önce gelir. */
export function matchCommandKind(c: Pick<Command, "keys">, e: KeyboardEvent): MatchKind | null {
  let out: MatchKind | null = null;
  for (const k of c.keys) {
    const m = matchSpecKind(k, e);
    if (m === "char") return "char";
    if (m) out = m;
  }
  return out;
}

export function matchCommand(c: Pick<Command, "keys">, e: KeyboardEvent): boolean {
  return matchCommandKind(c, e) !== null;
}

const ARROWS: Record<string, string> = { arrowleft: "←", arrowright: "→", arrowup: "↑", arrowdown: "↓" };
const TRANSLATED = new Set(["space", "enter", "escape", "delete", "backspace", "tab"]);

/** Ekranda görünen tuş adı: Windows "Ctrl S", Mac "⌘ S"; boşluk TR "Boşluk", EN "Space". */
export function formatSpec(spec: string, t: (k: string) => string = (k) => i18n.t(k)): string {
  const p = parseSpec(spec);
  const mac = isMac();
  const out: string[] = [];
  if (p.mod) out.push(mac ? "⌘" : t("shortcuts:keys.ctrl"));

  if (p.alt) out.push(mac ? "⌥" : t("shortcuts:keys.alt"));
  const k = NAMED[p.key] ?? p.key;
  // Simge olduğu gibi gösterilir: hangi bileşimle yazıldığı klavye düzenine bağlı (Türkçe Q'da "=" Shift 0).
  if (p.shift && !isSymbol(k)) out.push(mac ? "⇧" : t("shortcuts:keys.shift"));
  if (TRANSLATED.has(k)) out.push(t(`shortcuts:keys.${k}`));
  else if (ARROWS[k]) out.push(ARROWS[k]);
  else if (/^\d-\d$/.test(k)) out.push(`${k[0]}–${k[2]}`);
  else out.push(k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1));
  return out.join(" ");
}

export function formatKeys(keys: readonly string[], t?: (k: string) => string): string {
  return keys.map((k) => formatSpec(k, t)).join(" / ");
}

const ARIA_NAMED: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  escape: "Escape",
  delete: "Delete",
  backspace: "Backspace",
  tab: "Tab",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
};

/** `aria-keyshortcuts` değeri (WAI-ARIA biçimi; seçenekler boşlukla ayrılır). */
export function ariaKeys(keys: readonly string[]): string {
  const mac = isMac();
  const one = (spec: string): string[] => {
    const p = parseSpec(spec);
    const k = NAMED[p.key] ?? p.key;
    const mods = [p.mod && (mac ? "Meta" : "Control"), p.alt && "Alt", p.shift && !isSymbol(k) && "Shift"].filter(Boolean) as string[];
    const names = /^\d-\d$/.test(k)
      ? Array.from({ length: Number(k[2]) - Number(k[0]) + 1 }, (_, i) => String(Number(k[0]) + i))
      : [ARIA_NAMED[k] ?? (k.length === 1 ? k.toUpperCase() : k)];
    return names.map((n) => [...mods, n].join("+"));
  };
  return keys.flatMap(one).join(" ");
}

// ---------------------------------------------------------------- etkin kayıtlar ve dağıtıcı

/**
 * Komut işleyicisi. `false` dönerse olay işlenmemiş sayılır: `preventDefault` yapılmaz ve başka kayıt denenmez
 * (tarayıcının kendi davranışı sürer; ör. odaktaki düğmede Enter düğmeye tıklar). Dönüş yoksa olay engellenir.
 */
// Dönüş türü `unknown`: `() => liste.push(x)` gibi değer döndüren eski işleyiciler de geçerli; yalnız `false` serbest bırakır.
export type CommandHandler = (e: KeyboardEvent) => unknown;
type Handlers = Partial<Record<CommandId, CommandHandler>>;
interface Registration {
  seq: number;
  scope: Scope;
  modal: boolean;
  handlers: { current: Handlers };
}

let seq = 0;
const active: Registration[] = [];
const scopeListeners = new Set<() => void>();
let scopeSnapshot: Scope[] = [];

/** Dağıtıcının baktığı sıra: alt kip (`modal`) > ekran > tuval > genel; aynı düzeyde sonra kaydolan önce. */
const byPriority = (a: Registration, b: Registration) => (a.modal === b.modal ? rankOf(b.scope) - rankOf(a.scope) || b.seq - a.seq : a.modal ? -1 : 1);

function emitScopes() {
  scopeSnapshot = [...new Set([...active].sort(byPriority).map((r) => r.scope))];
  for (const l of scopeListeners) l();
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type);
}

function hasNativeModal(): boolean {
  return typeof document !== "undefined" && !!document.querySelector("dialog[open], [aria-modal='true']");
}

/** Açık açılır kutu ya da menü (`data-tz-layer`): tuşlar onundur (oklar, Esc, Enter); hiçbir kayıt çalışmaz. */
function hasOpenLayer(): boolean {
  return typeof document !== "undefined" && !!document.querySelector("[data-tz-layer]");
}

/** Olayı işleyen kaydı bulur ve çalıştırır; işlenirse true. Dışa açık: test ve özel dinleyiciler için. */
export function dispatchKey(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || hasOpenLayer()) return false;
  const typing = isTyping(e.target);
  const regs = [...active].sort(byPriority);
  const anyModal = regs.some((r) => r.modal);
  if (!anyModal && hasNativeModal()) return false;
  // Öncelik sırasıyla ilk karakter eşleşmesi kazanır; yoksa ilk fiziksel eşleşme. Böylece Türkçe Q'da Shift 0 ile
  // yazılan "=", "=" komutu varken "Shift 0" komutuna (gerçek boyut) düşmez.
  let pick: CommandHandler | null = null;
  scan: for (const r of regs) {
    if (anyModal && !r.modal) break;
    for (const [id, fn] of Object.entries(r.handlers.current)) {
      const c = registry.get(id);
      if (!fn || !c) continue;
      const kind = matchCommandKind(c, e);
      if (!kind) continue;
      if (typing && !c.inInput) continue;
      if (e.repeat && !c.repeat) continue;
      if (kind === "char") {
        pick = fn;
        break scan;
      }
      pick ??= fn;
    }
  }
  if (!pick) return false;
  if (pick(e) === false) return false;
  e.preventDefault();
  return true;
}

let listening = false;
const onKeyDown = (e: KeyboardEvent) => {
  dispatchKey(e);
};
function ensureListener() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("keydown", onKeyDown, true);
  listening = true;
}
function dropListener() {
  if (!listening || active.length) return;
  window.removeEventListener("keydown", onKeyDown, true);
  listening = false;
}

/**
 * Ekranın o an etkin kısayol işleyicileri. `handlers` her çizimde yenilenebilir (son hali kullanılır).
 * `modal`: açık pencere ya da alt kip; açıkken yalnız modal kayıtlar çalışır.
 */
export function useCommands(scope: Scope, handlers: Handlers, opts: { enabled?: boolean; modal?: boolean } = {}): void {
  const ref = useRef(handlers);
  ref.current = handlers;
  const enabled = opts.enabled ?? true;
  const modal = opts.modal ?? false;
  useEffect(() => {
    if (!enabled) return;
    const reg: Registration = { seq: ++seq, scope, modal, handlers: ref };
    active.push(reg);
    ensureListener();
    emitScopes();
    return () => {
      const i = active.indexOf(reg);
      if (i >= 0) active.splice(i, 1);
      emitScopes();
      dropListener();
    };
  }, [scope, enabled, modal]);
}

/** O an etkin bir kayıtta işleyicisi olan komutlar (`?` listesi: verilmeyen tuval komutu gösterilmez). */
export function activeHandlerIds(): Set<CommandId> {
  const out = new Set<CommandId>();
  for (const r of active) for (const [id, fn] of Object.entries(r.handlers.current)) if (fn) out.add(id);
  return out;
}

/** O an işleyicisi kayıtlı kapsamlar (`?` listesi için), dağıtıcının öncelik sırasıyla (alt kip önce, genel sonda). */
export function useActiveScopes(): Scope[] {
  return useSyncExternalStore(
    (fn) => {
      scopeListeners.add(fn);
      return () => {
        scopeListeners.delete(fn);
      };
    },
    () => scopeSnapshot,
    () => scopeSnapshot,
  );
}

export interface CommandView {
  /** Görünen ad (etkin dilde). */
  label: string;
  /** Tuş(lar), ekrandaki biçimde ("Ctrl S", "1–9"). */
  keysText: string;
  ariaKeyShortcuts: string;
  /** Rozet gösterilsin mi (`badge` işaretli komut). */
  showBadge: boolean;
  /** İpucu: "Onayla · 2". */
  tooltip: string;
}

export function describeCommand(id: CommandId, t: (k: string) => string = (k) => i18n.t(k)): CommandView {
  const c = registry.get(id);
  if (!c) return { label: id, keysText: "", ariaKeyShortcuts: "", showBadge: false, tooltip: id };
  const label = t(labelKey(c));
  const keysText = formatKeys(c.keys, t);
  return { label, keysText, ariaKeyShortcuts: ariaKeys(c.keys), showBadge: !!c.badge, tooltip: keysText ? `${label} · ${keysText}` : label };
}

/** Komutun adı, tuşları ve rozeti; dil değişince yeniden çizilir. */
export function useCommand(id: CommandId): CommandView {
  const { t, i18n: inst } = useTranslation();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- dil değişince yeniden hesaplanır: tuş adları (formatKeys) dile bağlı, `t` kimliği her dil değişiminde değişmeyebilir
  return useMemo(() => describeCommand(id, (k) => t(k)), [id, t, inst.language]);
}

// ---------------------------------------------------------------- `?` listesi açık mı

let panelOpen = false;
const panelListeners = new Set<() => void>();
export function setShortcutsOpen(v: boolean) {
  panelOpen = v;
  for (const l of panelListeners) l();
}
export function useShortcutsOpen(): boolean {
  return useSyncExternalStore(
    (fn) => {
      panelListeners.add(fn);
      return () => {
        panelListeners.delete(fn);
      };
    },
    () => panelOpen,
    () => panelOpen,
  );
}
