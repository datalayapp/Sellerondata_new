import crypto from 'node:crypto';
import { errors as joseErrors, jwtVerify, SignJWT } from 'jose';
import {
  ACCESS_TTL_SECONDS,
  EVENT_AUDIENCE,
  EVENT_TOKEN_TTL_SECONDS,
  OPERATOR_STEP_UP_AUDIENCE,
  OPERATOR_STEP_UP_TTL_SECONDS,
  SERVICE_EVENT_AUDIENCE,
  TOKEN_ALG,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  type AccessClaims,
  type PlatformEvent,
  type PlatformServiceKey,
  type ServiceEvent,
} from '@sellerondata/contracts';
import { AppError, unauthorized } from '../errors.ts';
import { keys } from './keys.ts';

export type AccessPayload = Omit<AccessClaims, 'iss' | 'aud' | 'sub' | 'iat' | 'exp' | 'jti'>;

export async function signAccessToken(personId: string, payload: AccessPayload): Promise<string> {
  const { privateKey, kid } = keys();
  return new SignJWT(payload)
    .setProtectedHeader({ alg: TOKEN_ALG, kid, typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setSubject(personId)
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TTL_SECONDS}s`)
    .sign(privateKey);
}

/** Hesap kendi jetonunu da imza + iss + aud ile doğrular. Olay jetonu (`aud: product-events`) burada geçmez. */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  try {
    const { payload } = await jwtVerify(token, keys().verifierKeySet, {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: [TOKEN_ALG],
      clockTolerance: 5,
      requiredClaims: ['exp', 'iat', 'sub', 'jti'],
    });
    if (typeof payload.sid !== 'string' || typeof payload.ep !== 'number') throw unauthorized();
    return payload as unknown as AccessClaims;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw new AppError(401, 'TOKEN_EXPIRED');
    throw unauthorized();
  }
}

/** Her denemede yeniden imzalanır (süre dolmasın), eventId aynı kalır. */
export async function signEventToken(event: PlatformEvent, occurredAt: Date): Promise<string> {
  const { privateKey, kid } = keys();
  return new SignJWT({ event, occurredAt: occurredAt.toISOString() })
    .setProtectedHeader({ alg: TOKEN_ALG, kid, typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(EVENT_AUDIENCE)
    .setJti(event.eventId)
    .setIssuedAt()
    .setExpirationTime(`${EVENT_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

/**
 * Hizmet olay jetonu (`ServiceEventClaims`): ürün olay jetonundan ayrı kitle (`SERVICE_EVENT_AUDIENCE`), `sub` hedef hizmet. Biri
 * öbürünün alıcısında geçmez. Ürün jetonu gibi her denemede yeniden imzalanır, `jti == eventId`.
 */
export async function signServiceEventToken(service: PlatformServiceKey, event: ServiceEvent, occurredAt: Date): Promise<string> {
  const { privateKey, kid } = keys();
  return new SignJWT({ event, occurredAt: occurredAt.toISOString() })
    .setProtectedHeader({ alg: TOKEN_ALG, kid, typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(SERVICE_EVENT_AUDIENCE)
    .setSubject(service)
    .setJti(event.eventId)
    .setIssuedAt()
    .setExpirationTime(`${EVENT_TOKEN_TTL_SECONDS}s`)
    .sign(privateKey);
}

/**
 * Adım artırma jetonu (`OperatorStepUpClaims`): tek amaçlı (`aud: ai-admin`), `OPERATOR_STEP_UP_TTL_SECONDS` geçerli, oturum ailesine
 * bağlı (`fid`; `sid` verildiği satırdır). Erişim jetonu yerine geçmez (`verifyAccessToken` kitleyi reddeder); geçit `sub`'ı ve aileyi
 * erişim jetonuyla karşılaştırır (`stepUpMatchesSession`): oturum yenilemesi yeni `sid` açar ama aileyi değiştirmez, jeton geçerli kalır.
 */
export async function signStepUpToken(principal: {
  personId: string;
  sessionId: string;
  familyId: string;
}): Promise<{ token: string; expiresAt: Date; jti: string }> {
  const { privateKey, kid } = keys();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + OPERATOR_STEP_UP_TTL_SECONDS;
  const jti = crypto.randomUUID();
  const personId = principal.personId;
  const token = await new SignJWT({ sid: principal.sessionId, fid: principal.familyId, op: true })
    .setProtectedHeader({ alg: TOKEN_ALG, kid, typ: 'JWT' })
    .setIssuer(TOKEN_ISSUER)
    .setAudience(OPERATOR_STEP_UP_AUDIENCE)
    .setSubject(personId)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
  return { token, expiresAt: new Date(exp * 1000), jti };
}
