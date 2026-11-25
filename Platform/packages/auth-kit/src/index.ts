export {
  catalogPermissionsOf,
  effectivePermissions,
  registerProductAuth,
  resolveProductDefinition,
  type ProductDefinitionSeam,
  type MemberProjection,
  type ProductAuthContext,
  type ProductAuthHook,
  type ProductAuthOptions,
  type RequirePermissionOptions,
  type VerifiedMember,
} from './productAuth.ts';
export { registerEventReceiver, type EventMeta, type EventOutcome, type EventReceiverOptions } from './eventReceiver.ts';
export {
  createJwksClient,
  JwksUnavailableError,
  UnknownKeyError,
  type JwksClient,
  type JwksClientOptions,
} from './jwks.ts';
