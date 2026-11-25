import type { MeResponse } from "@sellerondata/contracts";
import { AppShell, hasWebAccess, type ProductNavGroup, useMe, useSessionActions } from "@sellerondata/shell";
import { type ReactNode, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { bindAccountLocale } from "../i18n/index.ts";
import { useAccess } from "../lib/access.ts";
import { LanguageProvider } from "../lib/language.tsx";
import { APP_BASE, loginHref, TOOL, toolAccessHref } from "../lib/platform.ts";
import { activeTab, screenKind, useAppRoute } from "../lib/route.ts";
import { useSetupPending } from "../lib/setupMenu.ts";
import { SETUP_NAV_ICON, SetupTag, ShellHeaderSlot, shellNavItems } from "../tezgah/cerceve/cerceve.tsx";
import { Button, EmptyState, StatusDot, Tooltip, useConfirm, useToast } from "../tezgah/index.ts";
import { allowUnload, hasUnsavedChanges } from "../tezgah/katman/leaveGuard.ts";

/**
 * Platform kipinin kabuğu: ortak `AppShell` (Tezgâh düzeni `workspace`, bant `work`) + oturum kapısı. Üst satır (marka,
 * menü, ⊞, firma, hesap, dil) kabuğun; iş satırı her ekranın `AppFrame`'inden kabuğun baş yuvasına taşınır. Form ve
 * liste ekranlarında (`screenKind` → `column`) kabuk baş yuvasını Merkez/DeciShip sütununa hizalar; üst satır her
 * ekranda kenardan kenara.
 *
 * Kapı (şablon `Platform/templates/tool-web/src/App.tsx` `gateOf`): oturum yok → Merkez girişi (`next` kalınan yer);
 * Hesap'a ulaşılamadı ve son bilinen kişi yok → "Bağlantı yok"; etkin firma yok → Merkez'e dönüş; TagPress'te web izni
 * yok → Merkez'in ortak erişim sayfası.
 */
export type Gate = "loading" | "anon" | "offline" | "no-org" | "no-access" | "ok";

export function gateOf(me: MeResponse | null, pending: boolean, error: boolean): Gate {
  if (!me) return error ? "offline" : pending ? "loading" : "anon";
  if (!me.activeOrg) return "no-org";
  return hasWebAccess(me, TOOL) ? "ok" : "no-access";
}

/** Değiştirme izni yoksa sağ kümede kalıcı uyarı (ekranlar yazma eylemlerini ayrıca kapatır; sunucu yine 403 verir). */
function ReadOnlyChip() {
  const { t } = useTranslation("session");
  const access = useAccess();
  const org = useMe();
  if (access.edit || !org.me) return null;
  return (
    <Tooltip content={t("readOnly.hint")}>
      <span className="tz-tr-ro" tabIndex={0}>
        <StatusDot tone="warn" label={t("readOnly.label")} />
      </span>
    </Tooltip>
  );
}

export function PlatformKabuk({ children }: { children: ReactNode }) {
  const { t } = useTranslation("frame");
  const ts = useTranslation("session").t;
  const session = useMe();
  const me = session.me;
  const { logout, switchOrg, changeLocale } = useSessionActions();
  const confirm = useConfirm();
  const toast = useToast();
  const [route] = useAppRoute();
  const active = activeTab(route);
  const gate = gateOf(me, session.isPending, session.isError);

  // Ayarlar › Dil de hesaba yazar (üst menüdeki dil seçimiyle aynı yol).
  useEffect(() => {
    bindAccountLocale(changeLocale);
    return () => bindAccountLocale(null);
  }, [changeLocale]);

  useEffect(() => {
    if (gate === "anon") window.location.assign(loginHref());
    if (gate === "no-access") window.location.replace(toolAccessHref());
  }, [gate]);

  // "Kurulum · Eksik" menünün başında (DeciShip deseni; kural `lib/setupMenu.ts`), Kurulum ekranındayken seçili.
  const setupPending = useSetupPending(gate === "ok" ? (me?.activeOrg?.id ?? null) : null);
  const productNav = useMemo<ProductNavGroup[] | undefined>(() => {
    if (gate !== "ok") return undefined;
    const groups: ProductNavGroup[] = [{ items: shellNavItems(t, APP_BASE) }];
    if (setupPending) groups.unshift({ items: [{ href: `${APP_BASE}/#/kurulum`, label: t("nav.setup"), icon: SETUP_NAV_ICON, badge: <SetupTag /> }] });
    return groups;
  }, [gate, t, setupPending]);
  // Menü karma (hash) adresleriyle: etkin sekme ekranın bildirdiği menü (Düzelt geldiği sekmeyi işaretler).
  const currentPath = `${APP_BASE}/#/${active ?? route.id}${route.rest.length ? `/${route.rest.join("/")}` : ""}`;

  /** Kaydedilmemiş değişiklik varsa önce sorar (DeciShip deseni); onaylanınca tarayıcının uyarısı ikinci kez çıkmaz. */
  const mayLeave = useCallback(async () => {
    if (!hasUnsavedChanges()) return true;
    const ok = await confirm({
      title: t("common:dialog.dirtyTitle"),
      body: t("common:leave.body"),
      confirmLabel: ts("switchOrg.confirm"),
      tone: "danger",
    });
    if (ok) allowUnload();
    return ok;
  }, [confirm, t, ts]);

  const onSwitchOrg = useCallback(
    async (orgId: string) => {
      if (!(await mayLeave())) return;
      await switchOrg(orgId, `${APP_BASE}/`);
    },
    [mayLeave, switchOrg],
  );

  const onLogout = useCallback(async () => {
    if (!(await mayLeave())) return;
    const r = await logout();
    // Sunucu oturumu kapatmadıysa kişi hâlâ içeride: girişe gitmek onu geri atar, sayfada kalınır ve söylenir.
    if (!r.serverEnded) return toast({ message: `${t("shell:session.logoutFailed")} ${t("shell:session.logoutFailedBody")}`, tone: "error" });
    window.location.assign("/login");
  }, [logout, mayLeave, t, toast]);

  return (
    <LanguageProvider enabled={gate === "ok"}>
    <AppShell
      currentProduct={TOOL}
      workspace
      column={screenKind(route) === "column"}
      productNav={productNav}
      pageTitle={active ? t(`nav.${NAV_TITLE[active]}`) : route.id === "kurulum" ? t("nav.setup") : null}
      currentPath={currentPath}
      me={me}
      isLocalHref={(href) => href === APP_BASE || href.startsWith(`${APP_BASE}/`)}
      headerSlot={gate === "ok" ? <ShellHeaderSlot extra={<ReadOnlyChip />} /> : undefined}
      onLogout={onLogout}
      onSwitchOrg={onSwitchOrg}
      onChangeLocale={changeLocale}
    >
      {gate === "ok" ? (
        children
      ) : gate === "no-org" ? (
        <EmptyState
          icon="bldg"
          title={ts("gate.noOrgTitle")}
          body={ts("gate.noOrgBody")}
          action={
            <Button variant="primary" onClick={() => window.location.assign("/home")}>
              {ts("gate.backHub")}
            </Button>
          }
        />
      ) : gate === "offline" ? (
        <EmptyState icon="warn" title={t("shell:session.offlineTitle")} body={t("shell:session.offlineBody")} />
      ) : (
        <div className="tz-boot" aria-busy="true" />
      )}
    </AppShell>
    </LanguageProvider>
  );
}

const NAV_TITLE = {
  uretim: "production",
  "tasarim-dili": "designLanguage",
  sablonlar: "templates",
  baski: "print",
  ayarlar: "settings",
} as const;
