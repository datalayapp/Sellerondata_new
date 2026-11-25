import { z } from "zod";
import { TierSchema } from "./profile.ts";

/**
 * Tasarım niyeti: AI'ın ürettiği TEK şey. AI asla piksel koordinatı, punto ya da konum üretmez.
 * Satırlar yan yana konunca müşteri metni karakter karakter geri çıkmalıdır (boşluklar hariç; bkz. text.ts).
 */
export const LineRoleSchema = z.enum(["name", "connector", "greeting", "message", "date", "place", "title", "other"]);
export type LineRole = z.infer<typeof LineRoleSchema>;

export const IntentLineSchema = z.object({
  text: z.string().min(1),
  role: LineRoleSchema,
  tier: TierSchema,
  /** Profildeki font kimliği. */
  fontId: z.string().min(1),
  /** Yalnızca profil oranları kilitli değilse: ana satıra oran. */
  size: z.number().positive().max(1.5).optional(),
});
export type IntentLine = z.infer<typeof IntentLineSchema>;

export const DesignIntentSchema = z.object({
  lines: z.array(IntentLineSchema).min(1),
  /** Yalnızca profil doluluğu kilitli değilse. */
  fill: z.number().min(0.3).max(1).optional(),
  /** AI'ın kısa gerekçesi (en fazla iki cümle). */
  rationale: z.string().default(""),
});
export type DesignIntent = z.infer<typeof DesignIntentSchema>;
