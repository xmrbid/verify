import http from "node:http";
import https from "node:https";
import { createHash, randomBytes } from "node:crypto";
import { query } from "./db.ts";

/**
 * JSON with uint64 amounts intact.
 *
 * Monero counts in piconero, and 2^53 piconero is about 9007 XMR: past that,
 * `JSON.parse` rounds an amount without saying so and an invoice settles for a
 * figure nobody paid. The board's ceiling is well above that, so the case is
 * reachable rather than theoretical. Quoting the digits before parsing keeps
 * them exact, and every amount is read with `BigInt` from there on.
 *
 * Only integers long enough to be at risk are quoted, so `confirmations`,
 * `height` and the rest stay numbers.
 */
const LONG_INT = /(:\s*)(-?\d{16,})(\s*[,}\]])/g;
export function parseJson(text: string): unknown {
  return JSON.parse(text.replace(LONG_INT, '$1"$2"$3'));
}

/**
 * The one Authorization header `monero-wallet-rpc` accepts.
 *
 * It speaks HTTP digest and nothing else, and fetch has no digest support, so
 * the challenge is answered here: qop=auth, MD5, which is what the daemon
 * implements. This is only ever spoken over loopback or a private link, and it
 * guards a wallet that cannot spend anything in the first place.
 */
export function digestHeader(
  challenge: string,
  login: string,
  endpoint: string,
): string | null {
  if (!/^digest/i.test(challenge.trim())) return null;
  const field = (name: string) =>
    new RegExp(`${name}="([^"]*)"`, "i").exec(challenge)?.[1] ??
    new RegExp(`${name}=([^,\\s]+)`, "i").exec(challenge)?.[1];

  const realm = field("realm") ?? "";
  const nonce = field("nonce") ?? "";
  const opaque = field("opaque");
  const qop = (field("qop") ?? "").split(",")[0].trim();
  const algorithm = (field("algorithm") ?? "MD5").toUpperCase();
  if (algorithm !== "MD5") return null;

  const [user, ...rest] = login.split(":");
  const password = rest.join(":");
  const uri = new URL(endpoint).pathname || "/";
  const md5 = (v: string) => createHash("md5").update(v).digest("hex");

  const ha1 = md5(`${user}:${realm}:${password}`);
  const ha2 = md5(`POST:${uri}`);
  const cnonce = randomBytes(8).toString("hex");
  const nc = "00000001";
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`);

  const parts = [
    `username="${user}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    `algorithm=${algorithm}`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

/**
 * The board never holds spend keys. In production this talks to a
 * `monero-wallet-rpc` started from a **view-only** wallet, which is enough to
 * derive subaddresses and watch them for incoming transfers, and useless to an
 * attacker who takes the server.
 */
export interface Wallet {
  /** A fresh subaddress, used by exactly one invoice. */
  createSubaddress(label: string): Promise<{ address: string; index: number }>;
  /** Everything received on one subaddress so far. */
  received(index: number): Promise<Received>;
  /**
   * A Monero InProof: a signature showing that `txid` paid `address`, made
   * with the wallet's private view key.
   *
   * Of the three proofs Monero can make, this is the only one a receiver can
   * produce. A SpendProof needs the spend key and an OutProof needs the
   * transaction's secret key, which only the sender holds. An InProof is a
   * statement about a shared secret the receiver derives from its view key, so
   * it works in a view-only wallet, which is why this board can prove its
   * income while being unable to move it.
   *
   * `message` is signed along with the rest, so a signature cannot be lifted
   * off one receipt and presented as another. Returns null when the wallet
   * will not produce one, which is a missing receipt, never a failed payment.
   */
  txProof(txid: string, address: string, message: string): Promise<string | null>;
  /** What the wallet actually is, asked of the wallet rather than assumed. */
  health(): Promise<Health>;
  readonly kind: "mock" | "wallet-rpc";
}

export interface Health {
  ok: boolean;
  /** The primary address, so it can be compared against the intended wallet. */
  address?: string;
  /** How far the wallet has scanned. Zero means it has not started. */
  height?: number;
  /**
   * Whether the wallet can spend. This board's whole claim is that it cannot,
   * so a `true` here is not a detail: it means the server is holding a key
   * that can move the money it is watching.
   */
  spendable?: boolean;
  reason?: string;
}

export interface Received {
  amountPico: bigint;
  confirmations: number;
  /** The transactions that paid it, in the order the wallet reports them. */
  txids: string[];
}

/**
 * How many confirmations before a bid claims its rank.
 *
 * Ten, which is the number Monero itself uses: an output cannot be spent until
 * ten blocks have buried it, so a payment this deep is a payment the network
 * already treats as settled. Deeper than that buys nothing a reorg could take
 * back and costs the bidder minutes on a page they are sitting in front of.
 *
 * It is still far past what a shop would take, because a rank here is
 * permanent and there is nothing to claw back afterwards.
 */
export const REQUIRED_CONFIRMATIONS = Number(process.env.XMR_CONFIRMATIONS ?? 10);

/** A wallet that has stopped answering must not hold a page open. */
const WALLET_TIMEOUT_MS = Number(process.env.MONERO_WALLET_TIMEOUT_MS ?? 8000);

class WalletRpc implements Wallet {
  readonly kind = "wallet-rpc" as const;
  private endpoint: string;
  private accountIndex: number;
  private login?: string;
  private agent?: http.Agent | https.Agent;
  /**
   * One exchange at a time.
   *
   * A digest handshake is two requests that belong together, and the wallet
   * binds the nonce between them to the connection. Two of them interleaved on
   * one socket, which is what `Promise.all` produces, means the second retry
   * carries a nonce the wallet has already spent on the first. Everything here
   * is loopback and none of it is hot, so a queue costs nothing and removes the
   * whole class of problem.
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(endpoint: string, accountIndex: number, login?: string) {
    this.endpoint = endpoint;
    this.accountIndex = accountIndex;
    this.login = login;
  }

  /**
   * One request, over a connection this client keeps.
   *
   * Not `fetch`, and the reason is specific: `monero-wallet-rpc` binds the
   * digest nonce it hands out to the connection it handed it out on. A 401
   * followed by a retry has to travel the same socket, and `fetch` gives no
   * control over that: the retry lands on a second connection, the nonce is
   * unknown there, and the wallet answers 401 again for ever. curl works
   * because curl reuses the socket, which is what this does.
   *
   * The agent is capped at one socket for the same reason. Everything here is
   * loopback and sequential, so there is nothing to gain from more.
   */
  private post(payload: string, auth?: string): Promise<{ status: number; body: string; challenge: string }> {
    const url = new URL(this.endpoint);
    const secure = url.protocol === "https:";
    const mod = secure ? https : http;
    if (!this.agent) {
      this.agent = secure
        ? new https.Agent({ keepAlive: true, maxSockets: 1 })
        : new http.Agent({ keepAlive: true, maxSockets: 1 });
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(payload)),
    };
    if (auth) headers.Authorization = auth;

    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (secure ? 443 : 80),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers,
          agent: this.agent,
          timeout: WALLET_TIMEOUT_MS,
        },
        (res) => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (body += c));
          res.on("end", () => {
            const raw = res.headers["www-authenticate"];
            resolve({
              status: res.statusCode ?? 0,
              body,
              challenge: Array.isArray(raw) ? raw[0] : (raw ?? ""),
            });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("wallet-rpc timed out")));
      req.on("error", reject);
      req.end(payload);
    });
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    const run = this.queue.then(
      () => this.exchange<T>(method, params),
      () => this.exchange<T>(method, params),
    );
    // The queue tracks completion, not success: one failed call must not
    // poison every call after it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async exchange<T>(method: string, params: unknown): Promise<T> {
    const payload = JSON.stringify({ jsonrpc: "2.0", id: "0", method, params });
    let res = await this.post(payload);

    // monero-wallet-rpc answers an unauthenticated request with a digest
    // challenge. Digest is the only scheme it speaks and nothing in Node
    // implements it, so the second request is built by hand and sent back down
    // the same connection.
    if (res.status === 401 && this.login) {
      const auth = digestHeader(res.challenge, this.login, this.endpoint);
      if (!auth) throw new Error(`wallet-rpc ${method}: cannot answer ${res.challenge}`);
      res = await this.post(payload, auth);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `wallet-rpc ${method}: HTTP ${res.status}` +
          (res.status === 401 ? " (check MONERO_WALLET_RPC_LOGIN=user:pass)" : ""),
      );
    }
    // Parsed so that a uint64 amount survives; see parseJson.
    const body = parseJson(res.body) as {
      result?: T;
      error?: { message: string };
    };
    if (body.error) throw new Error(`wallet-rpc ${method}: ${body.error.message}`);
    if (!body.result) throw new Error(`wallet-rpc ${method}: empty result`);
    return body.result;
  }

  async createSubaddress(label: string) {
    const r = await this.call<{ address: string; address_index: number }>(
      "create_address",
      { account_index: this.accountIndex, label },
    );
    return { address: r.address, index: r.address_index };
  }

  async received(index: number): Promise<Received> {
    /*
     * get_transfers answers with one array per kind, `in` and `pool` and
     * `out`, and not with a single `transfers`. This read that key, which does
     * not exist, so every call returned nothing: money would arrive, the
     * watcher would see a payment of zero, and no invoice would ever settle.
     * Somebody would have paid and watched their listing never appear.
     *
     * It survived a full end-to-end test because that test ran against the
     * mock wallet, which answers from a table and never touches this code. The
     * first real payment found it in a minute.
     *
     * `in` is what has landed in a block, `pool` is what is in the mempool and
     * has no confirmations yet. Both count towards the amount, because the
     * money is on its way either way; only the confirmation count decides
     * whether it has arrived.
     */
    interface Entry {
      /** A string when it was too long to be a safe number; see parseJson. */
      amount: string | number;
      confirmations?: number;
      txid?: string;
    }
    const r = await this.call<{ in?: Entry[]; pool?: Entry[] }>("get_transfers", {
      in: true,
      pool: true,
      account_index: this.accountIndex,
      subaddr_indices: [index],
    });

    const entries = [...(r.in ?? []), ...(r.pool ?? [])];
    let amountPico = 0n;
    let confirmations = Number.POSITIVE_INFINITY;
    const txids: string[] = [];
    for (const t of entries) {
      amountPico += BigInt(t.amount);
      // A pool entry reports no confirmations, which is zero rather than
      // unknown: it is the one that has not arrived, and taking the lowest
      // means a second payment cannot confirm the first one on its behalf.
      confirmations = Math.min(confirmations, t.confirmations ?? 0);
      if (t.txid && !txids.includes(t.txid)) txids.push(t.txid);
    }
    return {
      amountPico,
      confirmations: Number.isFinite(confirmations) ? confirmations : 0,
      txids,
    };
  }

  async txProof(
    txid: string,
    address: string,
    message: string,
  ): Promise<string | null> {
    try {
      const r = await this.call<{ signature?: string }>("get_tx_proof", {
        txid,
        address,
        message,
      });
      return r.signature ?? null;
    } catch (err) {
      // A wallet that will not sign is a receipt this board cannot publish.
      // The payment stands either way, so this is logged and not thrown.
      console.error(`tx proof for ${txid} failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Asks the wallet three things rather than trusting the configuration: is it
   * there, where has it scanned to, and can it spend.
   *
   * The last one is asked by requesting the spend key. A view-only wallet
   * refuses, and that refusal is the answer we want. Asking for it is safe:
   * the reply goes nowhere and is never stored, and a wallet that hands one
   * over has just told us the deployment is wrong.
   */
  async health(): Promise<Health> {
    try {
      const [addr, height] = await Promise.all([
        this.call<{ address: string }>("get_address", {
          account_index: this.accountIndex,
          address_index: [0],
        }),
        this.call<{ height: number }>("get_height", {}),
      ]);
      let spendable = false;
      try {
        const key = await this.call<{ key?: string }>("query_key", {
          key_type: "spend_key",
        });
        // A view-only wallet returns all zeroes here on some versions and an
        // error on others. Both mean the same thing: nothing to spend with.
        spendable = !!key.key && !/^0+$/.test(key.key);
      } catch {
        spendable = false;
      }
      return {
        ok: true,
        address: addr.address,
        height: height.height,
        spendable,
      };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  }
}

/**
 * Development stand-in. Hands out deterministic look-alike addresses and reads
 * "received" amounts from the `mock_receipts` table, which `/api/dev/pay`
 * writes to. Nothing here reaches a Monero node.
 */
class MockWallet implements Wallet {
  readonly kind = "mock" as const;

  async health(): Promise<Health> {
    return { ok: false, reason: "No MONERO_WALLET_RPC set: nothing behind this." };
  }

  async createSubaddress(label: string) {
    const [row] = await query<{ next: string }>(
      "SELECT COALESCE(MAX(subaddress_index), 0) + 1 AS next FROM invoices",
    );
    const index = Number(row?.next ?? 1);
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz123456789";
    let seed = index * 2654435761 + hashLabel(label);
    let body = "";
    for (let i = 0; i < 93; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      body += alphabet[seed % alphabet.length];
    }
    return { address: `8${body}`, index };
  }

  async received(index: number): Promise<Received> {
    const [row] = await query<{ amount_pico: string; confirmations: number }>(
      "SELECT amount_pico, confirmations FROM mock_receipts WHERE subaddress_index = $1",
      [index],
    );
    if (!row) return { amountPico: 0n, confirmations: 0, txids: [] };
    return {
      amountPico: BigInt(row.amount_pico),
      confirmations: row.confirmations,
      // A stand-in hash, shaped like a real one so the proof pages can be
      // built and read, and prefixed so nobody can mistake it for one.
      txids: [`mock${(index * 2654435761).toString(16).padStart(60, "0").slice(0, 60)}`],
    };
  }

  async txProof(txid: string, _address: string, message: string): Promise<string> {
    return `MockProofNoChainBehindIt${txid.slice(4, 16)}${message.slice(-6)}`;
  }
}

function hashLabel(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

let cached: Wallet | undefined;

export function wallet(): Wallet {
  if (cached) return cached;
  const endpoint = process.env.MONERO_WALLET_RPC;
  cached = endpoint
    ? new WalletRpc(
        endpoint,
        Number(process.env.MONERO_ACCOUNT_INDEX ?? 0),
        process.env.MONERO_WALLET_RPC_LOGIN,
      )
    : new MockWallet();
  return cached;
}

/** The `monero:` URI a wallet app scans from the invoice QR code. */
export function paymentUri(address: string, amountPico: bigint): string {
  const whole = amountPico / 1_000_000_000_000n;
  const frac = (amountPico % 1_000_000_000_000n).toString().padStart(12, "0").replace(/0+$/, "");
  const amount = frac ? `${whole}.${frac}` : `${whole}`;
  return `monero:${address}?tx_amount=${amount}`;
}
