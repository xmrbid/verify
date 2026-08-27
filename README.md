# Checking xmrbid.lol

A board that publishes its own numbers is a board with one witness. This is the
second one. It is a single file, it has no dependencies, and it does not ask
xmrbid.lol to confirm anything xmrbid.lol said.

```
node verify.mjs
node verify.mjs --daemon http://127.0.0.1:18081
```

The first command checks the site against itself. The second checks it against
Monero, using whatever node you point it at. Node 18 or newer, because it uses
`fetch`. Nothing else.

## What it checks

**The hash chain.** Every finished day is sealed into a link that carries the
previous day's hash, so editing an old figure changes every hash after it. The
rule is `sha256(prev_hash + "\n" + payload)` and the script recomputes all of it
from the published payloads rather than importing anything. If a day was edited,
the recomputed hash stops matching there and the script names the day.

**Every piconero of rank.** A place on the board is bought. The site publishes
its listings and the payments behind them, and the script adds both sides up
independently, in total and listing by listing. A listing holding more than its
payments is a rank that was granted rather than paid for. That is the failure
this exists to make visible.

**Every receipt, against the chain.** Each settled payment carries a Monero
InProof. With `--daemon`, the script sends each one to `check_tx_proof` on your
node and compares the amount the chain reports against the amount the board
claims. This is the part the board cannot influence: if a payment were invented,
this is where it stops being a story.

**Clicks, for consistency only.** The count on the listings can never exceed the
count of clicks sent. That is an arithmetic check, not evidence, and the script
says so.

## What it cannot check, and neither can anything else

**Whether the board bids on itself.** No signature can settle this. Monero
carries no sender, so a payment from the operator and a payment from a stranger
are the same object on the chain. Every row is published one at a time so the
pattern is there to look at. That is not proof. It is what there is.

**Whether a figure was right when it was recorded.** A hash chain preserves a
wrong number exactly as faithfully as a right one. It proves nobody went back
and changed it, which is a smaller claim than it sounds like and is still worth
making.

**Anything about visits beyond the count.** Nobody can prove how many requests a
server answered. The board counts events and keeps no row per visit and no
identifier, which means there is nothing to audit and nothing to leak. Check the
clicks against your own logs using the `utm_source` on every outbound link. Your
logs are a better witness than ours.

## The rules, as code

`rules/` holds the files that decide the things worth arguing about, copied from
the site unchanged:

| File | What it decides |
|---|---|
| `money.ts` | the floor, the step, what it costs to take a place, all in piconero as `bigint` because a rounding error would move somebody's rank |
| `board.ts` | ranking, ties, and what a given bid would buy |
| `bids.ts` | what an invoice is and what settlement does, including that a raise is charged the difference and never the whole amount again |
| `chain.ts` | the daily seal and the hash rule |
| `proofs.ts` | how a receipt is produced and what it commits to |
| `monero.ts` | the wallet calls, which are view-only |
| `counters.ts` | what a view is and what a click is |

They are here to be read and disagreed with. They are not the deployment, and
publishing them is not a claim that the running server is compiled from exactly
these bytes. Nobody can demonstrate that from outside, and a repository that
implied otherwise would be doing the thing this whole board is against. What the
verifier checks is the output, which is the part that does not require trusting
anybody.

## If a check fails

Say so publicly. That is the entire point of publishing this. The site's contact
details are on xmrbid.lol/about, and a failing check posted somewhere we cannot
edit is worth more than one sent to us privately.
