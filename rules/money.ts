/**
 * Monero amounts are handled as piconero (atomic units) in bigint form
 * everywhere. Nothing in this file may produce a float, a rounding error
 * would silently change someone's rank.
 */
export const PICO = 1_000_000_000_000n; // 1 XMR

/**
 * New listings start here.
 *
 * Roughly $25 at the rate this was set at, which floats with the market: the
 * board is denominated in XMR and does not chase a dollar figure.
 */
/**
 * The floor, and the only floor. Anybody may bid anything at or above it, and
 * what everybody else is paying does not change what it costs to join: an
 * empty place at the bottom of the board is worth this much whoever is above
 * it.
 */
export const MIN_BID = (PICO * 6n) / 100n; // 0.06 XMR
/** Bids move in whole steps of this size. */
/**
 * Bids move in whole steps of this size, and passing anybody costs one step.
 *
 * It was a tenth of this, with a separate and larger margin for taking first
 * place. Two numbers for one question, and they disagreed on screen: the board
 * offered to pass the leader for 0.061 in one place and asked 0.07 for the
 * same position in another. Worse, the larger of the two was published on the
 * rules page and enforced nowhere, so the board was quoting a price its own
 * code would not have insisted on.
 *
 * One step settles both. At a thousandth a leader could be passed for a
 * fraction of a per cent, which invites being passed back for another
 * fraction, and a board where first place turns over for pennies is a board
 * whose ordering means nothing. At a hundredth, passing somebody costs
 * something, and there is one number to publish rather than two to reconcile.
 */
export const BID_STEP = PICO / 100n; // 0.01 XMR
/**
 * There is no maximum bid. This is the guard that keeps a typo from
 * overflowing a BIGINT column, not a rule: piconero is stored as BIGINT, which
 * tops out near 9.2 million XMR, and a ceiling three orders of magnitude below
 * that is unreachable by any real bid while still being safe to add to.
 */
export const BID_CEILING = 100_000n * PICO;

export class AmountError extends Error {}

/** Parses a user-typed decimal XMR string into piconero. Exact, never lossy. */
export function parseXmr(input: string): bigint {
  const raw = input.trim().replace(/,/g, ".");
  if (!/^\d{1,6}(\.\d{1,12})?$/.test(raw)) {
    throw new AmountError("Enter an amount in XMR, e.g. 0.05");
  }
  const [whole, frac = ""] = raw.split(".");
  const padded = (frac + "000000000000").slice(0, 12);
  return BigInt(whole) * PICO + BigInt(padded);
}

/** "12.5", "0.01", "100", trailing zeros trimmed, never scientific notation. */
export function formatXmr(pico: bigint): string {
  const negative = pico < 0n;
  const abs = negative ? -pico : pico;
  const whole = abs / PICO;
  const frac = (abs % PICO).toString().padStart(12, "0").replace(/0+$/, "");
  const body = frac ? `${whole}.${frac}` : whole.toString();
  return negative ? `-${body}` : body;
}

/**
 * The same amount, rounded to the nearest BID_STEP for display.
 *
 * An average or a median lands on arbitrary piconero, and "0.507222222222 XMR"
 * in a summary tile is twelve digits of noise around one useful figure. Bids
 * themselves are never rounded; this is only for numbers the board computed
 * rather than received.
 */
export function formatXmrRough(pico: bigint): string {
  const half = BID_STEP / 2n;
  return formatXmr(((pico + half) / BID_STEP) * BID_STEP);
}

/** Rounds up to the next whole BID_STEP so every bid on the board is clean. */
export function roundUpToStep(pico: bigint): bigint {
  const rem = pico % BID_STEP;
  return rem === 0n ? pico : pico + (BID_STEP - rem);
}

/**
 * A raise has to add at least a tenth of what the listing already holds.
 *
 * Without it the board turns into a game of adding a thousandth at a time:
 * cheap to do, endless, and it makes every rank look one keystroke away from
 * changing. A tenth is enough that moving up is a decision, and it scales, so
 * the rule costs a 0.06 listing six thousandths and a 3 XMR listing three
 * tenths rather than blocking the small ones to discipline the large.
 */
export const RAISE_DIVISOR = 10n; // a tenth

export function minRaise(currentPico: bigint): bigint {
  if (currentPico <= 0n) return BID_STEP;
  const tenth = roundUpToStep(currentPico / RAISE_DIVISOR);
  return tenth < BID_STEP ? BID_STEP : tenth;
}

/** The smallest total a raise on `currentPico` may settle at. */
export function raiseFloor(currentPico: bigint): bigint {
  return currentPico + minRaise(currentPico);
}

/**
 * What it costs to get on the board: the floor, and nothing above it.
 *
 * This was briefly "one step past whoever is last", to stop a run of listings
 * sitting on an identical number. It was the wrong trade. Charging somebody
 * more because other people joined makes the entry price a thing they cannot
 * predict and did not agree to, and an empty place at the bottom of the board
 * is worth the floor whatever the listing above it paid. Equal bids are not
 * ambiguous either: the older one keeps the higher place, which is printed in
 * the rules.
 *
 * Kept as a function rather than inlining MIN_BID so the rule has one home if
 * it ever earns a condition again.
 */
export function entryPrice(): bigint {
  return MIN_BID;
}

/** What it costs to take #1 from a board whose current top bid is `top`. */
export function priceToBeat(top: bigint): bigint {
  if (top <= 0n) return MIN_BID;
  return roundUpToStep(top + BID_STEP);
}

export function assertValidBid(pico: bigint): void {
  if (pico < MIN_BID) {
    throw new AmountError(`Minimum bid is ${formatXmr(MIN_BID)} XMR.`);
  }
  if (pico > BID_CEILING) {
    throw new AmountError("That is more XMR than this board can hold.");
  }
  if (pico % BID_STEP !== 0n) {
    throw new AmountError(`Bids move in steps of ${formatXmr(BID_STEP)} XMR.`);
  }
}
