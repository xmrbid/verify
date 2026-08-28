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
  /** The moment these figures were true, ISO 8601 in UTC. */
  at: string;
  payload: string;
  prevHash: string;
  hash: string;
}

/** Keys in a fixed order, no whitespace, the string is the thing being hashed. */
function canonical(at: string, values: Record<string, string | number>): string {
  const ordered = Object.keys(values)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${JSON.stringify(values[k])}`)
    .join(",");
  return `{"at":${JSON.stringify(at)},${ordered}}`;
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

/** No more than one link an hour, which is what the sealer is run at. */
const SEAL_EVERY_MS = 60 * 60 * 1000;

/**
 * Seals the figures as they stand, at most once an hour.
 *
 * It used to be once a day, and a day is a long time to leave the current
 * figures unsealed: until midnight they could be edited without breaking
 * anything, and the numbers a bidder is reading are today's. An hour is a
 * short enough window to be worth almost nothing to anybody thinking about it.
 *
 * The totals are cumulative rather than per period, and that is the important
 * part. Two links give the figures for the stretch between them by
 * subtraction, so nothing is lost, and it adds a check that costs nobody
 * anything: a total can never go down. A link showing fewer views than the one
 * before it is a forgery or a bug, and either is worth knowing.
 *
 * Cumulative also means these can only be written as time passes. A missed
 * hour cannot be filled in afterwards, because nothing here records what the
 * total was at three o'clock yesterday; that is what the chain is for. A gap
 * means the sealer did not run, it is visible, and inventing a link to cover
 * it would be the one thing this record must not do.
 */
export async function sealNow(): Promise<number> {
  if (CHAIN_START_DAY) {
    const startsAt = Date.parse(`${CHAIN_START_DAY}T00:00:00Z`);
    if (Number.isFinite(startsAt) && Date.now() < startsAt) return 0;
  }

  const head = await one<{ at: string; hash: string }>(
    "SELECT at::TEXT AS at, hash FROM stat_snapshots ORDER BY at DESC LIMIT 1",
  );
  if (head && Date.now() - Date.parse(head.at) < SEAL_EVERY_MS) return 0;

  const counters = await one<{ views: string; clicks: string }>(
    `SELECT COALESCE(SUM(value) FILTER (WHERE name = 'views'), 0)::TEXT  AS views,
            COALESCE(SUM(value) FILTER (WHERE name = 'clicks'), 0)::TEXT AS clicks
       FROM daily_counters
      WHERE ($1::DATE IS NULL OR day >= $1::DATE)`,
    [CHAIN_START_DAY],
  );
  const board = await one<{ listings: string; paid: string }>(
    `SELECT COUNT(*) FILTER (WHERE total_pico > 0)::TEXT AS listings,
            COALESCE(SUM(total_pico), 0)::TEXT AS paid
       FROM listings WHERE hidden = FALSE`,
  );

  const at = new Date();
  const payload = canonical(at.toISOString(), {
    views: Number(counters?.views ?? 0),
    clicks: Number(counters?.clicks ?? 0),
    listings: Number(board?.listings ?? 0),
    paid_piconero: board?.paid ?? "0",
  });
  const prevHash = head?.hash ?? GENESIS;
  const hash = linkHash(prevHash, payload);

  await query(
    `INSERT INTO stat_snapshots (at, payload, prev_hash, hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT (at) DO NOTHING`,
    [at.toISOString(), payload, prevHash, hash],
  );
  return 1;
}

export async function getChain(limit = 400): Promise<Link[]> {
  const rows = await query<{
    at: string;
    payload: string;
    prev_hash: string;
    hash: string;
  }>(
    `SELECT at, payload, prev_hash, hash
     FROM stat_snapshots ORDER BY at ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    at: new Date(r.at).toISOString(),
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
      return { ok: false, brokenAt: link.at };
    }
    prev = link.hash;
  }
  return { ok: true, brokenAt: null };
}
