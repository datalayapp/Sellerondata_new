import { Fragment, useId } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../katman/Dialog.tsx";
import { activeHandlerIds, allCommands, CANVAS_SCOPES, type Command, formatSpec, labelKey, type Scope, setShortcutsOpen, useActiveScopes, useShortcutsOpen } from "./kayit.ts";
import "./kisayol.css";

/**
 * Gösterilecek kapsamlar, dağıtıcının öncelik sırasıyla: etkin kapsamlar (alt kip ve ekran önce), tuval (tuval
 * kullanan bir ekran ya da yakınlaştırma denetimi etkinse), en sonda genel.
 */
export function shownScopes(active: readonly Scope[]): Scope[] {
  const out: Scope[] = active.filter((s) => s !== "genel" && s !== "tuval");
  if (active.includes("tuval") || out.some((s) => CANVAS_SCOPES.includes(s))) out.push("tuval");
  out.push("genel");
  return out;
}

/**
 * Kapsamların komutları, grup adına göre (ilk görüldüğü sırayla; aynı grup iki kapsamda birleşir). Tuval komutları
 * yalnız işleyicisi verilmişse görünür (ör. ekran seçim işleyicisi vermediyse "Seçime yakınlaştır" yok); `passive`
 * komutlar her zaman.
 */
export function groupCommands(scopes: readonly Scope[], cmds: readonly Command[] = allCommands(), handled: ReadonlySet<string> = activeHandlerIds()): Array<[group: string, Command[]]> {
  const groups = new Map<string, Command[]>();
  for (const s of scopes) {
    for (const c of cmds) {
      if (c.scope !== s || c.keys.length === 0) continue; // tuşu olmayan komut listede yok
      if (s === "tuval" && !c.passive && !handled.has(c.id)) continue;
      const g = groups.get(c.group) ?? [];
      g.push(c);
      groups.set(c.group, g);
    }
  }
  return [...groups];
}

function Group({ group, cmds }: { group: string; cmds: Command[] }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <section className="tz-kp-g" aria-labelledby={id}>
      <h3 id={id}>{t(group)}</h3>
      <dl>
        {cmds.map((c) => (
          <div key={c.id} className="tz-kp-r" data-command={c.id}>
            <dt>{t(labelKey(c))}</dt>
            <dd>
              {c.keys.map((k, i) => (
                <Fragment key={k}>
                  {i > 0 && (
                    <span className="tz-kp-or" aria-hidden="true">
                      /
                    </span>
                  )}
                  <kbd className="tz-kp-k">{formatSpec(k, (x) => t(x))}</kbd>
                </Fragment>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** `?` listesi: o an etkin kapsamların komutları, gruplu; en özel kapsam (alt kip, ekran) üstte, genel en altta. */
export function ShortcutsPanel() {
  const open = useShortcutsOpen();
  const scopes = useActiveScopes();
  const { t } = useTranslation();
  if (!open) return null;
  const groups = groupCommands(shownScopes(scopes));
  return (
    <Dialog title={t("shortcuts:panel.title")} size="lg" onClose={() => setShortcutsOpen(false)}>
      <div className="tz-kp">
        {groups.map(([g, cmds]) => (
          <Group key={g} group={g} cmds={cmds} />
        ))}
      </div>
    </Dialog>
  );
}
