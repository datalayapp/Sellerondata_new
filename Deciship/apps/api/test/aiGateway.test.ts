/**
 * DS-AI (YAPAY-ZEKA-GECIDI §6): geçit yolunun saf kuralları (veritabanısız). Yolun seçimi (`aiModeOf`), açılışı durduran ayarlar
 * (`invalidEnv`), ret kodu eşlemesi (`aiFailed`; R4: yanlış eşleme tekrar ücret doğurur) ve sayaç türlerinin kayıttaki amaçlarla
 * eşleşmesi. Uçtan uca (gerçek SDK + sahte geçit) `aiProvider.test.ts`'te.
 */
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  AI_CHARGED_MAYBE,
  AI_HEADERS,
  AI_REJECT_CODES,
  AI_REJECT_STATUS,
  PRODUCTS,
  aiRejectBody,
  aiRejectHeaders,
  isAiModelAllowed,
  isAiPurposeOf,
  type AiRejectCode,
} from '@sellerondata/contracts';
import { aiModeOf, invalidEnv } from '../src/env.ts';
import { AiGatewayRejectError, AiMaybeChargedError, AiTransientError, aiFailed } from '../src/services/ai.ts';
import { AI_KINDS, aiPurposeOf } from '../src/services/aiMeter.ts';
import { isTransientJobError } from '../src/services/jobs/runner.ts';

describe('yolun seçimi (aiModeOf)', () => {
  it('geçit adresi + jeton → gateway (anahtar olsa da, üretimde de); jetonsuz adres → off (doğrudan yola düşülmez)', () => {
    expect(aiModeOf({ AI_GATEWAY_URL: 'http://ai-api:4300', AI_GATEWAY_TOKEN: 't' })).toBe('gateway');
    expect(aiModeOf({ AI_GATEWAY_URL: 'http://ai-api:4300', AI_GATEWAY_TOKEN: 't', ANTHROPIC_API_KEY: 'k' })).toBe('gateway');
    expect(aiModeOf({ AI_GATEWAY_URL: 'http://ai-api:4300', AI_GATEWAY_TOKEN: 't', SOD_ENV: 'production' })).toBe('gateway');
    expect(aiModeOf({ AI_GATEWAY_URL: 'http://ai-api:4300', ANTHROPIC_API_KEY: 'k' })).toBe('off');
    expect(aiModeOf({ AI_GATEWAY_URL: 'http://ai-api:4300', AI_GATEWAY_TOKEN: '  ', ANTHROPIC_API_KEY: 'k' })).toBe('off');
  });

  it('geçit yokken bugünkü doğrudan yol yalnız SOD_ENV üretim değilken; anahtarsız off', () => {
    expect(aiModeOf({ ANTHROPIC_API_KEY: 'k' })).toBe('direct');
    expect(aiModeOf({ ANTHROPIC_API_KEY: 'k', SOD_ENV: 'development' })).toBe('direct');
    expect(aiModeOf({ ANTHROPIC_API_KEY: 'k', NODE_ENV: 'production' })).toBe('direct');
    expect(aiModeOf({ ANTHROPIC_API_KEY: 'k', SOD_ENV: 'production' })).toBe('off');
    expect(aiModeOf({ ANTHROPIC_API_KEY: '  ' })).toBe('off');
    expect(aiModeOf({})).toBe('off');
  });
});

describe('açılışı durduran ayarlar (invalidEnv)', () => {
  it('bugünkü ortam (geçitsiz, yerel anahtar) temiz', () => {
    expect(invalidEnv({})).toEqual([]);
    expect(invalidEnv({ ANTHROPIC_API_KEY: 'k' })).toEqual([]);
    expect(invalidEnv({ AI_GATEWAY_URL: 'http://ai-api:4300', AI_GATEWAY_TOKEN: 't' })).toEqual([]);
    expect(invalidEnv({ AI_GATEWAY_URL: 'https://ai.internal/', AI_GATEWAY_TOKEN: 't', SOD_ENV: 'production' })).toEqual([]);
  });

  it('jetonsuz geçit adresi, bozuk adres; üretimde ortamda duran sağlayıcı anahtarı ("anahtar artık geçitte")', () => {
    expect(invalidEnv({ AI_GATEWAY_URL: 'http://ai-api:4300' })).toEqual(['AI_GATEWAY_TOKEN (required when AI_GATEWAY_URL is set)']);
    for (const bad of ['ai-api:4300x', 'ftp://ai-api', 'http://u:p@ai-api:4300', 'http://ai-api:4300/?x=1', 'not a url']) {
      expect(invalidEnv({ AI_GATEWAY_URL: bad, AI_GATEWAY_TOKEN: 't' }), bad).toEqual(['AI_GATEWAY_URL (the AI gateway address, e.g. http://ai-api:4300)']);
    }
    expect(invalidEnv({ SOD_ENV: 'production', ANTHROPIC_API_KEY: 'sk-ant-x' })).toEqual([
      'ANTHROPIC_API_KEY (must be empty in production: the key lives in the AI gateway; set AI_GATEWAY_URL and AI_GATEWAY_TOKEN)',
    ]);
    expect(invalidEnv({ SOD_ENV: 'production', ANTHROPIC_API_KEY: 'sk-ant-x', AI_GATEWAY_URL: 'http://ai-api:4300', AI_GATEWAY_TOKEN: 't' })).toHaveLength(1);
    expect(invalidEnv({ SOD_ENV: 'production', ANTHROPIC_API_KEY: '  ' })).toEqual([]);
  });
});

describe('sayaç türleri ve kayıt', () => {
  it('her tür kayıttaki DeciShip amacına eşlenir; varsayılan model izin listesinde', () => {
    for (const kind of AI_KINDS) expect(isAiPurposeOf('deciship', aiPurposeOf(kind)), kind).toBe(true);
    expect(AI_KINDS.map(aiPurposeOf).sort()).toEqual(Object.keys(PRODUCTS.deciship.ai?.purposes ?? {}).sort());
    expect(isAiModelAllowed('deciship', 'claude-sonnet-5-5')).toBe(true);
  });
});

/** Geçidin reddi, sözleşmedeki biçimle (SDK'nın kendi ayrıştırmasıyla: `APIError.generate`). */
const rejectError = (code: AiRejectCode, retryAfter?: number) =>
  Anthropic.APIError.generate(AI_REJECT_STATUS[code], aiRejectBody('anthropic', code), undefined, new Headers(aiRejectHeaders(code, retryAfter)));

describe('ret kodu eşlemesi (aiFailed)', () => {
  /** Beklenen: [DeciShip kodu, HTTP, arka plan işi yeniden dener mi]. */
  const EXPECTED: Record<AiRejectCode, [string, number, boolean]> = {
    sod_platform_paused: ['AI_PLATFORM_PAUSED', 429, false],
    sod_org_cap: ['AI_SPEND_CAP', 429, false],
    sod_tool_cap: ['AI_SPEND_CAP', 429, false],
    sod_rate_limited: ['AI_BUSY', 503, true],
    sod_provider_missing: ['AI_DISABLED', 503, false],
    sod_org_closed: ['ORG_CLOSED', 409, false],
    sod_unauthorized: ['AI_FAILED', 502, false],
    sod_context_invalid: ['AI_FAILED', 502, false],
    sod_purpose_unknown: ['AI_FAILED', 502, false],
    sod_model_not_allowed: ['AI_FAILED', 502, false],
    sod_body_too_large: ['AI_FAILED', 502, false],
  };

  it('sözleşmedeki her ret kodunun eşlemesi var (yeni kod eklenirse bu test kırılır)', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...AI_REJECT_CODES].sort());
  });

  it.each(AI_REJECT_CODES.map((c) => [c] as const))('%s', (code) => {
    const [want, status, transient] = EXPECTED[code];
    const e = aiFailed(rejectError(code, 9));
    expect(e).toMatchObject({ code: want, statusCode: status });
    expect(isTransientJobError(e)).toBe(transient);
    if (transient) expect(e).toBeInstanceOf(AiTransientError);
    else expect(e).toBeInstanceOf(AiGatewayRejectError);
    if (code === 'sod_rate_limited') expect((e as AiTransientError).retryAfter).toBe(9);
    // sağlayıcı anahtarı geçersiz sanılmaz (401 sod_unauthorized): kullanıcıya "anahtar" metni gitmez
    expect(e.message).not.toMatch(/anahtar|key/i);
  });

  it('ret başlığı yoksa sağlayıcının hatası bugünkü gibi: 429 → AI_BUSY, 401 → AI_DISABLED (anahtar), 400 → AI_FAILED', () => {
    expect(aiFailed(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error' } }, undefined, new Headers()))).toMatchObject({ code: 'AI_BUSY' });
    expect(aiFailed(Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error' } }, undefined, new Headers()))).toMatchObject({ code: 'AI_DISABLED', statusCode: 503 });
    expect(aiFailed(Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error' } }, undefined, new Headers()))).toMatchObject({ code: 'AI_FAILED', statusCode: 502 });
    // tanınmayan ret değeri geçidin reddi sayılmaz
    const odd = new Headers({ 'x-sod-ai-reject': 'sod_new_thing', 'x-should-retry': 'false' });
    expect(aiFailed(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'sod_new_thing' } }, undefined, odd))).toMatchObject({ code: 'AI_BUSY' });
  });

  it('R2: geçidin 5xx\'i "ücret doğmuş olabilir" (x-sod-ai-charged: maybe) kalıcıdır (iş yeniden denemez); başlıksız 5xx geçici kalır', () => {
    const body = { type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } };
    for (const status of [500, 502, 504]) {
      const maybe = aiFailed(Anthropic.APIError.generate(status, body, undefined, new Headers({ [AI_HEADERS.charged]: AI_CHARGED_MAYBE, [AI_HEADERS.shouldRetry]: 'false' })));
      expect(maybe).toBeInstanceOf(AiMaybeChargedError);
      expect(maybe).toMatchObject({ code: 'AI_FAILED', statusCode: 502, details: { status, charged: AI_CHARGED_MAYBE } });
      expect(isTransientJobError(maybe)).toBe(false);
      const plain = aiFailed(Anthropic.APIError.generate(status, body, undefined, new Headers({ [AI_HEADERS.shouldRetry]: 'false' })));
      expect(plain).toBeInstanceOf(AiTransientError);
      expect(isTransientJobError(plain)).toBe(true);
    }
    // 4xx'te başlık anlamsız (geçit yalnız 5xx'te yazar): bugünkü eşleme.
    const bad = aiFailed(Anthropic.APIError.generate(400, body, undefined, new Headers({ [AI_HEADERS.charged]: AI_CHARGED_MAYBE })));
    expect(bad).not.toBeInstanceOf(AiMaybeChargedError);
  });
});
