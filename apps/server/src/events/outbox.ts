import { type Db, outbox } from "@millhiore/db"
import { asc, inArray, isNull } from "drizzle-orm"
import { enqueuePluginEvents } from "../modules/plugins/service"
import { enqueueTelegram } from "../modules/telegram/service"
import { enqueueWebhooks } from "../modules/webhooks/service"

/**
 * Reparte los eventos nuevos del `outbox` (ventas, anulaciones, turnos, tasa) entre quienes los
 * esperan (los webhooks, las alertas por Telegram y los plugins) y los marca como repartidos, todo en una
 * transacción: un evento no se reparte dos veces ni se pierde. Devuelve cuántos eventos repartió.
 */
export function drainOutbox(db: Db, now: number): number {
  return db.transaction(
    (tx) => {
      const events = tx
        .select()
        .from(outbox)
        .where(isNull(outbox.deliveredAt))
        .orderBy(asc(outbox.createdAt), asc(outbox.id))
        .limit(200)
        .all()
      if (events.length === 0) return 0
      enqueueWebhooks(tx, events, now)
      enqueueTelegram(tx, events, now)
      enqueuePluginEvents(tx, events, now)
      tx.update(outbox)
        .set({ deliveredAt: now })
        .where(
          inArray(
            outbox.id,
            events.map((e) => e.id),
          ),
        )
        .run()
      return events.length
    },
    { behavior: "immediate" },
  )
}
