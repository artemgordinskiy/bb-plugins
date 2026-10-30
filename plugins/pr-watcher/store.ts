import type Database from "better-sqlite3";

export const MIGRATIONS = [
  `CREATE TABLE bindings (
    pr_url TEXT NOT NULL PRIMARY KEY,
    environment_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    claimed_by TEXT NOT NULL CHECK (claimed_by IN ('agent', 'user')),
    since INTEGER NOT NULL,
    branch_bound INTEGER NOT NULL,
    next_poll_at INTEGER NOT NULL,
    may_be_missing INTEGER NOT NULL DEFAULT 0,
    last_delivery_at INTEGER,
    last_outcome TEXT CHECK (last_outcome IN ('sending', 'sent', 'cancelled', 'unknown'))
  )`,
  `CREATE INDEX bindings_thread ON bindings (thread_id)`,
  `CREATE INDEX bindings_environment ON bindings (environment_id)`,
  `CREATE TABLE reported_shas (
    pr_url TEXT NOT NULL,
    sha TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('delivered', 'baselined')),
    verdict TEXT NOT NULL CHECK (verdict IN ('pass', 'fail')),
    at INTEGER NOT NULL,
    PRIMARY KEY (pr_url, sha)
  )`,
  `CREATE TABLE seen_items (
    pr_url TEXT NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (pr_url, item_id)
  )`,
  `CREATE TABLE pending_items (
    pr_url TEXT NOT NULL,
    item_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review', 'comment')),
    author TEXT NOT NULL,
    review_state TEXT,
    inline_count INTEGER NOT NULL,
    at TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (pr_url, item_id)
  )`,
  `CREATE TABLE thread_off (
    thread_id TEXT NOT NULL PRIMARY KEY,
    at INTEGER NOT NULL
  )`,
];

export type ClaimedBy = "agent" | "user";
export type Outcome = "sending" | "sent" | "cancelled" | "unknown";
export type Verdict = "pass" | "fail";

export type Binding = {
  prUrl: string;
  environmentId: string;
  hostId: string;
  threadId: string;
  claimedBy: ClaimedBy;
  since: number;
  branchBound: boolean;
  nextPollAt: number;
  mayBeMissing: boolean;
  lastDeliveryAt: number | null;
  lastOutcome: Outcome | null;
};

export type PendingItem = {
  id: string;
  kind: "review" | "comment";
  author: string;
  reviewState: string | null;
  inlineCount: number;
  at: string;
  url: string;
};

export type ReportedSha = { reason: "delivered" | "baselined"; verdict: Verdict };

export type Owner = Pick<Binding, "threadId" | "environmentId" | "hostId" | "claimedBy" | "since" | "branchBound" | "nextPollAt">;

type CiReservation = { sha: string; verdict: Verdict; recovery: boolean };

/** What `reserve` changed, kept in memory so a cancelled send can undo it. */
export type Reservation = {
  prUrl: string;
  items: PendingItem[];
  ci: CiReservation | null;
  mayBeMissing: boolean;
};

type BindingRow = {
  pr_url: string;
  environment_id: string;
  host_id: string;
  thread_id: string;
  claimed_by: ClaimedBy;
  since: number;
  branch_bound: number;
  next_poll_at: number;
  may_be_missing: number;
  last_delivery_at: number | null;
  last_outcome: Outcome | null;
};

type PendingRow = {
  item_id: string;
  kind: "review" | "comment";
  author: string;
  review_state: string | null;
  inline_count: number;
  at: string;
  url: string;
};

const toBinding = (row: BindingRow): Binding => ({
  prUrl: row.pr_url,
  environmentId: row.environment_id,
  hostId: row.host_id,
  threadId: row.thread_id,
  claimedBy: row.claimed_by,
  since: row.since,
  branchBound: row.branch_bound === 1,
  nextPollAt: row.next_poll_at,
  mayBeMissing: row.may_be_missing === 1,
  lastDeliveryAt: row.last_delivery_at,
  lastOutcome: row.last_outcome,
});

const toPending = (row: PendingRow): PendingItem => ({
  id: row.item_id,
  kind: row.kind,
  author: row.author,
  reviewState: row.review_state,
  inlineCount: row.inline_count,
  at: row.at,
  url: row.url,
});

export class Store {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  binding(prUrl: string): Binding | null {
    const row = this.db.prepare("SELECT * FROM bindings WHERE pr_url = ?").get(prUrl) as BindingRow | undefined;
    return row ? toBinding(row) : null;
  }

  bindings(): Binding[] {
    return (this.db.prepare("SELECT * FROM bindings ORDER BY pr_url").all() as BindingRow[]).map(toBinding);
  }

  forThread(threadId: string): Binding[] {
    const rows = this.db.prepare("SELECT * FROM bindings WHERE thread_id = ? ORDER BY pr_url").all(threadId);
    return (rows as BindingRow[]).map(toBinding);
  }

  forEnvironment(environmentId: string): Binding[] {
    const rows = this.db.prepare("SELECT * FROM bindings WHERE environment_id = ? ORDER BY pr_url").all(environmentId);
    return (rows as BindingRow[]).map(toBinding);
  }

  due(now: number): Binding[] {
    const rows = this.db.prepare("SELECT * FROM bindings WHERE next_poll_at <= ? ORDER BY pr_url").all(now);
    return (rows as BindingRow[]).map(toBinding);
  }

  /** First enrollment: everything already on the PR is the baseline. */
  enroll(binding: Binding, baseline: { itemIds: string[]; ci: { sha: string; verdict: Verdict } | null }): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bindings (pr_url, environment_id, host_id, thread_id, claimed_by, since, branch_bound, next_poll_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          binding.prUrl,
          binding.environmentId,
          binding.hostId,
          binding.threadId,
          binding.claimedBy,
          binding.since,
          binding.branchBound ? 1 : 0,
          binding.nextPollAt,
        );
      this.markSeen(binding.prUrl, baseline.itemIds);
      if (baseline.ci) {
        this.db
          .prepare("INSERT INTO reported_shas (pr_url, sha, reason, verdict, at) VALUES (?, ?, 'baselined', ?, ?)")
          .run(binding.prUrl, baseline.ci.sha, baseline.ci.verdict, binding.since);
      }
    })();
  }

  /** Moves the owner and polling environment; the cursors stay with the PR. */
  transfer(prUrl: string, owner: Owner): void {
    this.db
      .prepare(
        `UPDATE bindings SET thread_id = ?, environment_id = ?, host_id = ?, claimed_by = ?, since = ?, branch_bound = ?, next_poll_at = ?
         WHERE pr_url = ?`,
      )
      .run(
        owner.threadId,
        owner.environmentId,
        owner.hostId,
        owner.claimedBy,
        owner.since,
        owner.branchBound ? 1 : 0,
        owner.nextPollAt,
        prUrl,
      );
  }

  moveOwner(prUrl: string, threadId: string): void {
    this.db.prepare("UPDATE bindings SET thread_id = ? WHERE pr_url = ?").run(threadId, prUrl);
  }

  drop(prUrl: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM pending_items WHERE pr_url = ?").run(prUrl);
      this.db.prepare("DELETE FROM seen_items WHERE pr_url = ?").run(prUrl);
      this.db.prepare("DELETE FROM reported_shas WHERE pr_url = ?").run(prUrl);
      this.db.prepare("DELETE FROM bindings WHERE pr_url = ?").run(prUrl);
    })();
  }

  setNextPoll(prUrl: string, at: number): void {
    this.db.prepare("UPDATE bindings SET next_poll_at = ? WHERE pr_url = ?").run(at, prUrl);
  }

  reportedSha(prUrl: string, sha: string): ReportedSha | null {
    const row = this.db.prepare("SELECT reason, verdict FROM reported_shas WHERE pr_url = ? AND sha = ?").get(prUrl, sha);
    return (row as ReportedSha | undefined) ?? null;
  }

  /** Every item the PR already knows about, delivered or still waiting. */
  knownIds(prUrl: string): Set<string> {
    const rows = this.db
      .prepare("SELECT item_id FROM seen_items WHERE pr_url = ? UNION SELECT item_id FROM pending_items WHERE pr_url = ?")
      .all(prUrl, prUrl) as { item_id: string }[];
    return new Set(rows.map((row) => row.item_id));
  }

  pendingItems(prUrl: string): PendingItem[] {
    const rows = this.db.prepare("SELECT * FROM pending_items WHERE pr_url = ? ORDER BY at, item_id").all(prUrl);
    return (rows as PendingRow[]).map(toPending);
  }

  recordNew(prUrl: string, found: { pending: PendingItem[]; ignored: string[]; saturated: boolean }): void {
    this.db.transaction(() => {
      this.insertPending(prUrl, found.pending);
      this.markSeen(prUrl, found.ignored);
      if (found.saturated) this.db.prepare("UPDATE bindings SET may_be_missing = 1 WHERE pr_url = ?").run(prUrl);
    })();
  }

  /** Marks the delivery done before it is sent, in one transaction. */
  reserve(prUrl: string, itemIds: string[], ci: CiReservation | null, now: number): Reservation {
    return this.db.transaction((): Reservation => {
      const wanted = new Set(itemIds);
      const items = this.pendingItems(prUrl).filter((item) => wanted.has(item.id));
      const mayBeMissing = this.binding(prUrl)?.mayBeMissing ?? false;
      const remove = this.db.prepare("DELETE FROM pending_items WHERE pr_url = ? AND item_id = ?");
      for (const item of items) remove.run(prUrl, item.id);
      this.markSeen(prUrl, items.map((item) => item.id));
      if (ci?.recovery) {
        this.db.prepare("UPDATE reported_shas SET verdict = ?, at = ? WHERE pr_url = ? AND sha = ?").run(ci.verdict, now, prUrl, ci.sha);
      } else if (ci) {
        this.db
          .prepare("INSERT INTO reported_shas (pr_url, sha, reason, verdict, at) VALUES (?, ?, 'delivered', ?, ?)")
          .run(prUrl, ci.sha, ci.verdict, now);
      }
      this.db
        .prepare("UPDATE bindings SET may_be_missing = 0, last_delivery_at = ?, last_outcome = 'sending' WHERE pr_url = ?")
        .run(now, prUrl);
      return { prUrl, items, ci, mayBeMissing };
    })();
  }

  /** Undoes `reserve`. Only for a queued send whose delete was confirmed. */
  rollback(reservation: Reservation): void {
    const { prUrl, items, ci, mayBeMissing } = reservation;
    this.db.transaction(() => {
      const unsee = this.db.prepare("DELETE FROM seen_items WHERE pr_url = ? AND item_id = ?");
      for (const item of items) unsee.run(prUrl, item.id);
      this.insertPending(prUrl, items);
      if (ci?.recovery) {
        this.db.prepare("UPDATE reported_shas SET verdict = 'fail' WHERE pr_url = ? AND sha = ?").run(prUrl, ci.sha);
      } else if (ci) {
        this.db.prepare("DELETE FROM reported_shas WHERE pr_url = ? AND sha = ?").run(prUrl, ci.sha);
      }
      this.db
        .prepare("UPDATE bindings SET may_be_missing = ?, last_outcome = 'cancelled' WHERE pr_url = ?")
        .run(mayBeMissing ? 1 : 0, prUrl);
    })();
  }

  setOutcome(prUrl: string, outcome: Outcome): void {
    this.db.prepare("UPDATE bindings SET last_outcome = ? WHERE pr_url = ?").run(outcome, prUrl);
  }

  /** A send cut off by a restart can't be proven either way. */
  resolveInterrupted(): void {
    this.db.prepare("UPDATE bindings SET last_outcome = 'unknown' WHERE last_outcome = 'sending'").run();
  }

  isOff(threadId: string): boolean {
    return this.db.prepare("SELECT 1 FROM thread_off WHERE thread_id = ?").get(threadId) !== undefined;
  }

  setOff(threadId: string, at: number): void {
    this.db.prepare("INSERT OR REPLACE INTO thread_off (thread_id, at) VALUES (?, ?)").run(threadId, at);
  }

  clearOff(threadId: string): void {
    this.db.prepare("DELETE FROM thread_off WHERE thread_id = ?").run(threadId);
  }

  private markSeen(prUrl: string, itemIds: string[]): void {
    const insert = this.db.prepare("INSERT OR IGNORE INTO seen_items (pr_url, item_id) VALUES (?, ?)");
    for (const id of itemIds) insert.run(prUrl, id);
  }

  private insertPending(prUrl: string, items: PendingItem[]): void {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO pending_items (pr_url, item_id, kind, author, review_state, inline_count, at, url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      insert.run(prUrl, item.id, item.kind, item.author, item.reviewState, item.inlineCount, item.at, item.url);
    }
  }
}
