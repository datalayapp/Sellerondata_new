// pg-guard.mjs için tip bildirimi (TypeScript test ortam dosyaları içe aktarır). Kurallar pg-guard.mjs başında.
export interface RealUseGuard {
  mark: string | null;
  realPort: number;
  allow: boolean;
}
export const REAL_USE_MARK: string;
export const ALLOW_FLAG: string;
export const DEFAULT_REAL_PORT: number;
export const SAFE_PORT: number;
export const PLATFORM_ENV_FILE: string;
export function envFileValue(text: string, name: string): string | null;
export function realUseGuard(opts?: { env?: Record<string, string | undefined>; envFile?: string; envText?: string }): RealUseGuard;
export function parseHost(v: string): { host: string; port: number } | null;
export function hostOfUrl(url: string): { host: string; port: number } | null;
export function isLocalHost(host: string): boolean;
export function blockedReason(host: string, port: number, guard: RealUseGuard): string | null;
export function resolveTestDbHost(env?: Record<string, string | undefined>, guard?: RealUseGuard): string;
