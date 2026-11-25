// Kurulum sihirbazının adım mantığı. Hazır koli adımı API'nin tek tanımını okur (Merkez ile aynı). Firma adımı kalktı:
// firma bilgileri Merkez'de kurulur, eski kayıt ve bağlantı (`sirket`, `firma`) ilk DeciShip adımını açar.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { OnboardingStatus } from '../src/api/types.ts';
import { presetStepState } from '../src/pages/onboarding/presetStep.ts';
import { STEPS, resumeStep, stepFromParam, stepIndex, stepState } from '../src/pages/onboarding/steps.ts';

function status(over: Partial<OnboardingStatus> = {}, state: OnboardingStatus['state'] = {}): OnboardingStatus {
  return {
    completed: false,
    required: true,
    showBanner: true,
    state: { done: [], skipped: [], completedAt: null, bannerDismissedAt: null, ...state },
    requiredSteps: ['tasiyicilar', 'tarifeler', 'olcum'],
    company: { name: 'Örnek', currency: 'TRY', country: 'TR', timeZone: 'Europe/Istanbul', confirmed: true },
    carriers: [],
    boxPresets: 0,
    invoices: [],
    ...over,
  };
}
const carrier = (activeTariffCount: number) => ({ id: 'c1', code: 'fedex' as const, name: 'FedEx', active: true, tariffs: [], activeTariffCount });

describe('hazır koli adımı', () => {
  it('API hazır derse tamam, sihirbaz işareti ne olursa olsun', () => {
    assert.equal(presetStepState(true, false, false), 'ok');
    assert.equal(presetStepState(true, true, false), 'ok');
  });
  it('hazır değilse: işaretlendiyse ya da atlandıysa atlandı, yoksa yapılacak', () => {
    assert.equal(presetStepState(false, false, false), 'todo');
    assert.equal(presetStepState(false, true, false), 'skipped');
    assert.equal(presetStepState(false, false, true), 'skipped');
  });
});

describe('sihirbaz adımları', () => {
  it('firma adımı listede yok; sayaç yalnız DeciShip adımlarını sayar', () => {
    assert.deepEqual(
      STEPS.map((s) => s.key),
      ['tasiyicilar', 'faturalar', 'tarifeler', 'olcum', 'koliler', 'ozet'],
    );
    assert.equal(stepIndex('tasiyicilar'), 0);
  });

  it('eski firma bağlantısı ilk DeciShip adımını açar; bilinmeyen ad yok sayılır', () => {
    assert.equal(stepFromParam('firma'), 'tasiyicilar');
    assert.equal(stepFromParam('sirket'), 'tasiyicilar');
    assert.equal(stepFromParam('tarifeler'), 'tarifeler');
    assert.equal(stepFromParam('calisanlar'), null);
    assert.equal(stepFromParam(null), null);
  });

  it('kayıtlı adım "sirket" ise ilk yapılmamış adımdan devam eder', () => {
    assert.equal(resumeStep(status({}, { step: 'sirket', done: ['sirket'] })), 'tasiyicilar');
    assert.equal(resumeStep(status({ carriers: [carrier(0)] }, { step: 'sirket' })), 'faturalar');
  });

  it('kayıtlı geçerli adım korunur; yoksa ilk yapılmamış adım, hepsi bittiyse özet', () => {
    assert.equal(resumeStep(status({}, { step: 'olcum' })), 'olcum');
    assert.equal(resumeStep(status()), 'tasiyicilar');
    assert.equal(
      resumeStep(status({ carriers: [carrier(1)], boxPresetsReady: true, invoices: [{} as OnboardingStatus['invoices'][number]] }, { done: ['olcum'] })),
      'ozet',
    );
  });

  it("firma onayı adım durumuna girmez (Merkez'de gösterilir)", () => {
    const s = status({ company: { name: '', currency: '', country: '', timeZone: '', confirmed: false }, carriers: [carrier(1)] });
    assert.equal(stepState(s, 'tasiyicilar'), 'ok');
    assert.equal(stepState(s, 'tarifeler'), 'ok');
  });
});
