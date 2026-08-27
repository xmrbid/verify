import { query } from "./db.ts";
import { wallet } from "./monero.ts";

/**
 * Receipts for bids.
 *
 * A row in this database saying "somebody paid 3.2 XMR" is worth exactly as
 * much as your trust in whoever runs the database, which should be none. A
 * Monero **InProof** replaces that trust with arithmetic: it is a signature
 * showing that transaction T paid a specific amount to a specific address,
 * and anyone can check it against any Monero node without asking us anything.
 *
 * The proof is made with the wallet's private **view** key. That is the whole
 * point of the split: the server can prove money arrived and still be unable
 * to move it, because a spend key never touches this machine.
 *
 * What a proof does not do is prove the board is not bidding on itself. No
 * signature can. That one is answered by publishing everything and letting
 * people read the pattern, which is why all of this is on a public page.
 */

export interface TxProof {
  txid: string;
  signature: string;
  /** Signed along with the proof, so it cannot be presented as another one. */
  message: string;
}

/** What the signature is bound to. Checking needs it byte for byte. */
export function proofMessage(invoiceId: string): string {
  return `xmrbid.lol invoice ${invoiceId}`;
}

/**
 * Signs a receipt for one settled payment and stores it.
 *
 * Called by the watcher after settlement, because the watcher is the only
 * component that talks to the wallet. Best effort: an unsigned payment is a
 * missing receipt, never a lost bid, and it can be signed again later.
 */
export async function proveInvoice(invoiceId: string): Promise<number> {
  const rows = await query<{
    subaddress: string;
    txids: string[];
    publish_proof: boolean;
  }>(
    `SELECT subaddress, txids, publish_proof FROM invoices
      WHERE id = $1 AND status = 'settled' AND proved_at IS NULL`,
    [invoiceId],
  );
  const row = rows[0];
  if (!row) return 0;

  // Asked not to be published: the signature is never made, rather than made
  // and withheld. There is then nothing here to leak or be compelled out of us.
  if (!row.publish_proof) {
    await query("UPDATE invoices SET proved_at = NOW() WHERE id = $1", [invoiceId]);
    return 0;
  }
  if (row.txids.length === 0) return 0;

  const w = wallet();
  const message = proofMessage(invoiceId);
  const proofs: TxProof[] = [];
  for (const txid of row.txids.slice(0, 8)) {
    const signature = await w
      .txProof(txid, row.subaddress, message)
      .catch(() => null);
    if (signature) proofs.push({ txid, signature, message });
  }

  // proved_at is set either way: a wallet that refused once will refuse again,
  // and a page that says "no receipt" is better than one that keeps retrying.
  await query(
    `UPDATE invoices SET proofs = $2::jsonb, proved_at = NOW() WHERE id = $1`,
    [invoiceId, JSON.stringify(proofs)],
  );
  return proofs.length;
}

export interface Receipt {
  invoiceId: string;
  /** What the money bought: a rank, or a decision on a proposed category. */
  purpose: "bid" | "category";
  what: string;
  href: string | null;
  amountPico: bigint;
  settledAt: Date;
  address: string;
  proofs: TxProof[];
  /** False when the payer asked for no public receipt. */
  published: boolean;
}

export async function getReceipt(invoiceId: string): Promise<Receipt | null> {
  const rows = await query<{
    id: string;
    purpose: "bid" | "category";
    display: string;
    paid_pico: string;
    settled_at: Date;
    subaddress: string;
    proofs: TxProof[];
    key: string | null;
    handle: string | null;
    slug: string | null;
    publish_proof: boolean;
  }>(
    `SELECT i.id, i.purpose, i.display, i.paid_pico::TEXT AS paid_pico,
            i.settled_at, i.subaddress, i.proofs, i.publish_proof,
            l.key, l.handle, c.slug
       FROM invoices i
       LEFT JOIN payments p ON p.invoice_id = i.id
       LEFT JOIN listings l ON l.id = p.listing_id
       LEFT JOIN category_proposals c ON c.id = i.proposal_id
      WHERE i.id = $1 AND i.status = 'settled'`,
    [invoiceId],
  );
  const r = rows[0];
  if (!r) return null;

  const href =
    r.purpose === "category"
      ? "/decisions"
      : r.handle
        ? `/@${r.handle}`
        : r.key
          ? `/product/${encodeURIComponent(r.key)}`
          : null;

  return {
    invoiceId: r.id,
    purpose: r.purpose,
    what: r.display,
    href,
    amountPico: BigInt(r.paid_pico),
    settledAt: r.settled_at,
    address: r.subaddress,
    proofs: r.proofs ?? [],
    published: r.publish_proof,
  };
}

/** Every receipt for one listing, newest first, for its own page. */
export async function receiptsFor(listingId: number): Promise<
  { invoiceId: string; amountPico: bigint; settledAt: Date; proven: boolean }[]
> {
  const rows = await query<{
    invoice_id: string;
    amount_pico: string;
    settled_at: Date;
    proven: boolean;
  }>(
    `SELECT p.invoice_id, p.amount_pico::TEXT AS amount_pico, p.settled_at,
            jsonb_array_length(i.proofs) > 0 AS proven
       FROM payments p JOIN invoices i ON i.id = p.invoice_id
      WHERE p.listing_id = $1
      ORDER BY p.settled_at DESC LIMIT 12`,
    [listingId],
  );
  return rows.map((r) => ({
    invoiceId: r.invoice_id,
    amountPico: BigInt(r.amount_pico),
    settledAt: r.settled_at,
    proven: r.proven,
  }));
}

export interface LedgerRow {
  invoiceId: string;
  purpose: "bid" | "category";
  what: string;
  href: string | null;
  /** Where that listing stands now, which is what the money was buying. */
  rank: number | null;
  categoryRank: number | null;
  categoryName: string | null;
  amountPico: bigint;
  settledAt: Date;
  /** Has a signature anybody can check. */
  proven: boolean;
  /** The payer asked for no public receipt. */
  withheld: boolean;
}

/**
 * Everything that has settled, newest first.
 *
 * Published as one list because a total is a claim and a list is evidence. A
 * board that shows "24.8 XMR paid" and nothing else is asking to be believed;
 * this one shows the payments the number is made of and lets anybody add them
 * up, then check each one against the chain.
 */
export async function ledger(limit = 50, offset = 0): Promise<{
  rows: LedgerRow[];
  total: number;
  paidPico: bigint;
  provenCount: number;
  /** Payers who declined a public receipt. Not a failure to sign. */
  withheldCount: number;
}> {
  const [rows, [summary]] = await Promise.all([
    query<{
      id: string;
      purpose: "bid" | "category";
      display: string;
      paid_pico: string;
      settled_at: Date;
      proven: boolean;
      publish_proof: boolean;
      key: string | null;
      handle: string | null;
      rank: string | null;
      category_rank: string | null;
      category_name: string | null;
    }>(
      // The rank is computed here rather than stored on the payment: a bid buys
      // a position that other people then bid past, and the useful number is
      // where the listing stands now, not where it briefly stood in April.
      `SELECT i.id, i.purpose, i.display, i.paid_pico::TEXT AS paid_pico,
              i.settled_at, jsonb_array_length(i.proofs) > 0 AS proven,
              i.publish_proof, l.key, l.handle, c.name AS category_name,
              r.rank::TEXT AS rank, r.category_rank::TEXT AS category_rank
         FROM invoices i
         LEFT JOIN payments p ON p.invoice_id = i.id
         LEFT JOIN listings l ON l.id = p.listing_id AND l.hidden = FALSE
         LEFT JOIN categories c ON c.slug = l.category_slug
         LEFT JOIN (
           SELECT id,
                  ROW_NUMBER() OVER (ORDER BY total_pico DESC, first_bid_at) AS rank,
                  ROW_NUMBER() OVER (PARTITION BY category_slug
                                     ORDER BY total_pico DESC, first_bid_at) AS category_rank
             FROM listings WHERE hidden = FALSE
         ) r ON r.id = l.id
        WHERE i.status = 'settled'
        ORDER BY i.settled_at DESC
        LIMIT $1 OFFSET $2`,
      [limit, offset],
    ),
    query<{ n: string; paid: string; proven: string; withheld: string }>(
      `SELECT count(*)::TEXT AS n,
              COALESCE(SUM(paid_pico), 0)::TEXT AS paid,
              count(*) FILTER (WHERE jsonb_array_length(proofs) > 0)::TEXT AS proven,
              count(*) FILTER (WHERE NOT publish_proof)::TEXT AS withheld
         FROM invoices WHERE status = 'settled'`,
    ),
  ]);

  return {
    rows: rows.map((r) => ({
      invoiceId: r.id,
      purpose: r.purpose,
      what: r.display,
      href:
        r.purpose === "category"
          ? "/decisions"
          : r.handle
            ? `/@${r.handle}`
            : r.key
              ? `/product/${encodeURIComponent(r.key)}`
              : null,
      rank: r.rank ? Number(r.rank) : null,
      categoryRank: r.category_rank ? Number(r.category_rank) : null,
      categoryName: r.category_name,
      amountPico: BigInt(r.paid_pico),
      settledAt: r.settled_at,
      proven: r.proven,
      withheld: !r.publish_proof,
    })),
    total: Number(summary?.n ?? 0),
    paidPico: BigInt(summary?.paid ?? 0),
    provenCount: Number(summary?.proven ?? 0),
    withheldCount: Number(summary?.withheld ?? 0),
  };
}
