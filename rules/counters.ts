import { query } from "./db.ts";
import { firstThisWindow } from "./ratelimit.ts";

/**
 * Event tallies.
 *
 * This is the honest version of analytics: a board view adds one to an integer
 * for today and leaves nothing else behind. There is no row per visit, no
 * identifier, nothing to correlate, and so nothing that could be handed over.
 * What it cannot tell you is how many *people* that was, and that is the
 * trade, stated plainly on the stats page rather than hidden.
 */
export function bump(name: string, by = 1): void {
  // Fire and forget: a counter must never delay or fail a page.
  void query(
    `INSERT INTO daily_counters (day, name, value)
     VALUES (CURRENT_DATE, $1, $2)
     ON CONFLICT (day, name) DO UPDATE SET value = daily_counters.value + $2`,
    [name, by],
  ).catch(() => {});
}

/**
 * Coarse buckets, counted as independent tallies.
 *
 * The safety of this is structural, not a promise: each bucket is its own
 * integer for the day. Device, browser and country are never stored together,
 * so they cannot be crossed, there is no "mobile Firefox visitor from Germany
 * at 14:00" anywhere, because the three counters do not know about each other.
 * A row per visit is what would make those crossings possible, and there isn't
 * one.
 */
function deviceBucket(ua: string): string {
  if (/\biPad\b|\bTablet\b/i.test(ua)) return "tablet";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Whether the request said it was a machine.
 *
 * This is not bot detection and it is not trying to be. Detecting a bot that
 * lies means fingerprinting every visitor to find the ones that do not behave
 * like a person, which is the thing this board exists to not do. All this
 * reads is the label the client volunteered.
 *
 * It is checked before any browser token, because a modern crawler carries a
 * full Chrome user agent and would otherwise be counted as a person using
 * Chrome. Googlebot did exactly that here until this line moved.
 */
const AUTOMATED =
  /bot\b|bot\/|crawl|spider|slurp|scrap|curl\/|wget|python-requests|libwww|okhttp|go-http|java\/|headless|phantomjs|puppeteer|playwright|monitor|uptime|pingdom|scan(ner)?\b|feedfetch|preview|facebookexternalhit|whatsapp|telegrambot|slackbot|discordbot|embedly|archive\.org_bot|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|claudebot|perplexity|applebot|bingbot|yandex|duckduckbot|baiduspider/i;

export function isAutomated(ua: string): boolean {
  return !ua || AUTOMATED.test(ua);
}

function browserBucket(ua: string): string {
  if (isAutomated(ua)) return "Automated";
  // Order matters: Edge and Opera both claim to be Chrome.
  if (/\bEdg[A-Z]?\//.test(ua)) return "Edge";
  if (/\bOPR\/|\bOpera\b/.test(ua)) return "Opera";
  if (/\bFirefox\//.test(ua)) return "Firefox";
  if (/\bChrome\//.test(ua)) return "Chrome";
  if (/\bSafari\//.test(ua)) return "Safari";
  return "Other";
}

/**
 * Records one board view across its buckets.
 *
 * Country is only counted when the operator's own reverse proxy supplies it
 * (COUNTRY_HEADER). We do not run a GeoIP lookup and we are not behind a CDN
 * that would do it for us, either would mean handling the address for a
 * purpose beyond the rate limiter.
 */
function osBucket(ua: string): string {
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux|X11|BSD/i.test(ua)) return "Linux";
  return "Other";
}

/**
 * Major version only.
 *
 * The exact build, and the device model Android puts in its user agent, are
 * high-entropy fingerprinting surfaces, the fields browsers are actively
 * removing. A major number tells an advertiser how modern the audience is
 * without any of that, and it is the most this board will read out of a user
 * agent.
 */
function versionBucket(ua: string, browser: string): string | null {
  const patterns: Record<string, RegExp> = {
    Edge: /\bEdg[A-Z]?\/(\d+)/,
    Opera: /\bOPR\/(\d+)/,
    Firefox: /\bFirefox\/(\d+)/,
    Chrome: /\bChrome\/(\d+)/,
    Safari: /\bVersion\/(\d+)/,
  };
  const major = patterns[browser] ? patterns[browser].exec(ua)?.[1] : null;
  return major ? `${browser} ${major}` : null;
}

/** Where a visitor came from, host only, bucketed. */
/** A bare IPv4 or IPv6 literal, in the two forms a URL hostname can take. */
function isAddressLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
}

function referrerBucket(referer: string, selfHost: string): string | null {
  try {
    const host = new URL(referer).hostname.toLowerCase().replace(/^www\./, "");
    if (!host || host === selfHost) return null;
    /* An address is not a source.
     *
     * A referrer is the host of the page that linked, and when something
     * reaches this board by its IP rather than its name, that address is what
     * the browser writes in the header. It is almost always one of this site's
     * own edge addresses, arriving from a scanner: it names nobody, it tells a
     * listing nothing about where its clicks came from, and it is worthless as
     * a figure.
     *
     * It is also the one string on a page of aggregates that reads as an IP
     * log. This board's entire claim is that it keeps no record of who read
     * what, and a column headed "Referrer" listing numbers that look like
     * visitors argues against that in the place it is least affordable, even
     * though not one of them is a visitor. Counted as direct, which is what
     * "arrived without a page behind it" has always meant.
     */
    if (isAddressLiteral(host)) return null;
    return host.slice(0, 60);
  } catch {
    return null;
  }
}

export function countView(headers: Headers): void {
  const ua = headers.get("user-agent") ?? "";
  const automated = isAutomated(ua);

  /* Once per caller per window, not once per page load.
   *
   * A number that a reader can move by pressing refresh is not a measure of an
   * audience, and it reads as theatre even when it is the most honest count
   * there is. This is the nearest thing to telling people apart that costs
   * nothing new: the same keyed HMAC of the address the rate limiter has
   * always taken, under the same salt, rotated at the same hour, in the same
   * memory, written nowhere. Nothing is stored that was not already stored,
   * and it stops being linkable to an address at the same moment it already
   * did.
   *
   * The window is an hour rather than a day on purpose. The figure this feeds
   * says "in the last hour", so an hour makes it exactly what it claims to be:
   * callers, not loads. A day-long window would mean a day-long salt, which is
   * twenty-four times the period in which a memory dump could be tested
   * against a guessed address, and the salt's short life is the whole
   * guarantee. A deploy clears the memory either way, which an hourly window
   * barely notices and a daily one would be wrong about for the rest of the
   * day.
   *
   * Tor and I2P arrive with no address to fold, and they are counted every
   * time. Over-counting the people who took the most trouble to be unreadable
   * is the right way round.
   */
  const caller =
    headers.get("cf-connecting-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    "local";
  if (!firstThisWindow(caller, "view")) return;

  // A crawler is not an audience, and a figure an advertiser is reading to
  // decide what a rank is worth must not have crawlers in it. They are still
  // counted, in their own number, because dropping them silently would be the
  // other way of lying about the same thing.
  bump(automated ? "bots" : "views");

  // Everything below describes the audience, so a crawler contributes to none
  // of it. Counting a crawler's browser and country while leaving it out of
  // the visit total would make every breakdown add up to a different number
  // than the figure above it.
  if (automated) return;
  pulse();

  if (ua) {
    const browser = browserBucket(ua);
    bump(`dev:${deviceBucket(ua)}`);
    bump(`os:${osBucket(ua)}`);
    bump(`br:${browser}`);
    const version = versionBucket(ua, browser);
    if (version) bump(`ver:${version}`);
  }

  // The Referer header is already in the request; we tally its host and drop
  // the rest. The full URL, which can carry a search query or a private path, // is never stored.
  const referer = headers.get("referer");
  if (referer) {
    let selfHost = "";
    try {
      selfHost = new URL(process.env.SITE_URL ?? "http://localhost").hostname;
    } catch {
      /* leave blank */
    }
    const source = referrerBucket(referer, selfHost);
    bump(source ? `ref:${source}` : "ref:direct");
  } else {
    bump("ref:direct");
  }

  const headerName = process.env.COUNTRY_HEADER;
  if (headerName) {
    const code = (headers.get(headerName) ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code)) bump(`cc:${code}`);
  }
}

/**
 * A country code turned into something a person reads.
 *
 * The flag is built from the two letters themselves, as regional indicator
 * characters, so no image is fetched and nothing is stored: it is the same two
 * letters the counter holds, drawn differently. A system without the glyphs
 * falls back to showing the letters, which is exactly what we had before.
 */
export function countryLabel(code: string): string {
  const cc = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return code;
  const flag = String.fromCodePoint(
    ...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
  let name = cc;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(cc) ?? cc;
  } catch {
    /* an old runtime without the table: the code is still the answer */
  }
  return `${flag}  ${name}`;
}

export interface DayRow {
  day: string;
  views: number;
  clicks: number;
}

/** The last `days` days, oldest first, with gaps filled in as zeroes. */
export async function daily(days = 30): Promise<DayRow[]> {
  const rows = await query<{ day: string; name: string; value: string }>(
    `SELECT to_char(day, 'YYYY-MM-DD') AS day, name, value::TEXT
     FROM daily_counters
     WHERE day > CURRENT_DATE - $1::INT`,
    [days],
  );

  const byDay = new Map<string, DayRow>();
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { day: key, views: 0, clicks: 0 });
  }
  for (const row of rows) {
    const entry = byDay.get(row.day);
    if (!entry) continue;
    if (row.name === "views") entry.views = Number(row.value);
    if (row.name === "clicks") entry.clicks = Number(row.value);
  }
  return [...byDay.values()];
}

/**
 * A per minute tally for the last few hours.
 *
 * This is how the board says how busy it is without counting people: it cannot
 * tell one visitor refreshing from a hundred arriving, and it says so. Rows
 * older than three hours are deleted as new ones are written, so the table
 * never becomes a history of anything.
 */
function pulse(column: "views" | "clicks" = "views"): void {
  void query(
    `INSERT INTO pulse (bucket, ${column}) VALUES (date_trunc('minute', NOW()), 1)
     ON CONFLICT (bucket) DO UPDATE SET ${column} = pulse.${column} + 1`,
  )
    .then(() =>
      query("DELETE FROM pulse WHERE bucket < NOW() - INTERVAL '50 hours'"),
    )
    .catch(() => {});
}

/** Called from the outbound hop so the 24 hour view has clicks in it too. */
export function pulseClick(): void {
  pulse("clicks");
}

/**
 * The last `hours` as hourly buckets, oldest first, gaps filled with zeroes.
 *
 * The series is generated in SQL rather than matched up in JavaScript: the
 * database and the process do not necessarily agree on a timezone, and an
 * earlier version of this silently returned all zeroes because of it.
 */
export async function hourly(hours = 24): Promise<DayRow[]> {
  const rows = await query<{ label: string; views: string; clicks: string }>(
    `WITH slots AS (
       SELECT generate_series(
         date_trunc('hour', NOW()) - (($1::INT - 1) || ' hours')::INTERVAL,
         date_trunc('hour', NOW()),
         INTERVAL '1 hour'
       ) AS slot
     )
     SELECT to_char(s.slot, 'DD Mon HH24:00') AS label,
            COALESCE(SUM(p.views), 0)::TEXT  AS views,
            COALESCE(SUM(p.clicks), 0)::TEXT AS clicks
     FROM slots s
     LEFT JOIN pulse p ON date_trunc('hour', p.bucket) = s.slot
     GROUP BY s.slot ORDER BY s.slot ASC`,
    [hours],
  );
  return rows.map((r) => ({
    day: r.label,
    views: Number(r.views),
    clicks: Number(r.clicks),
  }));
}

/** How many days of counters exist, for the "all time" range. */
export async function daysOfHistory(): Promise<number> {
  const rows = await query<{ n: string }>(
    "SELECT COALESCE(CURRENT_DATE - MIN(day), 0)::TEXT AS n FROM daily_counters",
  );
  return Math.max(1, Number(rows[0]?.n ?? 0) + 1);
}

/** Views in the last `minutes`, from the pulse table. */
/**
 * Held for a minute, deliberately.
 *
 * The figure was read on every render, so a reader who pressed refresh watched
 * it climb by their own arrival. It was the truest number on the page and it
 * looked like theatre, which is the worse outcome of the two: the board cannot
 * tell one person refreshing from thirty people arriving, says so on /stats,
 * and would have to start identifying readers to do better. It will not.
 *
 * So the number is still every arrival, counted the same way, and the page
 * simply stops re-reading it on every paint. What that removes is the illusion
 * that you moved it, not any part of the count.
 */
let pulseHeld: { at: number; minutes: number; n: number } | null = null;
const PULSE_HOLD_MS = 60_000;

export async function recentViews(minutes = 60): Promise<number> {
  const now = Date.now();
  if (
    pulseHeld &&
    pulseHeld.minutes === minutes &&
    now - pulseHeld.at < PULSE_HOLD_MS
  ) {
    return pulseHeld.n;
  }
  const rows = await query<{ n: string }>(
    `SELECT COALESCE(SUM(views), 0)::TEXT AS n FROM pulse
     WHERE bucket > NOW() - ($1 || ' minutes')::INTERVAL`,
    [String(minutes)],
  );
  const n = Number(rows[0]?.n ?? 0);
  pulseHeld = { at: now, minutes, n };
  return n;
}

export interface Slice {
  label: string;
  value: number;
}

/**
 * One dimension's buckets over the window, largest first. Because each bucket
 * is a separate counter, this can only ever answer "how many views were from
 * mobile", never "which views".
 */
export async function breakdown(prefix: string, days: number): Promise<Slice[]> {
  const rows = await query<{ name: string; value: string }>(
    `SELECT name, SUM(value)::TEXT AS value
     FROM daily_counters
     WHERE day > CURRENT_DATE - $1::INT AND name LIKE $2
     GROUP BY name ORDER BY SUM(value) DESC`,
    [days, `${prefix}:%`],
  );
  return rows.map((r) => ({
    label: r.name.slice(prefix.length + 1),
    value: Number(r.value),
  }));
}

/** The same window, one window earlier, for period-over-period movement. */
export async function previousWindow(
  days: number,
): Promise<{ views: number; clicks: number }> {
  const rows = await query<{ name: string; value: string }>(
    `SELECT name, SUM(value)::TEXT AS value FROM daily_counters
     WHERE day > CURRENT_DATE - $1::INT AND day <= CURRENT_DATE - $2::INT
       AND name IN ('views', 'clicks')
     GROUP BY name`,
    [days * 2, days],
  );
  const get = (n: string) => Number(rows.find((r) => r.name === n)?.value ?? 0);
  return { views: get("views"), clicks: get("clicks") };
}

/**
 * Hosts that are an assistant answering a question rather than a page someone
 * clicked through. Worth separating: a listing found because a model recommended
 * it is a different kind of reach from a link on a forum, and it is the kind
 * that is growing.
 */
const ASSISTANTS: Record<string, string> = {
  "chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "openai.com": "ChatGPT",
  "perplexity.ai": "Perplexity",
  "claude.ai": "Claude",
  "gemini.google.com": "Gemini",
  "bard.google.com": "Gemini",
  "copilot.microsoft.com": "Copilot",
  "chat.deepseek.com": "DeepSeek",
  "grok.com": "Grok",
  "x.ai": "Grok",
  "you.com": "You.com",
  "phind.com": "Phind",
  "poe.com": "Poe",
  "chat.mistral.ai": "Le Chat",
  "kagi.com": "Kagi Assistant",
};

const SEARCH = [
  "google.com", "duckduckgo.com", "bing.com", "kagi.com", "startpage.com",
  "search.brave.com", "ecosia.org", "yandex.com", "baidu.com", "mojeek.com",
  "searx.be", "qwant.com",
];
const SOCIAL = [
  "x.com", "twitter.com", "reddit.com", "news.ycombinator.com", "lobste.rs",
  "mastodon.social", "lemmy.world", "bsky.app", "facebook.com", "linkedin.com",
  "youtube.com", "monero.town", "threads.net", "t.me",
];

/**
 * Referrers grouped by what kind of place they are. A bidder cares whether the
 * audience arrives from a search, from a link somebody posted, or from a model
 * answering a question, more than they care about any single host.
 */
export function channels(refs: Slice[]): Slice[] {
  const totals: Record<string, number> = {
    Direct: 0,
    "AI assistants": 0,
    Search: 0,
    Social: 0,
    Other: 0,
  };
  for (const slice of refs) {
    const host = slice.label;
    if (host === "direct") totals.Direct += slice.value;
    else if (ASSISTANTS[host]) totals["AI assistants"] += slice.value;
    else if (SEARCH.some((h) => host === h || host.endsWith("." + h))) totals.Search += slice.value;
    else if (SOCIAL.some((h) => host === h || host.endsWith("." + h))) totals.Social += slice.value;
    else totals.Other += slice.value;
  }
  return Object.entries(totals)
    .filter(([, value]) => value > 0)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value);
}

/** Splits a referrer breakdown into assistants and everything else. */
export function splitAssistants(refs: Slice[]): {
  assistants: Slice[];
  rest: Slice[];
} {
  const byName = new Map<string, number>();
  const rest: Slice[] = [];

  for (const slice of refs) {
    const name = ASSISTANTS[slice.label];
    if (name) byName.set(name, (byName.get(name) ?? 0) + slice.value);
    else rest.push(slice);
  }

  return {
    assistants: [...byName.entries()].map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value),
    rest,
  };
}

export async function totals(): Promise<{ views: number; clicks: number }> {
  const rows = await query<{ name: string; value: string }>(
    "SELECT name, SUM(value)::TEXT AS value FROM daily_counters GROUP BY name",
  );
  const get = (name: string) => Number(rows.find((r) => r.name === name)?.value ?? 0);
  return { views: get("views"), clicks: get("clicks") };
}
