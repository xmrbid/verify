import type { PoolClient } from "pg";
import { one, query, tx } from "./db.ts";
import {
  AmountError,
  BID_STEP,
  MIN_BID,
  assertValidBid,
  entryPrice,
  raiseFloor,
  formatXmr,
  parseXmr,
} from "./money.ts";
import { lowestBid } from "./board.ts";
import { cleanBlock, cleanText, parseTarget, TargetError } from "./target.ts";
import { parseHandle, parseLinks, type ProfileLinks } from "./handle.ts";
import { hashToken, newClaimToken, newInvoiceId, tokenMatches } from "./tokens.ts";
import { launchGate } from "./launch.ts";
import { readTicket } from "./tickets.ts";
import { HandleError } from "./handle.ts";
import { REQUIRED_CONFIRMATIONS, wallet } from "./monero.ts";
import { announce } from "./indexnow.ts";
import { captureIcon } from "./icon.ts";

/** An unpaid invoice holds no rank, so it does not need to live long. */
const INVOICE_TTL_MINUTES = Number(process.env.INVOICE_TTL_MINUTES ?? 120);

export { AmountError, TargetError };

export interface BidInput {
  target: string;
  categorySlug: string;
  display: string;
  tagline: string;
  /** The long write-up shown on the listing's own page. */
  description: string;
  amount: string;
  claimToken?: string;
  /** Everything the listing's own page will show, collected up front. */
  handle?: string;
  /** A logo, for when the listed thing has no icon this server can reach. */
  iconUrl?: string;
  /** False to settle without publishing a verifiable receipt for the payment. */
  publishProof?: boolean;
  /**
   * A manage ticket, which proves ownership of exactly one listing without the
   * claim token travelling again. What the raise form on /manage sends.
   */
  manageTicket?: string;
  links?: Partial<Record<"x" | "code" | "onion" | "nostr" | "matrix", string>>;
}

export interface CreatedInvoice {
  id: string;
  address: string;
  amountPico: bigint;
  bidPico: bigint;
  isNewListing: boolean;
  /** Returned exactly once, at creation. Only its hash is ever stored. */
  claimToken?: string;
}

export async function createInvoice(input: BidInput): Promise<CreatedInvoice> {
  const target = parseTarget(input.target);
  const bidPico = parseXmr(input.amount);
  assertValidBid(bidPico);

  const category = await one<{ slug: string }>(
    "SELECT slug FROM categories WHERE slug = $1",
    [input.categorySlug],
  );
  if (!category) throw new TargetError("Pick a category.");

  const existing = await one<{
    id: string;
    total_pico: string;
    display: string;
    tagline: string;
    description: string;
    category_slug: string;
    claim_token_hash: string;
  }>(
    `SELECT id, total_pico, display, tagline, description, category_slug, claim_token_hash
     FROM listings WHERE key = $1`,
    [target.key],
  );

  const isNewListing = !existing;
  let amountPico: bigint;
  let display = cleanText(input.display, 90);
  let tagline = cleanText(input.tagline, 200);
  let description = cleanBlock(input.description, 1500);
  let categorySlug = input.categorySlug;
  let ownerProven = false;

  // Validated now so a bad handle or link is a form error, not a surprise
  // twenty minutes after the payment settles. The form marks the handle
  // required; this is the check that actually enforces it, because a form
  // attribute is a suggestion to whoever is not using the form.
  const links: ProfileLinks = parseLinks(input.links ?? {});

  // A logo for the case the automatic capture comes back empty. Only the
  // address is kept: the image itself is fetched by this server at settlement,
  // so an invoice nobody pays cannot leave a file behind.
  let iconUrl = "";
  const rawIcon = input.iconUrl?.trim() ?? "";
  if (rawIcon) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(/^https?:\/\//i.test(rawIcon) ? rawIcon : `https://${rawIcon}`);
    } catch {
      parsed = null;
    }
    if (!parsed || parsed.protocol !== "https:") {
      throw new TargetError("The logo has to be an https image address.");
    }
    if (/\.svgz?$/i.test(parsed.pathname)) {
      throw new TargetError("SVG logos are not accepted. Use PNG, JPG or WebP.");
    }
    iconUrl = parsed.toString().slice(0, 400);
  }
  const rawHandle = input.handle?.trim() ?? "";
  if (!existing && !rawHandle) {
    throw new HandleError("Pick a handle for your listing.");
  }
  const handle: string | null = rawHandle ? parseHandle(rawHandle) : null;
  if (handle) {
    const taken = await one<{ id: string }>(
      "SELECT id FROM listings WHERE handle = $1 AND key <> $2",
      [handle, target.key],
    );
    if (taken) throw new TargetError(`@${handle} is already taken.`);
  }

  if (existing) {
    const currentTotal = BigInt(existing.total_pico);
    // A raise adds at least a tenth of what is already held, so moving up the
    // board is a decision rather than a keystroke.
    const floor = raiseFloor(currentTotal);
    if (bidPico < floor) {
      throw new AmountError(
        `${target.key} holds ${formatXmr(currentTotal)} XMR. A raise adds at ` +
          `least a tenth of that, so the next total is ${formatXmr(floor)} XMR.`,
      );
    }
    // Only the difference is charged, the rank already paid for stays paid for.
    amountPico = bidPico - currentTotal;

    // Either the token itself, or a manage ticket that was minted from it and
    // names this listing. The ticket exists so the token does not have to
    // travel a second time, and a raise started from /manage is exactly that.
    const byToken =
      !!input.claimToken && tokenMatches(input.claimToken, existing.claim_token_hash);
    const byTicket =
      !!input.manageTicket && readTicket(input.manageTicket) === Number(existing.id);
    ownerProven = byToken || byTicket;
    if (!ownerProven) {
      throw new TargetError(
        `${target.key} is already on the board. Only its owner can raise it, ` +
          "from Manage a listing or with the claim token from their invoice.",
      );
    }
  } else {
    // One floor for everybody. What other listings are paying does not change
    // what it costs to join: an empty place at the bottom is worth the floor
    // whoever is above it.
    if (bidPico < MIN_BID) {
      throw new AmountError(`New listings start at ${formatXmr(MIN_BID)} XMR.`);
    }
    if (!display) throw new TargetError("Give the listing a name.");
    amountPico = bidPico;
  }

  // Checked here rather than only in the page, because this is the one
  // function that turns a form into a request for money.
  const gate = launchGate();
  if (!gate.open) throw new AmountError(gate.reason ?? "Not taking bids yet.");

  const claimToken = newClaimToken();
  const id = newInvoiceId();
  const sub = await wallet().createSubaddress(`xmrbid:${id}`);

  await query(
    `INSERT INTO invoices (
       id, listing_key, kind, target_url, display, tagline, category_slug,
       amount_pico, bid_pico, subaddress, subaddress_index,
       claim_token_hash, new_claim_token_hash, links, handle, description,
       icon_url, publish_proof, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$15,$16,$17,$18,$19,
               NOW() + ($14 || ' minutes')::INTERVAL)`,
    [
      id,
      target.key,
      target.kind,
      target.url,
      display,
      tagline,
      categorySlug,
      amountPico.toString(),
      bidPico.toString(),
      sub.address,
      sub.index,
      input.claimToken && ownerProven ? hashToken(input.claimToken) : null,
      hashToken(claimToken),
      String(INVOICE_TTL_MINUTES),
      JSON.stringify(links),
      handle,
      description,
      iconUrl,
      input.publishProof !== false,
    ],
  );

  return {
    id,
    address: sub.address,
    amountPico,
    bidPico,
    isNewListing,
    // A raise on an existing listing does not mint a new owner token.
    claimToken: isNewListing ? claimToken : undefined,
  };
}

export interface InvoiceView {
  id: string;
  listingKey: string;
  display: string;
  targetUrl: string;
  amountPico: bigint;
  bidPico: bigint;
  paidPico: bigint;
  address: string;
  status: "pending" | "seen" | "settled" | "expired";
  confirmations: number;
  requiredConfirmations: number;
  expiresAt: Date;
  settledAt: Date | null;
  /**
   * False when this invoice minted a claim token that another bid got to the
   * listing with first. The rank is still bought; the token just owns nothing.
   */
  claimTokenOwnsListing: boolean;
  /** 'category' invoices buy a decision on a proposed category, not a rank. */
  purpose: "bid" | "category";
  /** Which ranking this bid lands in, so the page can say where. */
  categorySlug: string;
}

export async function getInvoice(id: string): Promise<InvoiceView | null> {
  const row = await one<{
    id: string;
    listing_key: string;
    display: string;
    target_url: string;
    amount_pico: string;
    bid_pico: string;
    paid_pico: string;
    subaddress: string;
    status: InvoiceView["status"];
    category_slug: string;
    confirmations: number;
    expires_at: Date;
    settled_at: Date | null;
    token_owns: boolean;
    purpose: string;
  }>(
    `SELECT i.*, COALESCE(
       (SELECT l.claim_token_hash = i.new_claim_token_hash
        FROM listings l WHERE l.key = i.listing_key),
       TRUE
     ) AS token_owns
     FROM invoices i WHERE i.id = $1`,
    [id],
  );
  if (!row) return null;
  return {
    id: row.id,
    listingKey: row.listing_key,
    display: row.display,
    targetUrl: row.target_url,
    amountPico: BigInt(row.amount_pico),
    bidPico: BigInt(row.bid_pico),
    paidPico: BigInt(row.paid_pico),
    address: row.subaddress,
    status: row.status,
    confirmations: row.confirmations,
    requiredConfirmations: REQUIRED_CONFIRMATIONS,
    expiresAt: row.expires_at,
    settledAt: row.settled_at,
    claimTokenOwnsListing: row.token_owns,
    purpose: (row.purpose ?? "bid") as "bid" | "category",
    categorySlug: row.category_slug,
  };
}

/**
 * Applies a confirmed payment to the board. Runs SERIALIZABLE because two
 * invoices for the same listing key can settle at the same moment.
 *
 * The credited amount is what actually arrived, not what was quoted, an
 * overpayment counts in full, and a stale quote can never lower a total.
 */
export async function settleInvoice(id: string): Promise<boolean> {
  return tx(async (c: PoolClient) => {
    const { rows } = await c.query(
      `SELECT * FROM invoices WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const inv = rows[0];
    /* An expired invoice still settles. Its subaddress belongs to this board
       and is never reused, so money that arrived late is money that arrived,
       and the rank it bought is the rank it bought. Only a payment already
       applied is refused. */
    if (!inv || inv.status === "settled") return false;

    // A category proposal buys a decision, not a rank, so it creates no
    // listing and adds nothing to the board's volume. All it does is make the
    // proposal visible on the public page for anybody to read and argue with.
    if (inv.purpose === "category") {
      await c.query(
        `UPDATE category_proposals
            SET status = 'pending', paid_pico = $2, paid_at = NOW()
          WHERE id = $1 AND status = 'unpaid'`,
        [inv.proposal_id, inv.paid_pico],
      );
      await c.query(
        `UPDATE invoices SET status = 'settled', settled_at = NOW() WHERE id = $1`,
        [id],
      );
      return true;
    }

    const credited = BigInt(inv.paid_pico);
    if (credited <= 0n) return false;

    const listing = await c.query(
      `INSERT INTO listings (
         key, kind, target_url, display, tagline, category_slug,
         total_pico, first_bid_at, claim_token_hash, links, description
       ) VALUES ($1,$2,$3,$4,$5,$6,$7, NOW(), $8, $10, $11)
       ON CONFLICT (key) DO UPDATE SET
         total_pico = listings.total_pico + EXCLUDED.total_pico,
         first_bid_at = COALESCE(listings.first_bid_at, NOW()),
         -- Metadata only moves when the bidder proved ownership.
         display = CASE WHEN $9::BOOLEAN THEN EXCLUDED.display ELSE listings.display END,
         tagline = CASE WHEN $9::BOOLEAN THEN EXCLUDED.tagline ELSE listings.tagline END,
         description = CASE WHEN $9::BOOLEAN THEN EXCLUDED.description ELSE listings.description END,
         category_slug = CASE WHEN $9::BOOLEAN THEN EXCLUDED.category_slug ELSE listings.category_slug END,
         links = CASE WHEN $9::BOOLEAN THEN EXCLUDED.links ELSE listings.links END
       RETURNING id`,
      [
        inv.listing_key,
        inv.kind,
        inv.target_url,
        inv.display,
        inv.tagline,
        inv.category_slug,
        credited.toString(),
        inv.new_claim_token_hash,
        inv.claim_token_hash !== null,
        inv.links ?? {},
        inv.description ?? "",
      ],
    );

    const listingId = listing.rows[0].id;

    // The handle was free when the invoice was made; somebody may have taken it
    // while the payment confirmed. Losing the race costs the handle, never the
    // rank, the listing goes live either way and the owner can pick another.
    if (inv.handle) {
      await c.query(
        `UPDATE listings SET handle = $2
         WHERE id = $1
           AND NOT EXISTS (SELECT 1 FROM listings o WHERE o.handle = $2 AND o.id <> $1)`,
        [listingId, inv.handle],
      );
    }
    await c.query(
      `INSERT INTO payments (invoice_id, listing_id, amount_pico)
       VALUES ($1, $2, $3)`,
      [id, listingId, credited.toString()],
    );
    await c.query(
      `UPDATE invoices SET status = 'settled', settled_at = NOW() WHERE id = $1`,
      [id],
    );

    // Fire and forget: the rank is already claimed, and a site that is slow or
    // down just keeps its monogram.
    void captureIcon(Number(listingId), inv.icon_url ?? "").catch(() => {});

    // The board just changed, so the engines that accept being told are told.
    // Google is not among them and this is not a substitute for being crawled;
    // it is what makes a new listing findable in Bing, and through Bing in
    // DuckDuckGo, in minutes rather than whenever a crawler next passes.
    const base = (process.env.SITE_URL ?? "").replace(/\/$/, "");
    if (base) {
      announce([
        `${base}/`,
        `${base}/today`,
        `${base}/category/${inv.category_slug}`,
        inv.handle
          ? `${base}/@${inv.handle}`
          : `${base}/product/${encodeURIComponent(inv.listing_key)}`,
      ]);
    }
    return true;
  });
}
