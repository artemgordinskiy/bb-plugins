import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const PR_URL_PATTERN = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

/** The snapshot's window: last 100 reviews, last 100 comments, first 100 checks. */
export const PAGE_SIZE = 100;

export const MAX_TITLE = 300;
export const MAX_EXCERPT = 300;
export const MAX_ERROR_LINE = 200;

export type PullRequestRef = { owner: string; repo: string; number: number };

export function parsePrUrl(url: string): PullRequestRef | null {
  const match = PR_URL_PATTERN.exec(url);
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: match[1]!, repo: match[2]!, number };
}

const prUrl = z.string().regex(PR_URL_PATTERN);

export const HOST_ERROR_CODES = ["gh_missing", "gh_unauthenticated", "not_found", "rate_limited", "failed"] as const;

const failure = z.object({
  outcome: z.literal("failed"),
  code: z.enum(HOST_ERROR_CODES),
  message: z.string().max(MAX_ERROR_LINE),
});

const checkSchema = z.object({
  kind: z.enum(["run", "context"]),
  name: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string().nullable(),
});

const itemSchema = z.object({
  id: z.string(),
  kind: z.enum(["review", "comment"]),
  author: z.string(),
  authorIsBot: z.boolean(),
  association: z.string(),
  reviewState: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]).optional(),
  inlineCount: z.number().int().nonnegative(),
  at: z.string(),
  url: z.string(),
  excerpt: z.string().max(MAX_EXCERPT),
});

const snapshotSchema = z.object({
  url: prUrl,
  viewerLogin: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  title: z.string().max(MAX_TITLE),
  headSha: z.string(),
  ci: z.object({
    rollup: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]).nullable(),
    checks: z.array(checkSchema).max(PAGE_SIZE),
    hasNextPage: z.boolean(),
  }),
  items: z.array(itemSchema).max(PAGE_SIZE * 2),
});

export type Snapshot = z.infer<typeof snapshotSchema>;
export type Check = z.infer<typeof checkSchema>;
export type SnapshotItem = z.infer<typeof itemSchema>;
export type HostFailure = z.infer<typeof failure>;

/** Both methods are reads, so bb may retry them once on a slow host. */
export const hostContract = defineRpcContract({
  checkout: {
    experimental_retryable: true,
    input: z.object({ cwd: z.string().min(1) }),
    output: z.discriminatedUnion("outcome", [
      z.object({ outcome: z.literal("pull_request"), url: prUrl }),
      z.object({ outcome: z.literal("none") }),
      failure,
    ]),
  },
  snapshot: {
    experimental_retryable: true,
    input: z.object({
      owner: z.string().regex(/^[\w.-]+$/),
      repo: z.string().regex(/^[\w.-]+$/),
      number: z.number().int().positive(),
    }),
    output: z.discriminatedUnion("outcome", [z.object({ outcome: z.literal("snapshot"), snapshot: snapshotSchema }), failure]),
  },
});

const statusRowSchema = z.object({
  pr: z.string(),
  thread: z.string(),
  claimedBy: z.enum(["agent", "user"]),
  since: z.number(),
  branchBound: z.boolean(),
  headSha: z.string().nullable(),
  ci: z.string(),
  pendingItems: z.number(),
  held: z.string().nullable(),
  mayBeMissing: z.boolean(),
  lastDeliveryAt: z.number().nullable(),
  lastOutcome: z.string().nullable(),
});

export type StatusRow = z.infer<typeof statusRowSchema>;

export const statusOutputSchema = z.object({
  bindings: z.array(statusRowSchema),
  omitted: z.number(),
  thread: z.string().nullable(),
  off: z.boolean().nullable(),
});

export type StatusOutput = z.infer<typeof statusOutputSchema>;
