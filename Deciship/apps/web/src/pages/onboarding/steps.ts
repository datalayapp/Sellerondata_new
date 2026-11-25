import { presetStepState } from './presetStep.ts';
import type { OnboardingStatus, OnboardingStep } from '../../api/types';

/**
 * Sihirbazın kendi adımları. Firma bilgileri artık Merkez'de kurulur (KARARLAR "Merkez kurulumu ve araç kurulumu"):
 * `'sirket'` yalnız eski kayıtta ve eski bağlantıda kalır, hiçbir listede görünmez.
 */
export type WizardStep = Exclude<OnboardingStep, 'sirket'>;

/** Başlık, kısa açıklama ve "neden" metni `onboarding` ad alanında: `steps.<key>.{title,short,need}`. */
export interface StepMeta {
  key: WizardStep;
  /** Zorunlu adım atlanırsa özette uyarı çıkar. */
  required: boolean;
}

export const STEPS: StepMeta[] = [
  { key: 'tasiyicilar', required: true },
  { key: 'faturalar', required: false },
  { key: 'tarifeler', required: true },
  { key: 'olcum', required: true },
  { key: 'koliler', required: false },
  { key: 'ozet', required: false },
];

const isWizardStep = (k: unknown): k is WizardStep => STEPS.some((s) => s.key === k);

/** Adresteki adım adı. Eski firma adımı bağlantısı (`?adim=firma`, `?adim=sirket`) ilk DeciShip adımını açar. */
export function stepFromParam(p: string | null): WizardStep | null {
  if (p === 'firma' || p === 'sirket') return STEPS[0].key;
  return isWizardStep(p) ? p : null;
}

export const stepIndex = (k: WizardStep | null | undefined) => Math.max(0, STEPS.findIndex((s) => s.key === k));

/** ok = yapıldı · skipped = bilerek atlandı · todo = henüz yapılmadı */
export type StepState = 'ok' | 'skipped' | 'todo';

export function activeCarriers(s: OnboardingStatus) {
  return s.carriers.filter((c) => c.active);
}

/** Taşıyıcısı olup tarifesi olmayanlar (karşılaştırma bunlarda "Tarife yok" kalır). */
export function carriersWithoutTariff(s: OnboardingStatus) {
  return activeCarriers(s).filter((c) => c.activeTariffCount === 0);
}

export function stepState(s: OnboardingStatus, key: WizardStep): StepState {
  const done = s.state.done?.includes(key) ?? false;
  const skipped = s.state.skipped?.includes(key) ?? false;
  const carriers = activeCarriers(s).length;
  switch (key) {
    case 'tasiyicilar':
      return carriers > 0 ? 'ok' : 'todo';
    case 'tarifeler':
      if (carriers > 0 && carriersWithoutTariff(s).length === 0) return 'ok';
      return skipped ? 'skipped' : 'todo';
    case 'olcum':
      return done ? 'ok' : skipped ? 'skipped' : 'todo';
    case 'koliler':
      return presetStepState(s.boxPresetsReady ?? (done && s.boxPresets > 0), done, skipped);
    case 'faturalar':
      return s.invoices.length > 0 ? 'ok' : skipped || done ? 'skipped' : 'todo';
    case 'ozet':
      return s.completed ? 'ok' : 'todo';
  }
}

/** Kaldığı yer: kayıtlı adım, yoksa yapılmamış ilk adım. */
export function resumeStep(s: OnboardingStatus): WizardStep {
  // eski kayıttaki kaldırılmış bir adım (ör. çalışanlar, firma) sihirbazı bozmasın
  if (isWizardStep(s.state.step)) return s.state.step;
  return STEPS.find((m) => stepState(s, m.key) === 'todo')?.key ?? 'ozet';
}

export function currencySymbol(c: string | undefined): string {
  return ({ TRY: '₺', USD: '$', EUR: '€', GBP: '£' } as Record<string, string>)[c ?? 'TRY'] ?? c ?? '₺';
}
