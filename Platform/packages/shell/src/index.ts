export { AppShell, bandTheme, LOCALE_NAME, type AppShellProps, type LinkRenderProps, type ProductNavGroup, type ProductNavItem } from './AppShell.tsx';
export { ErrorBoundary, BoundaryFallback, type ErrorBoundaryProps } from './ErrorBoundary.tsx';
export { useHeadSlot, type BandSize } from './headSlot.ts';
export { ProductMark, SellerOnDataMark, faviconHref, type ShellProduct } from './marks.tsx';
export { Icon, type IconName } from './icons.tsx';
export * from './primitives.tsx';
export { placeMenu, visibleBounds, MENU_GAP, MENU_MARGIN, type MenuBounds, type MenuPlacement, type MenuRect } from './menuPlacement.ts';
export * from './format.ts';
export { isProductOpen, productHref, usePrefetchProducts, setShellDocumentTitle } from './navigation.ts';
export { ApiError, createSessionClient, saveBlob, type SessionClient, type SessionClientOptions, type RequestOptions } from './session/client.ts';
export {
  SessionProvider,
  useSessionClient,
  useMe,
  useSessionActions,
  hasWebAccess,
  clearMeCache,
  beginSession,
  beginOrgChange,
  ME_QUERY_KEY,
} from './session/provider.tsx';
export type { LogoutResult } from './session/provider.tsx';
export { initShellI18n, setShellLocale, detectLocale, currentLocale } from './i18n/setup.ts';
export { setShellTimeZone, shellTimeZone } from './timeZone.ts';
export { SessionBanner } from './SessionBanner.tsx';
export { sessionStatus, type SessionStatus } from './session/status.ts';
export { LeaveConfirm, useLeaveGuard, useUnsavedChangesPrompt, type LeaveTexts } from './LeaveGuard.tsx';
export { allowUnload, dirtyFormCount, leaveDiscardingChanges, reloadDiscardingChanges, shouldBlockLeave } from './leaveRules.ts';
