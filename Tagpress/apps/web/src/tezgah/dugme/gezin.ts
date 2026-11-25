import type { KeyboardEvent } from "react";

/**
 * Bir grubun (ray, sekmeler, segment) ok tuşuyla gezilen öğeleri. Dinleyici kapsayıcıdadır (`onKeyDown`);
 * tuş gezinmeye aitse `preventDefault` çağrılır ve hedef öğe döner, değilse null.
 * Öğeler `itemSelector` ile bulunur; devre dışı olanlar atlanır; uçlarda başa/sona sarar; Home/End uca gider.
 */
export function arrowTarget(
  e: KeyboardEvent<HTMLElement>,
  itemSelector: string,
  orientation: "horizontal" | "vertical" | "both",
): { items: HTMLElement[]; index: number } | null {
  const fwd = orientation === "vertical" ? ["ArrowDown"] : orientation === "horizontal" ? ["ArrowRight"] : ["ArrowRight", "ArrowDown"];
  const back = orientation === "vertical" ? ["ArrowUp"] : orientation === "horizontal" ? ["ArrowLeft"] : ["ArrowLeft", "ArrowUp"];
  const isFwd = fwd.includes(e.key);
  const isBack = back.includes(e.key);
  if (!isFwd && !isBack && e.key !== "Home" && e.key !== "End") return null;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(itemSelector)].filter((el) => !(el as HTMLButtonElement).disabled);
  if (items.length === 0) return null;
  const here = (e.target as HTMLElement).closest<HTMLElement>(itemSelector);
  const at = here ? items.indexOf(here) : -1;
  let index: number;
  if (e.key === "Home") index = 0;
  else if (e.key === "End") index = items.length - 1;
  else if (at < 0) index = isFwd ? 0 : items.length - 1;
  else index = (at + (isFwd ? 1 : -1) + items.length) % items.length;
  e.preventDefault();
  return { items, index };
}
