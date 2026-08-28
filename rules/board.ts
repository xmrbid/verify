import { createHash } from "node:crypto";
import { query, one } from "./db.ts";
import type { ProfileLinks } from "./handle.ts";

export type BoardMode = "all-time" | "today";

export interface Category {
  slug: string;
  name: string;
  /** One line for a card. */
  tagline: string;
  /** A paragraph for the ranking's own page, and for anything reading it. */
  description: string;
  topPico: bigint;
  /** Everything paid inside this category, not just the leading bid. */
  totalPico: bigint;
  count: number;
  /** Whoever currently holds #1 in this category, if anyone does. */
  leader: { key: string; display: string; id: number; hasIcon: boolean } | null;
}

export interface BoardRow {
  id: number;
  key: string;
  kind: "url" | "onion";
  targetUrl: string;
  display: string;
  tagline: string;
  description: string;
  categorySlug: string;
  categoryName: string;
  /** All-time total, or the last-24h total when the board is in "today" mode. */
  amountPico: bigint;
  totalPico: bigint;
  clicks: number;
  firstBidAt: Date | null;
  /** Position on the board being shown, category-local on a category board. */
  rank: number;
  /** Position across the whole board, whatever is being shown. */
  overallRank: number;
  categoryRank: number;
  /** True when the server captured the site's icon; see src/lib/icon.ts. */
  hasIcon: boolean;
  /** The owner's chosen /@handle, if they picked one. */
  handle: string | null;
  links: ProfileLinks;
}

interface RawRow {
  id: string;
  key: string;
  kind: "url" | "onion";
  target_url: string;
  display: string;
  tagline: string;
  description: string;
  category_slug: string;
  category_name: string;
  amount_pico: string;
  total_pico: string;
  clicks: string;
  first_bid_at: Date | null;
  rank: string;
  category_rank: string;
  has_icon: boolean;
  handle: string | null;
  links: ProfileLinks;
}

function toRow(r: RawRow, categoryLocal = false): BoardRow {
  return {
    id: Number(r.id),
    key: r.key,
    kind: r.kind,
    targetUrl: r.target_url,
    display: r.display,
    tagline: r.tagline,
    description: r.description,
    categorySlug: r.category_slug,
    categoryName: r.category_name,
    amountPico: BigInt(r.amount_pico),
    totalPico: BigInt(r.total_pico),
    clicks: Number(r.clicks),
    firstBidAt: r.first_bid_at,
    // A category board is its own ranking: whoever leads it is #1 there, even
    // if they sit sixteenth overall.
    rank: Number(categoryLocal ? r.category_rank : r.rank),
    overallRank: Number(r.rank),
    categoryRank: Number(r.category_rank),
    hasIcon: r.has_icon,
    handle: r.handle,
    links: r.links ?? {},
  };
}

/**
 * One CTE builds every board. `amount` is what the board ranks by, the
 * all-time total, or the sum of the last 24 hours of settled payments. Ties
 * fall back to who got there first, so an early bid is never displaced by a
 * later bid of the same size.
 */
function boardCte(mode: BoardMode): string {
  const amount =
    mode === "today"
      ? `COALESCE((
           SELECT SUM(p.amount_pico) FROM payments p
           WHERE p.listing_id = l.id AND p.settled_at > NOW() - INTERVAL '24 hours'
         ), 0)`
      : "l.total_pico";
  const order =
    mode === "today"
      ? `(SELECT MIN(p.settled_at) FROM payments p
          WHERE p.listing_id = l.id AND p.settled_at > NOW() - INTERVAL '24 hours')`
      : "l.first_bid_at";

  return `
    WITH board AS (
      SELECT l.*, c.name AS category_name,
             (l.icon_type IS NOT NULL) AS has_icon,
             ${amount}::BIGINT AS amount_pico,
             ${order} AS ordered_at
      FROM listings l
      JOIN categories c ON c.slug = l.category_slug
      WHERE l.hidden = FALSE
    ),
    ranked AS (
      SELECT b.*,
             ROW_NUMBER() OVER (ORDER BY b.amount_pico DESC, b.ordered_at ASC, b.id ASC) AS rank,
             ROW_NUMBER() OVER (PARTITION BY b.category_slug
                                ORDER BY b.amount_pico DESC, b.ordered_at ASC, b.id ASC) AS category_rank
      FROM board b
      WHERE b.amount_pico > 0
    )
  `;
}

export async function getBoard(opts: {
  mode: BoardMode;
  categorySlug?: string;
  limit: number;
  offset: number;
}): Promise<{ rows: BoardRow[]; total: number }> {
  const params: unknown[] = [opts.limit, opts.offset];
  let filter = "";
  if (opts.categorySlug) {
    params.push(opts.categorySlug);
    filter = `WHERE category_slug = $${params.length}`;
  }

  const rows = await query<RawRow>(
    `${boardCte(opts.mode)}
     SELECT * FROM ranked ${filter}
     ORDER BY ${opts.categorySlug ? "category_rank" : "rank"} ASC LIMIT $1 OFFSET $2`,
    params,
  );

  const countParams = opts.categorySlug ? [opts.categorySlug] : [];
  const countRow = await one<{ n: string }>(
    `${boardCte(opts.mode)}
     SELECT COUNT(*)::TEXT AS n FROM ranked ${opts.categorySlug ? "WHERE category_slug = $1" : ""}`,
    countParams,
  );

  return {
    rows: rows.map((r) => toRow(r, !!opts.categorySlug)),
    total: Number(countRow?.n ?? 0),
  };
}

/** The bid a newcomer must beat to sit at #1 on this board. */
export async function getTopBid(
  mode: BoardMode,
  categorySlug?: string,
): Promise<bigint> {
  const row = await one<{ amount_pico: string | null }>(
    `${boardCte(mode)}
     SELECT MAX(amount_pico)::TEXT AS amount_pico FROM ranked
     ${categorySlug ? "WHERE category_slug = $1" : ""}`,
    categorySlug ? [categorySlug] : [],
  );
  return BigInt(row?.amount_pico ?? "0");
}

export interface LadderStep {
  /** Amount as a piconero string, so no precision is lost crossing to the client. */
  pico: string;
  display: string;
  /** So a raise can drop its own listing out of the ladder it is climbing. */
  key: string;
  /** The captured icon's address, or null when the monogram is drawn instead. */
  icon: string | null;
  /** The monogram's letter and its tint, worked out here so the client need not. */
  initial: string;
  tint: number;
}

/**
 * The board as a price ladder, every amount with the name holding it, highest
 * first. The bid form uses it to show exactly which listings a bid would jump,
 * without asking the server on each keystroke. Capped: past a few hundred the
 * exact neighbours stop being interesting.
 */
export async function getLadder(
  mode: BoardMode,
  categorySlug: string | undefined,
  limit = 300,
): Promise<LadderStep[]> {
  const params: unknown[] = [limit];
  let filter = "";
  if (categorySlug) {
    params.push(categorySlug);
    filter = `WHERE category_slug = $${params.length}`;
  }
  const rows = await query<{
    pico: string;
    display: string;
    key: string;
    id: string;
    has_icon: boolean;
  }>(
    `${boardCte(mode)}
     SELECT amount_pico::TEXT AS pico, display, key, id, has_icon
       FROM ranked ${filter}
     ORDER BY amount_pico DESC LIMIT $1`,
    params,
  );
  return rows.map((r) => ({
    pico: r.pico,
    display: r.display,
    key: r.key,
    // The hero ladder runs in the browser and cannot call the server component
    // that draws a mark, so the two things it needs are worked out here: the
    // address of a captured icon, or the letter and tint the monogram uses.
    icon: r.has_icon ? `/mark/${r.id}` : null,
    initial: (/\p{L}|\p{N}/u.exec(`${r.display} ${r.key}`)?.[0] ?? "?").toUpperCase(),
    tint: createHash("sha256").update(r.key).digest()[0] % 6,
  }));
}

export async function getListing(key: string): Promise<BoardRow | null> {
  const row = await one<RawRow>(
    `${boardCte("all-time")}
     SELECT * FROM ranked WHERE key = $1`,
    [key],
  );
  return row ? toRow(row) : null;
}

export async function getListingByHandle(handle: string): Promise<BoardRow | null> {
  const row = await one<RawRow>(
    `${boardCte("all-time")}
     SELECT * FROM ranked WHERE handle = $1`,
    [handle],
  );
  return row ? toRow(row) : null;
}

export async function getCategories(): Promise<Category[]> {
  const rows = await query<{
    slug: string;
    name: string;
    tagline: string;
    description: string;
    top_pico: string;
    sum_pico: string;
    n: string;
    leader_key: string | null;
    leader_display: string | null;
    leader_icon: boolean | null;
  }>(
    `SELECT c.slug, c.name, c.tagline, c.description,
            COALESCE(MAX(l.total_pico), 0)::TEXT AS top_pico,
            COALESCE(SUM(l.total_pico), 0)::TEXT AS sum_pico,
            COUNT(l.id)::TEXT AS n,
            (SELECT t.key     FROM listings t
              WHERE t.category_slug = c.slug AND t.hidden = FALSE AND t.total_pico > 0
              ORDER BY t.total_pico DESC, t.first_bid_at ASC LIMIT 1) AS leader_key,
            (SELECT t.display FROM listings t
              WHERE t.category_slug = c.slug AND t.hidden = FALSE AND t.total_pico > 0
              ORDER BY t.total_pico DESC, t.first_bid_at ASC LIMIT 1) AS leader_display,
            (SELECT t.icon_type IS NOT NULL FROM listings t
              WHERE t.category_slug = c.slug AND t.hidden = FALSE AND t.total_pico > 0
              ORDER BY t.total_pico DESC, t.first_bid_at ASC LIMIT 1) AS leader_icon,
            (SELECT t.id FROM listings t
              WHERE t.category_slug = c.slug AND t.hidden = FALSE AND t.total_pico > 0
              ORDER BY t.total_pico DESC, t.first_bid_at ASC LIMIT 1) AS leader_id
     FROM categories c
     LEFT JOIN listings l
       ON l.category_slug = c.slug AND l.hidden = FALSE AND l.total_pico > 0
     GROUP BY c.slug, c.name, c.tagline, c.description, c.sort
     ORDER BY COALESCE(MAX(l.total_pico), 0) DESC, c.sort ASC`,
  );
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    description: r.description,
    topPico: BigInt(r.top_pico),
    totalPico: BigInt(r.sum_pico),
    count: Number(r.n),
    leader:
      r.leader_key && r.leader_display
        ? {
            key: r.leader_key,
            display: r.leader_display,
            id: Number((r as { leader_id?: string }).leader_id ?? 0),
            hasIcon: !!r.leader_icon,
          }
        : null,
  }));
}

export interface CategoryTop {
  id: number;
  key: string;
  handle: string | null;
  display: string;
  totalPico: bigint;
  hasIcon: boolean;
}

/**
 * The first few listings in every category, keyed by slug.
 *
 * One query with a window function rather than one per card: the categories
 * page draws thirty of these and a per-card lookup would be thirty round trips
 * to say the same thing.
 */
export async function categoryLeaders(
  perCategory = 3,
): Promise<Map<string, CategoryTop[]>> {
  const rows = await query<{
    slug: string;
    id: string;
    key: string;
    handle: string | null;
    display: string;
    pico: string;
    has_icon: boolean;
  }>(
    `SELECT * FROM (
       SELECT l.category_slug AS slug, l.id::TEXT, l.key, l.handle, l.display,
              l.total_pico::TEXT AS pico,
              (l.icon_type IS NOT NULL) AS has_icon,
              ROW_NUMBER() OVER (PARTITION BY l.category_slug
                                 ORDER BY l.total_pico DESC, l.first_bid_at) AS pos
         FROM listings l
        WHERE l.hidden = FALSE AND l.total_pico > 0
     ) ranked
      WHERE pos <= $1`,
    [perCategory],
  );

  const out = new Map<string, CategoryTop[]>();
  for (const r of rows) {
    const list = out.get(r.slug) ?? [];
    list.push({
      id: Number(r.id),
      key: r.key,
      handle: r.handle,
      display: r.display,
      totalPico: BigInt(r.pico),
      hasIcon: r.has_icon,
    });
    out.set(r.slug, list);
  }
  return out;
}

export interface ActivityItem {
  id: number;
  key: string;
  handle: string | null;
  display: string;
  amountPico: bigint;
  rank: number;
  settledAt: Date;
  hasIcon: boolean;
}

export async function getActivity(limit = 6): Promise<ActivityItem[]> {
  const rows = await query<{
    id: string;
    key: string;
    handle: string | null;
    display: string;
    pico: string;
    pos: string;
    settled_at: Date;
    has_icon: boolean;
  }>(
    `${boardCte("all-time")}
     SELECT r.id::TEXT, r.key, r.handle, r.display, r.has_icon,
            p.amount_pico::TEXT AS pico, r.rank::TEXT AS pos, p.settled_at
     FROM payments p JOIN ranked r ON r.id = p.listing_id
     ORDER BY p.settled_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    key: r.key,
    handle: r.handle,
    display: r.display,
    amountPico: BigInt(r.pico),
    rank: Number(r.pos),
    settledAt: r.settled_at,
    hasIcon: r.has_icon,
  }));
}

export interface RankPrice {
  rank: number;
  id: number;
  key: string;
  handle: string | null;
  display: string;
  hasIcon: boolean;
  pico: bigint;
  clicks: number;
  /** Days the listing has been on the board, floored at 1. */
  daysLive: number;
}

/**
 * The board as a price list: what each rank currently costs and what it has
 * been getting. This is the table somebody actually bids from, a rank is only
 * worth its price if you can see the traffic that came with it.
 */
export async function rankPrices(limit = 25): Promise<RankPrice[]> {
  const rows = await query<{
    pos: string;
    id: string;
    key: string;
    handle: string | null;
    display: string;
    has_icon: boolean;
    pico: string;
    n_clicks: string;
    days: string;
  }>(
    // Every cast column is aliased. ORDER BY resolves output names before
    // table columns, so a bare `rank::TEXT` would sort 1, 10, 11, 2, this bit
    // twice before.
    `${boardCte("all-time")}
     SELECT rank::TEXT AS pos, id, key, handle, display, has_icon,
            amount_pico::TEXT AS pico,
            clicks::TEXT AS n_clicks,
            GREATEST(1, EXTRACT(EPOCH FROM (NOW() - first_bid_at)) / 86400)::TEXT AS days
     FROM ranked ORDER BY rank ASC LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    rank: Number(r.pos),
    id: Number(r.id),
    key: r.key,
    handle: r.handle,
    display: r.display,
    hasIcon: r.has_icon,
    pico: BigInt(r.pico),
    clicks: Number(r.n_clicks),
    daysLive: Math.max(1, Number(r.days)),
  }));
}

export interface SettlementDay {
  day: string;
  bids: number;
  pico: bigint;
}

/** Settled bids per day, from the payment ledger, oldest first with gaps filled. */
export async function settlementsByDay(days: number): Promise<SettlementDay[]> {
  const rows = await query<{ day: string; bids: string; pico: string }>(
    `SELECT to_char(settled_at::DATE, 'YYYY-MM-DD') AS day,
            COUNT(*)::TEXT AS bids,
            SUM(amount_pico)::TEXT AS pico
     FROM payments
     WHERE settled_at > CURRENT_DATE - $1::INT
     GROUP BY settled_at::DATE`,
    [days],
  );

  const byDay = new Map<string, SettlementDay>();
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { day: key, bids: 0, pico: 0n });
  }
  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (entry) {
      entry.bids = Number(row.bids);
      entry.pico = BigInt(row.pico);
    }
  }
  return [...byDay.values()];
}

/** XMR paid, grouped by the category the listing sits in. */
export async function paidByCategory(): Promise<{ label: string; value: number }[]> {
  const rows = await query<{ name: string; pico: string }>(
    `SELECT c.name, SUM(l.total_pico)::TEXT AS pico
     FROM listings l JOIN categories c ON c.slug = l.category_slug
     WHERE l.hidden = FALSE AND l.total_pico > 0
     GROUP BY c.name ORDER BY SUM(l.total_pico) DESC`,
  );
  // Rendered in milli-XMR so the bars carry whole numbers people can compare.
  return rows.map((r) => ({ label: r.name, value: Math.round(Number(r.pico) / 1e9) }));
}

/** Clicks grouped by the category the listing sits in. */
export async function clicksByCategory(): Promise<{ label: string; value: number }[]> {
  const rows = await query<{ name: string; clicks: string }>(
    `SELECT c.name, SUM(l.clicks)::TEXT AS clicks
     FROM listings l JOIN categories c ON c.slug = l.category_slug
     WHERE l.hidden = FALSE AND l.clicks > 0
     GROUP BY c.name ORDER BY SUM(l.clicks) DESC`,
  );
  return rows.map((r) => ({ label: r.name, value: Number(r.clicks) }));
}

export interface BoardStats {
  listings: number;
  volumePico: bigint;
  topPico: bigint;
  clicks: number;
  onionCount: number;
}

export async function getStats(): Promise<BoardStats> {
  const row = await one<{
    listings: string;
    volume: string;
    top: string;
    clicks: string;
    onions: string;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE total_pico > 0)::TEXT           AS listings,
       COALESCE(SUM(total_pico), 0)::TEXT                     AS volume,
       COALESCE(MAX(total_pico), 0)::TEXT                     AS top,
       COALESCE(SUM(clicks), 0)::TEXT                         AS clicks,
       COUNT(*) FILTER (WHERE kind = 'onion' AND total_pico > 0)::TEXT AS onions
     FROM listings WHERE hidden = FALSE`,
  );
  return {
    listings: Number(row?.listings ?? 0),
    volumePico: BigInt(row?.volume ?? "0"),
    topPico: BigInt(row?.top ?? "0"),
    clicks: Number(row?.clicks ?? 0),
    onionCount: Number(row?.onions ?? 0),
  };
}

/**
 * The lowest bid currently holding a place, which is what a new listing has to
 * beat. Null when the board is empty.
 */
/**
 * The smallest bid currently holding a place, in one ranking or across all.
 *
 * With a category, it is the smallest bid in that category, which is the one
 * that decides what it costs to enter it. Without, it is the smallest anywhere,
 * which is what the front page quotes.
 *
 * The distinction is the whole point: an empty category has no lowest bid, so
 * entering it costs the floor. Anything else would let a listing in an
 * unrelated ranking set the price of a ranking nobody is in.
 */
/** The smallest bid in every ranking that has one, keyed by slug. */
export async function lowestByCategory(): Promise<Record<string, bigint>> {
  const rows = await query<{ slug: string; pico: string }>(
    `SELECT category_slug AS slug, MIN(total_pico)::TEXT AS pico
       FROM listings WHERE hidden = FALSE AND total_pico > 0
      GROUP BY category_slug`,
  );
  return Object.fromEntries(rows.map((r) => [r.slug, BigInt(r.pico)]));
}

export async function lowestBid(categorySlug?: string): Promise<bigint | null> {
  const row = await one<{ pico: string }>(
    `SELECT total_pico::TEXT AS pico FROM listings
      WHERE hidden = FALSE AND total_pico > 0
        AND ($1::TEXT IS NULL OR category_slug = $1)
      ORDER BY total_pico ASC LIMIT 1`,
    [categorySlug ?? null],
  );
  return row ? BigInt(row.pico) : null;
}

/**
 * Where an amount would land, and whose place it takes.
 *
 * The pay screen asks this so it can say what the money buys rather than how
 * the payment works: somebody looking at an invoice already knows they are
 * paying, and what they want to see is the position and the name in it.
 *
 * `exclude` is the listing being raised. Its old total is still on the board
 * and counting it would have a raise pass itself.
 */
export async function placementFor(
  bidPico: bigint,
  categorySlug: string,
  exclude?: string,
): Promise<{
  rank: number;
  categoryRank: number;
  passes: string | null;
  categoryName: string | null;
}> {
  const [overall, inCategory, cat] = await Promise.all([
    getLadder("all-time", undefined, 5000),
    getLadder("all-time", categorySlug, 5000),
    one<{ name: string }>("SELECT name FROM categories WHERE slug = $1", [categorySlug]),
  ]);
  const above = (rows: LadderStep[]) =>
    rows.filter((r) => r.key !== exclude && BigInt(r.pico) >= bidPico).length;

  const beaten = above(inCategory);
  // The one whose place this takes is the first below it, not the one above.
  const below = inCategory
    .filter((r) => r.key !== exclude)
    .find((r) => BigInt(r.pico) < bidPico);

  return {
    rank: above(overall) + 1,
    categoryRank: beaten + 1,
    passes: below?.display ?? null,
    categoryName: cat?.name ?? null,
  };
}
