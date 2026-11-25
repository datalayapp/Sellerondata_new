import { measureEdgeOk, measureWeightOk } from '@deciship/core/measure';

/** Düzenlemede alan özgün değerinden değişmediyse sınır denetlenmez (eski, daha büyük kayıtların notu değiştirilebilsin). */
const unchanged = (v: string, orig: string | undefined) => orig !== undefined && v.trim() === orig.trim();

export const edgeValid = (v: string, orig?: string) => unchanged(v, orig) || measureEdgeOk(v);
export const weightValid = (v: string, orig?: string) => unchanged(v, orig) || measureWeightOk(v);
