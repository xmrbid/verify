#!/usr/bin/env node
/**
 * Checks xmrbid.lol against itself, and against Monero.
 *
 *   node verify.mjs
 *   node verify.mjs --daemon http://127.0.0.1:18081
 *
 * Nothing here trusts the board. It reads two public files, recomputes every
 * hash by hand, adds the published rows up, and then asks a Monero node you
 * choose whether the receipts are real. The board is not asked to confirm any
 * of it, which is the whole point: a number a site vouches for is a number
 * with one witness.
 *
 * No dependencies. Node 18 or newer, because it uses fetch.
 *
 * What it can prove
 *   - the hash chain over the daily figures is intact and ends where the board
 *     says it ends
 *   - every piconero of rank on the board has a payment behind it, listing
 *     by listing
 *   - every receipt is a real Monero transaction that paid the stated amount
 *     to the stated address, according to a node that is not the board's
 *
 * What it cannot prove, and neither can anything else
 *   - that the board is not bidding on itself. No signature can: Monero
 *     carries no sender, so a payment from the operator and a payment from a
 *     stranger are the same object. The rows are published one at a time so
 *     the pattern can be looked at, which is not proof and is what there is.
 *   - that a figure was right when it was recorded. A chain preserves a wrong
 *     number as faithfully as a right one.
 *   - anything about visits beyond the count. Nobody can prove how many
 *     requests a server answered.
 */

import { createHash } from "node:crypto";
import { argv, exit } from "node:process";

const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const SITE = arg("site", "https://xmrbid.lol").replace(/\/$/, "");
const DAEMON = arg("daemon", null);
const LIMIT = Number(arg("limit", "0")) || Infinity;

const ok = (m) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const bad = (m) => console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
const meh = (m) => console.log(`  \x1b[33mSKIP\x1b[0m  ${m}`);
const head = (m) => console.log(`\n${m}`);

let failures = 0;
const fail = (m) => {
  failures++;
  bad(m);
};

async function getJson(path) {
  const res = await fetch(`${SITE}${path}`, {
    headers: { "User-Agent": "xmrbid-verify" },
  });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

/**
 * The chain rule, written out so it can be read rather than imported:
 *
 *   hash = sha256( previous hash + "\n" + payload )
 *
 * `payload` is the exact string the board publishes, byte for byte. It is not
 * re-encoded here, because re-encoding is where a verifier starts agreeing
 * with itself instead of with the data.
 */
const linkHash = (prev, payload) =>
  createHash("sha256").update(`${prev}\n${payload}`).digest("hex");

const GENESIS = "0".repeat(64);

async function checkChain() {
  head("The chain over the daily figures");
  const chain = await getJson("/stats/chain.json");

  if (chain.starts) {
    console.log(`        record starts ${chain.starts}, ${chain.length} days sealed`);
  } else {
    console.log(`        ${chain.length} days sealed`);
  }

  if (chain.length === 0) {
    meh("nothing sealed yet, so there is nothing here to check");
    return chain;
  }

  let prev = GENESIS;
  let broken = null;
  for (const link of chain.links) {
    if (link.prev_hash !== prev) {
      broken = `${link.day}: prev_hash does not match the day before it`;
      break;
    }
    const computed = linkHash(prev, link.payload);
    if (computed !== link.hash) {
      broken = `${link.day}: recomputed ${computed.slice(0, 16)}…, published ${link.hash.slice(0, 16)}…`;
      break;
    }
    prev = link.hash;
  }

  if (broken) fail(`the chain breaks at ${broken}`);
  else ok(`${chain.links.length} links recomputed, every one matches`);

  if (chain.head && chain.head !== prev) {
    fail(`the published head is not the end of the chain it published`);
  } else if (chain.head) {
    ok(`the head is the last link: ${chain.head.slice(0, 16)}…`);
  }

  // Days should be consecutive. A gap is not proof of anything, but it is the
  // shape a removed day leaves and it should be said out loud.
  const days = chain.links.map((l) => l.day);
  const gaps = [];
  for (let i = 1; i < days.length; i++) {
    const a = Date.parse(`${days[i - 1]}T00:00:00Z`);
    const b = Date.parse(`${days[i]}T00:00:00Z`);
    const span = Math.round((b - a) / 86400000);
    if (span !== 1) gaps.push(`${days[i - 1]} to ${days[i]}`);
  }
  if (gaps.length) console.log(`        gaps in the days sealed: ${gaps.join(", ")}`);

  return chain;
}

async function checkTotals() {
  head("The published totals against the published rows");
  const stats = await getJson("/stats.json");

  /* The one that matters.
     A rank on this board is bought, so every piconero a listing holds has to
     have a payment behind it. The board publishes both sides and this adds
     them up independently. A listing whose total exceeds its payments is a
     rank that was granted rather than paid for, which is the failure this
     whole exercise exists to make visible. */
  const claimed = BigInt(stats.totals.paid_piconero);
  const ledger = stats.totals.payments_piconero
    ? BigInt(stats.totals.payments_piconero)
    : null;

  if (ledger === null) {
    meh("this board does not publish its payment total, so it cannot be reconciled");
  } else if (ledger === claimed) {
    ok(
      `${fmt(claimed)} XMR on the board, ${fmt(ledger)} XMR in payments, across ` +
        `${stats.totals.payments_count} of them. Every piconero is paid for.`,
    );
  } else if (claimed > ledger) {
    fail(
      `the board holds ${fmt(claimed)} XMR but only ${fmt(ledger)} XMR was ever paid. ` +
        `${fmt(claimed - ledger)} XMR of rank has no payment behind it.`,
    );
  } else {
    fail(
      `${fmt(ledger)} XMR was paid but the board only shows ${fmt(claimed)} XMR. ` +
        `${fmt(ledger - claimed)} XMR bought nothing that is visible.`,
    );
  }

  /* Per listing, over whatever slice of the payments is published. Truncation
     is stated rather than worked around, because a check over an unknown
     subset that calls itself complete is worse than no check. */
  const byListing = new Map();
  for (const p of stats.payments) {
    byListing.set(p.listing, (byListing.get(p.listing) ?? 0n) + BigInt(p.paid_piconero));
  }
  const covered = stats.listings.filter((l) => byListing.has(l.key));
  const off = covered.filter((l) => byListing.get(l.key) !== BigInt(l.paid_piconero));
  if (stats.payments_truncated) {
    console.log(
      `        the payment list is capped, so ${covered.length} of ${stats.listings.length} listings can be checked one by one`,
    );
  }
  if (off.length > 0) {
    for (const l of off) {
      fail(
        `${l.key}: holds ${fmt(l.paid_piconero)} XMR, its payments add up to ${fmt(byListing.get(l.key))} XMR`,
      );
    }
  } else if (covered.length > 0) {
    ok(`${covered.length} listings check out one by one against their payments`);
  }

  /* Clicks. The board publishes the record and the column separately, and the
     column can never be the larger of the two. */
  const onBoard = stats.listings.reduce((a, l) => a + Number(l.clicks), 0);
  const stated = Number(stats.totals.clicks_on_board ?? onBoard);
  const sent = Number(stats.totals.clicks_sent);
  if (onBoard !== stated) {
    fail(`the board says ${stated} clicks across its listings, the rows show ${onBoard}`);
  } else if (onBoard > sent) {
    fail(
      `the listings account for ${onBoard} clicks out of ${sent} sent. A click cannot be sent to a listing without being sent.`,
    );
  } else {
    ok(
      `${onBoard.toLocaleString("en-US")} of ${sent.toLocaleString("en-US")} clicks sit on listings still on the board`,
    );
    if (onBoard < sent) {
      console.log(
        `        the rest went to listings that have since been hidden. A click`,
      );
      console.log(`        is counted when it happens and never taken back.`);
    }
  }

  const withProof = stats.payments.filter((p) => p.proofs.length > 0).length;
  console.log(
    `        ${withProof} of ${stats.payments.length} payments carry a receipt` +
      (withProof < stats.payments.length
        ? `, the rest were sent by payers who declined one`
        : ""),
  );
  return stats;
}

/**
 * The part the board cannot influence.
 *
 * `check_tx_proof` is answered by whatever node you point this at, reading the
 * Monero blockchain. If the board invented a payment, this is where it stops
 * being a story.
 */
async function checkReceipts(stats) {
  head("The receipts, against a Monero node");
  if (!DAEMON) {
    meh("no --daemon given, so nothing was checked against the chain");
    console.log(`        run a node and pass it, or use one you already trust:`);
    console.log(`        node verify.mjs --daemon http://127.0.0.1:18081`);
    return;
  }

  const rows = stats.payments.filter((p) => p.proofs.length > 0).slice(0, LIMIT);
  if (rows.length === 0) {
    meh("no published receipts to check");
    return;
  }

  let checked = 0;
  for (const p of rows) {
    for (const proof of p.proofs) {
      let body;
      try {
        const res = await fetch(`${DAEMON.replace(/\/$/, "")}/json_rpc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "0",
            method: "check_tx_proof",
            params: {
              txid: proof.txid,
              address: p.paid_to,
              message: proof.message ?? "",
              signature: proof.signature,
            },
          }),
        });
        body = await res.json();
      } catch (err) {
        fail(`${p.invoice}: could not reach the node (${err.message})`);
        continue;
      }

      if (body.error) {
        fail(`${p.invoice}: the node refused the proof (${body.error.message})`);
        continue;
      }
      const r = body.result ?? {};
      if (!r.good) {
        fail(`${p.invoice}: the node says the signature is not good`);
        continue;
      }
      const received = BigInt(r.received ?? 0);
      const claimed = BigInt(p.paid_piconero);
      if (received !== claimed) {
        fail(
          `${p.invoice}: the board says ${fmt(claimed)} XMR, the chain says ${fmt(received)} XMR`,
        );
        continue;
      }
      checked++;
    }
  }
  if (checked > 0) {
    ok(`${checked} receipt${checked === 1 ? "" : "s"} confirmed by the chain, amounts match`);
  }
}

function fmt(pico) {
  const s = (Number(pico) / 1e12).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
}

async function main() {
  console.log(`\nChecking ${SITE}`);
  console.log(`Nothing below asks the board to confirm anything it published.`);

  try {
    await checkChain();
    const stats = await checkTotals();
    await checkReceipts(stats);
  } catch (err) {
    console.log(`\n  \x1b[31mERROR\x1b[0m ${err.message}\n`);
    exit(2);
  }

  head("What none of this can show");
  console.log("        That the board is not bidding on itself. Monero carries");
  console.log("        no sender, so a payment from the operator and one from a");
  console.log("        stranger are the same object. The rows are published one");
  console.log("        at a time so the pattern can be looked at. That is not a");
  console.log("        proof and it is what there is.");
  console.log("");
  console.log("        That a figure was right when it was recorded. A chain");
  console.log("        preserves a wrong number as faithfully as a right one.");

  console.log(
    failures === 0
      ? `\n\x1b[32mEverything checkable checked out.\x1b[0m\n`
      : `\n\x1b[31m${failures} check${failures === 1 ? "" : "s"} failed.\x1b[0m\n`,
  );
  exit(failures === 0 ? 0 : 1);
}

main();
