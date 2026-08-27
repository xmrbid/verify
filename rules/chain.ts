import { createHash } from "node:crypto";
import { one, query } from "./db.ts";

/**
 * A hash chain over the daily stats.
 *
 * Publishing numbers is not the same as being checkable on them. Once a day is
 * over it is sealed into a row carrying the previous day's hash, so changing
 * an old figure changes every hash after it. Since the chain is public, and
 * anyone can keep a copy, the edit is what becomes visible, not the number.
 *
 * Verification is deliberately reproducible by hand:
 *
 *   hash = sha256( prev_hash + "\\n" + payload )
 *
 * where `payload` is exactly the string published, byte for byte.
 */
export const GENESIS = "0".repeat(64);

/**
 * Where a day starts, for every figure this board publishes.
 *
 * A series of daily numbers means nothing until somebody says when a day
 * begins, so it is stated rather than inferred, and it is central European
 * time because that is where this board is read from and run from.
 *
 * It observes daylight saving, which means two days a year are 23 and 25 hours
 * long. That is a real wrinkle in a series of daily counts and it is published
 * rather than smoothed: the alternative was a fixed offset with no relevance
 * to anybody here, and a tidier chart is not worth a timezone nobody uses.
 *
 * The database runs in the same zone; this constant is what publishes it.
 */
export const DAY_TIMEZONE = "Europe/Madrid";

export interface Link {
  day: string;
  payload: string;
  prevHash: string;
  hash: string;
}

/** Keys in a fixed order, no whitespace, the string is the thing being hashed. */
function canonical(day: string, values: Record<string, string | number>): string {
  const ordered = Object.keys(values)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(values[k])}`)
    .join(",");
  return `{"day":${JSON.stringify(day)},${ordered}}`;
}

export function linkHash(prevHash: string, payload: string): string {
  return createHash("sha256").update(`${prevHash}\n${payload}`).digest("hex");
}

/**
 * The first day the record covers.
 *
 * A chain has to start somewhere, and the days before a board opens are not
 * the thing anybody is checking: they are the build, and their traffic is
 * mostly the person building it. Starting on the opening day is the honest
 * boundary, and it is published rather than left to be noticed, so nobody
 * wonders what happened to the week before.
 *
 * Unset, the chain covers everything there is.
 */
export const CHAIN_START_DAY = process.env.CHAIN_START_DAY ?? null;

/**
 * Seals every finished day that is not sealed yet, oldest first. Idempotent:
 * a day already in the chain is left exactly as it was.
 */
export async function sealPendingDays(): Promise<number> {
  const pending = await query<{ day: string; views: string; clicks: string }>(
    `SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
            COALESCE(SUM(c.value) FILTER (WHERE c.name = 'views'), 0)::TEXT  AS views,
            COALESCE(SUM(c.value) FILTER (WHERE c.name = 'clicks'), 0)::TEXT AS clicks
     FROM (SELECT DISTINCT day FROM daily_counters
            WHERE day < CURRENT_DATE
              AND ($1::DATE IS NULL OR day >= $1::DATE)) d
     LEFT JOIN daily_counters c ON c.day = d.day
     WHERE NOT EXISTS (SELECT 1 FROM stat_snapshots s WHERE s.day = d.day)
     GROUP BY d.day
     ORDER BY d.day ASC`,
    [CHAIN_START_DAY],
  );
  if (pending.length === 0) return 0;

  const board = await one<{ listings: string; paid: string }>(
    `SELECT COUNT(*) FILTER (WHERE total_pico > 0)::TEXT AS listings,
            COALESCE(SUM(total_pico), 0)::TEXT AS paid
     FROM listings WHERE hidden = FALSE`,
  );

  let sealed = 0;
  for (const row of pending) {
    const head = await one<{ hash: string }>(
      "SELECT hash FROM stat_snapshots ORDER BY day DESC LIMIT 1",
    );
    const prevHash = head?.hash ?? GENESIS;
    const payload = canonical(row.day, {
      views: Number(row.views),
      clicks: Number(row.clicks),
      listings_at_seal: Number(board?.listings ?? 0),
      paid_piconero_at_seal: board?.paid ?? "0",
    });
    const hash = linkHash(prevHash, payload);
    const result = await query(
      `INSERT INTO stat_snapshots (day, payload, prev_hash, hash)
       VALUES ($1, $2, $3, $4) ON CONFLICT (day) DO NOTHING`,
      [row.day, payload, prevHash, hash],
    );
    void result;
    sealed++;
  }
  return sealed;
}

export async function getChain(limit = 400): Promise<Link[]> {
  const rows = await query<{
    day: string;
    payload: string;
    prev_hash: string;
    hash: string;
  }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, payload, prev_hash, hash
     FROM stat_snapshots ORDER BY day ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    day: r.day,
    payload: r.payload,
    prevHash: r.prev_hash,
    hash: r.hash,
  }));
}

/** Recomputes the whole chain. Used by the verifier endpoint and the tests. */
export function verify(links: Link[]): { ok: boolean; brokenAt: string | null } {
  let prev = GENESIS;
  for (const link of links) {
    if (link.prevHash !== prev || linkHash(prev, link.payload) !== link.hash) {
      return { ok: false, brokenAt: link.day };
    }
    prev = link.hash;
  }
  return { ok: true, brokenAt: null };
}
