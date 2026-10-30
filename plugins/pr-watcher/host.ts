// Runs on the machine that holds the checkout: `gh pr view` to read which PR
// a checkout is on, and one constant GraphQL query for a PR's state. No shell.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import {
  experimental_defineHostEntry,
  experimental_runVcsProcess,
  experimental_sanitizeInheritedChildProcessEnv,
} from "@get-bb/plugin-sdk/host";
import { z } from "zod";
import {
  type HostFailure,
  hostContract,
  MAX_ERROR_LINE,
  MAX_EXCERPT,
  MAX_TITLE,
  PR_URL_PATTERN,
  type Snapshot,
  type SnapshotItem,
} from "./contract.ts";

const run = promisify(execFile);

const TIMEOUT_MS = 25_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

const QUERY = `query ($owner: String!, $repo: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      url state isDraft title
      commits(last: 1) { nodes { commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100) {
            pageInfo { hasNextPage }
            nodes {
              __typename
              ... on CheckRun { name status conclusion detailsUrl }
              ... on StatusContext { context state targetUrl }
            }
          }
        }
      } } }
      reviews(last: 100) { nodes {
        id state url body submittedAt authorAssociation
        author { __typename login }
        comments { totalCount }
      } }
      comments(last: 100) { nodes {
        id url body createdAt authorAssociation
        author { __typename login }
      } }
    }
  }
}`;

const author = z.object({ __typename: z.string(), login: z.string() }).nullable();

const responseSchema = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z
      .object({
        pullRequest: z
          .object({
            url: z.string(),
            state: z.enum(["OPEN", "CLOSED", "MERGED"]),
            isDraft: z.boolean(),
            title: z.string(),
            commits: z.object({
              nodes: z.array(
                z.object({
                  commit: z.object({
                    oid: z.string(),
                    statusCheckRollup: z
                      .object({
                        state: z.enum(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"]),
                        contexts: z.object({
                          pageInfo: z.object({ hasNextPage: z.boolean() }),
                          nodes: z.array(
                            z.discriminatedUnion("__typename", [
                              z.object({
                                __typename: z.literal("CheckRun"),
                                name: z.string(),
                                status: z.string(),
                                conclusion: z.string().nullable(),
                                detailsUrl: z.string().nullable(),
                              }),
                              z.object({
                                __typename: z.literal("StatusContext"),
                                context: z.string(),
                                state: z.string(),
                                targetUrl: z.string().nullable(),
                              }),
                            ]),
                          ),
                        }),
                      })
                      .nullable(),
                  }),
                }),
              ),
            }),
            reviews: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
                  url: z.string(),
                  body: z.string(),
                  submittedAt: z.string().nullable(),
                  authorAssociation: z.string(),
                  author,
                  comments: z.object({ totalCount: z.number() }),
                }),
              ),
            }),
            comments: z.object({
              nodes: z.array(
                z.object({
                  id: z.string(),
                  url: z.string(),
                  body: z.string(),
                  createdAt: z.string(),
                  authorAssociation: z.string(),
                  author,
                }),
              ),
            }),
          })
          .nullable(),
      })
      .nullable(),
  }),
});

type ExecError = Error & { code?: unknown; stderr?: string };

const cut = (text: string, max: number) => text.slice(0, max).replace(/[\uD800-\uDBFF]$/u, "");

const failed = (code: HostFailure["code"], message: string): HostFailure => ({
  outcome: "failed",
  code,
  message: cut(message, MAX_ERROR_LINE),
});

const firstLine = (text: string) => text.split("\n").find((line) => line.trim()) ?? "";

function classify(error: ExecError): HostFailure {
  if (error.code === "ENOENT") return failed("gh_missing", "gh is not installed on this machine");
  const stderr = error.stderr ?? "";
  const line = firstLine(stderr) || firstLine(error.message);
  if (/gh auth login|not logged in|HTTP 401|bad credentials/iu.test(stderr)) return failed("gh_unauthenticated", line);
  if (/rate limit/iu.test(stderr)) return failed("rate_limited", line);
  if (/could not resolve to|HTTP 404|not found/iu.test(stderr)) return failed("not_found", line);
  return failed("failed", line);
}

async function gh(args: string[], options: { cwd?: string; signal: AbortSignal }): Promise<string> {
  const { stdout } = await experimental_runVcsProcess(
    "gh",
    args,
    () =>
      run("gh", args, {
        ...options,
        env: { ...experimental_sanitizeInheritedChildProcessEnv({ env: process.env }), GH_PROMPT_DISABLED: "1" },
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      }),
    { priority: "background", signal: options.signal },
  );
  return stdout;
}

const toItem = (fields: Omit<SnapshotItem, "excerpt" | "author" | "authorIsBot"> & {
  author: { __typename: string; login: string } | null;
  body: string;
}): SnapshotItem => {
  const { author: who, body, ...rest } = fields;
  return {
    ...rest,
    author: who?.login ?? "",
    authorIsBot: who?.__typename === "Bot",
    excerpt: cut(body, MAX_EXCERPT),
  };
};

function toSnapshot(response: z.infer<typeof responseSchema>): Snapshot | null {
  const pr = response.data.repository?.pullRequest;
  const commit = pr?.commits.nodes[0]?.commit;
  if (!pr || !commit) return null;
  const rollup = commit.statusCheckRollup;
  const reviews = pr.reviews.nodes.flatMap((review) => {
    if (review.state === "PENDING") return [];
    return [
      toItem({
        id: review.id,
        kind: "review",
        author: review.author,
        association: review.authorAssociation,
        reviewState: review.state,
        inlineCount: review.comments.totalCount,
        at: review.submittedAt ?? "",
        url: review.url,
        body: review.body,
      }),
    ];
  });
  const comments = pr.comments.nodes.map((comment) =>
    toItem({
      id: comment.id,
      kind: "comment",
      author: comment.author,
      association: comment.authorAssociation,
      inlineCount: 0,
      at: comment.createdAt,
      url: comment.url,
      body: comment.body,
    }),
  );
  return {
    url: pr.url,
    viewerLogin: response.data.viewer.login,
    state: pr.state,
    isDraft: pr.isDraft,
    title: cut(pr.title, MAX_TITLE),
    headSha: commit.oid,
    ci: {
      rollup: rollup?.state ?? null,
      hasNextPage: rollup?.contexts.pageInfo.hasNextPage ?? false,
      checks: (rollup?.contexts.nodes ?? []).map((node) =>
        node.__typename === "CheckRun"
          ? { kind: "run", name: node.name, status: node.status, conclusion: node.conclusion, url: node.detailsUrl }
          : { kind: "context", name: node.context, status: node.state, conclusion: null, url: node.targetUrl || null },
      ),
    },
    items: [...reviews, ...comments],
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async checkout({ cwd }, { signal }) {
      // A missing cwd fails with ENOENT too, which would read as a missing gh.
      const isDirectory = await stat(cwd).then((info) => info.isDirectory(), () => false);
      if (!isDirectory) return failed("failed", "the checkout directory is missing");
      try {
        const parsed = z.object({ url: z.string() }).parse(JSON.parse(await gh(["pr", "view", "--json", "url"], { cwd, signal })));
        if (!PR_URL_PATTERN.test(parsed.url)) return failed("failed", "not a github.com pull request");
        return { outcome: "pull_request" as const, url: parsed.url };
      } catch (error) {
        if (signal.aborted) throw error;
        const execError = error as ExecError;
        if (/no pull requests found for branch/iu.test(execError.stderr ?? "")) return { outcome: "none" as const };
        return classify(execError);
      }
    },

    async snapshot({ owner, repo, number }, { signal }) {
      const args = ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`];
      try {
        const snapshot = toSnapshot(responseSchema.parse(JSON.parse(await gh(args, { signal }))));
        if (!snapshot) return failed("not_found", "pull request not found");
        if (!PR_URL_PATTERN.test(snapshot.url)) return failed("failed", "not a github.com pull request");
        return { outcome: "snapshot" as const, snapshot };
      } catch (error) {
        if (signal.aborted) throw error;
        return classify(error as ExecError);
      }
    },
  },
});
