import { z } from 'zod'

/**
 * Markets: data-driven NPC trade posts. `sells` is what the merchant
 * offers players (finite, restocking stock); `buys` is what the merchant
 * pays for (sinks). Prices are bundles (count for price), all in coins.
 * Reputation gates access; transactions are server-atomic.
 */
export const MarketSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  /** Owning faction: stance gates trading, trades earn its reputation. */
  faction: z.string(),
  sells: z
    .array(
      z.object({
        item: z.string(),
        count: z.number().int().positive().default(1),
        price: z.number().int().positive(),
        /** Units available per restock cycle. */
        stock: z.number().int().positive(),
        restockSeconds: z.number().positive().default(600),
      }),
    )
    .default([]),
  buys: z
    .array(
      z.object({
        item: z.string(),
        count: z.number().int().positive().default(1),
        price: z.number().int().positive(),
      }),
    )
    .default([]),
})

export type MarketDef = z.infer<typeof MarketSchema>
