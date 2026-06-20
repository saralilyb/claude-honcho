import type { Honcho } from "@honcho-ai/sdk";
import { homedir } from "os";
import { join } from "path";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "fs";

// Failure-driven local outbox. Real-time uploads are best-effort (maxRetries:0,
// no SDK queue): when the Honcho host is unreachable, the send sites drop the
// message. This module catches those drops to ~/.honcho/outbox.jsonl and replays
// them at the next SessionStart once the host is back. Decoupled from any
// teardown hook by design — there is no SessionEnd.

const OUTBOX_DIR = join(homedir(), ".honcho");
const OUTBOX_FILE = join(OUTBOX_DIR, "outbox.jsonl");
const CLAIM_PREFIX = "outbox.draining-";

// Hard ceiling on the queue file: once past this, stop appending so a long
// outage can't fill the disk. ~5 MB is thousands of prompts.
const MAX_OUTBOX_BYTES = 5 * 1024 * 1024;

// Drain-pass defaults; callers may override.
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_RECORDS = 1000;
const DEFAULT_TIME_BUDGET_MS = 8000;

// A claim file older than this is treated as orphaned (a drain that crashed)
// and reclaimed by the next session.
const ORPHAN_RECLAIM_MS = 2 * 60 * 1000;

export interface OutboxRecord {
  /** Session to replay into — preserved from the original send. */
  sessionName: string;
  /** Resolved peer to send as (config.peerName or config.aiPeer). */
  peerName: string;
  /** Exact message content (already chunked/sliced at the send site). */
  content: string;
  /** Metadata object from the original send. */
  metadata: Record<string, unknown>;
  /** Original send time, so the deriver keeps chronology on a late flush. */
  createdAt: string;
  /** Enqueue time, used for the age cap. */
  queuedAt: string;
}

function ensureDir(): void {
  if (!existsSync(OUTBOX_DIR)) {
    mkdirSync(OUTBOX_DIR, { recursive: true });
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Append dropped messages to the local outbox. Best-effort and synchronous —
 * a queue-write failure must never break the calling hook, so everything is
 * swallowed. Skips silently once the file passes MAX_OUTBOX_BYTES.
 */
export function enqueueOutbox(records: OutboxRecord[]): number {
  if (records.length === 0) {
    return 0;
  }
  try {
    ensureDir();
    if (
      existsSync(OUTBOX_FILE) &&
      statSync(OUTBOX_FILE).size > MAX_OUTBOX_BYTES
    ) {
      return 0;
    }
    appendFileSync(
      OUTBOX_FILE,
      records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    );
    return records.length;
  } catch {
    return 0;
  }
}

function parseRecords(path: string): OutboxRecord[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: OutboxRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const rec = JSON.parse(line) as OutboxRecord;
      if (
        rec &&
        rec.sessionName &&
        rec.peerName &&
        typeof rec.content === "string"
      ) {
        out.push(rec);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Atomically claim the outbox for this drainer by renaming it aside, so
 * concurrent SessionStarts can't double-send. Also reclaims orphaned claim
 * files from drains that crashed. Returns the claimed file paths.
 */
function claimFiles(instanceId: string): string[] {
  ensureDir();
  const nonce = `${instanceId}-${process.pid}-${Date.now()}`;
  const claimed: string[] = [];

  if (existsSync(OUTBOX_FILE)) {
    const dest = join(OUTBOX_DIR, `${CLAIM_PREFIX}${nonce}.jsonl`);
    try {
      renameSync(OUTBOX_FILE, dest); // atomic; loser of the race gets ENOENT
      claimed.push(dest);
    } catch {
      // another session claimed it first
    }
  }

  let entries: string[] = [];
  try {
    entries = readdirSync(OUTBOX_DIR);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    if (!name.startsWith(CLAIM_PREFIX)) {
      continue;
    }
    const path = join(OUTBOX_DIR, name);
    if (claimed.includes(path)) {
      continue;
    }
    try {
      if (Date.now() - statSync(path).mtimeMs < ORPHAN_RECLAIM_MS) {
        continue; // freshly claimed by a live drainer
      }
      const dest = join(OUTBOX_DIR, `${CLAIM_PREFIX}${nonce}-${name}`);
      renameSync(path, dest);
      claimed.push(dest);
    } catch {
      // someone else reclaimed it
    }
  }
  return claimed;
}

/**
 * Drain the outbox into Honcho. Call only once the host is confirmed reachable
 * (e.g. after SessionStart's session/peer setup succeeds). Best-effort and
 * time-boxed; anything not sent is written back for the next session, and
 * over-cap/over-age records are dropped with a logged count.
 */
export async function drainOutbox(
  honcho: Honcho,
  instanceId: string,
  log: (msg: string) => void,
  opts: { timeBudgetMs?: number; maxAgeMs?: number; maxRecords?: number } = {},
): Promise<void> {
  const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;

  const claimed = claimFiles(instanceId);
  if (claimed.length === 0) {
    return;
  }

  const records = claimed.flatMap((f) => parseRecords(f));
  if (records.length === 0) {
    claimed.forEach(safeUnlink);
    return;
  }

  // Age cap, then count cap (keep the most recent).
  const now = Date.now();
  const fresh = records.filter((r) => {
    const t = Date.parse(r.queuedAt);
    return Number.isNaN(t) || now - t <= maxAgeMs;
  });
  let dropped = records.length - fresh.length;
  let kept = fresh;
  if (fresh.length > maxRecords) {
    kept = fresh.slice(fresh.length - maxRecords);
    dropped += fresh.length - maxRecords;
  }

  // One addMessages round trip per session.
  const bySession = new Map<string, OutboxRecord[]>();
  for (const r of kept) {
    const group = bySession.get(r.sessionName) ?? [];
    group.push(r);
    bySession.set(r.sessionName, group);
  }
  const groups = [...bySession.entries()];

  const deadline = Date.now() + timeBudgetMs;
  const unsent: OutboxRecord[] = [];
  let sent = 0;
  let i = 0;
  for (; i < groups.length; i++) {
    if (Date.now() > deadline) {
      break;
    }
    const [sessionName, group] = groups[i];
    try {
      const session = await honcho.session(sessionName);
      const peerCache = new Map<string, any>();
      const messages: any[] = [];
      for (const r of group) {
        let peer = peerCache.get(r.peerName);
        if (!peer) {
          peer = await honcho.peer(r.peerName);
          peerCache.set(r.peerName, peer);
        }
        messages.push(
          peer.message(r.content, {
            createdAt: r.createdAt,
            metadata: r.metadata,
          }),
        );
      }
      await session.addMessages(messages);
      sent += group.length;
    } catch (e) {
      // Host went away again mid-drain — requeue and stop trying this pass.
      log(`outbox: drain interrupted (${e})`);
      break;
    }
  }
  // Everything from the break point onward (failed or untried) is requeued.
  for (; i < groups.length; i++) {
    unsent.push(...groups[i][1]);
  }

  if (unsent.length > 0) {
    enqueueOutbox(unsent);
  }
  claimed.forEach(safeUnlink);

  if (sent > 0 || dropped > 0 || unsent.length > 0) {
    log(
      `outbox: flushed ${sent}, dropped ${dropped} (cap/age), ` +
        `requeued ${unsent.length}`,
    );
  }
}
