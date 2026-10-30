import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import entry from "./host.ts";

const dir = mkdtempSync(join(tmpdir(), "pr-watcher-host-"));
const args = join(dir, "args");
const cwdLog = join(dir, "cwd");
const stdout = join(dir, "stdout");
const stderr = join(dir, "stderr");
const code = join(dir, "code");
const savedPath = process.env.PATH;
const harness = experimental_createHostEntryHarness(entry);

function gh(reply: { stdout?: string; stderr?: string; code?: number }) {
  writeFileSync(stdout, reply.stdout ?? "");
  writeFileSync(stderr, reply.stderr ?? "");
  writeFileSync(code, String(reply.code ?? 0));
}

before(() => {
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/sh
printf '%s\\n' "$@" > '${args}'
pwd > '${cwdLog}'
cat '${stdout}'
cat '${stderr}' >&2
exit "$(cat '${code}')"
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  process.env.PATH = `${dir}:${savedPath}`;
});

after(async () => {
  process.env.PATH = savedPath;
  await harness.experimental_dispose();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(args, { force: true });
  gh({});
});

const pullRequest = (over: Record<string, unknown> = {}) => ({
  url: "https://github.com/acme/api/pull/42",
  state: "OPEN",
  isDraft: true,
  title: "Add retry",
  commits: {
    nodes: [
      {
        commit: {
          oid: "abc1234",
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              pageInfo: { hasNextPage: true },
              nodes: [
                { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/api/runs/1" },
                { __typename: "StatusContext", context: "ci/ext", state: "PENDING", targetUrl: "" },
              ],
            },
          },
        },
      },
    ],
  },
  reviews: {
    nodes: [
      {
        id: "R1",
        state: "CHANGES_REQUESTED",
        url: "https://github.com/acme/api/pull/42#pullrequestreview-1",
        body: "x".repeat(500),
        submittedAt: "2026-10-30T10:00:00Z",
        author: { __typename: "Bot", login: "coderabbitai" },
        authorAssociation: "NONE",
        comments: { totalCount: 3 },
      },
      { id: "draft", state: "PENDING", url: "u", body: "", submittedAt: null, author: null, authorAssociation: "NONE", comments: { totalCount: 0 } },
    ],
  },
  comments: {
    nodes: [
      {
        id: "C1",
        url: "https://github.com/acme/api/pull/42#issuecomment-1",
        body: "hello",
        createdAt: "2026-10-30T11:00:00Z",
        author: null,
        authorAssociation: "NONE",
      },
    ],
  },
  ...over,
});

const graphql = (pr: unknown = pullRequest()) => JSON.stringify({ data: { viewer: { login: "me" }, repository: { pullRequest: pr } } });

const ask = () => harness.experimental_call("snapshot", { owner: "acme", repo: "api", number: 42 });

test("checkout: returns the PR URL from gh pr view, run in cwd", async () => {
  gh({ stdout: JSON.stringify({ url: "https://github.com/acme/api/pull/42" }) });
  const result = await harness.experimental_call("checkout", { cwd: dir });
  assert.deepEqual(result, { outcome: "pull_request", url: "https://github.com/acme/api/pull/42" });
  assert.deepEqual(readFileSync(args, "utf8").trim().split("\n"), ["pr", "view", "--json", "url"]);
  assert.ok(readFileSync(cwdLog, "utf8").trim().endsWith(dir.split("/").at(-1)!));
});

test("checkout: only gh's own message means no pull request", async () => {
  gh({ stderr: 'no pull requests found for branch "feature"\n', code: 1 });
  assert.deepEqual(await harness.experimental_call("checkout", { cwd: dir }), { outcome: "none" });
});

test("checkout: any other gh error is a failure, not none", async () => {
  gh({ stderr: "fatal: not on any branch\n", code: 1 });
  const result = await harness.experimental_call("checkout", { cwd: dir });
  assert.deepEqual(result, { outcome: "failed", code: "failed", message: "fatal: not on any branch" });
});

test("checkout: a missing cwd is not reported as a missing gh", async () => {
  const result = await harness.experimental_call("checkout", { cwd: join(dir, "gone") });
  assert.equal(result.outcome, "failed");
  assert.ok(result.outcome === "failed" && result.code === "failed");
});

test("checkout: a PR URL outside github.com is a failure", async () => {
  gh({ stdout: JSON.stringify({ url: "https://ghe.example/acme/api/pull/42" }) });
  const result = await harness.experimental_call("checkout", { cwd: dir });
  assert.equal(result.outcome, "failed");
});

test("snapshot: sends the query with typed variables and no working directory input", async () => {
  gh({ stdout: graphql() });
  await ask();
  const sent = readFileSync(args, "utf8");
  assert.ok(sent.startsWith("api\ngraphql\n"));
  assert.ok(sent.includes("owner=acme\n"));
  assert.ok(sent.includes("repo=api\n"));
  assert.ok(sent.includes("number=42\n"));
  assert.ok(sent.includes("reviews(last: 100)"));
  assert.ok(sent.includes("comments(last: 100)"));
  assert.ok(sent.includes("contexts(first: 100)"));
});

test("snapshot: maps the response", async () => {
  gh({ stdout: graphql() });
  const result = await ask();
  assert.ok(result.outcome === "snapshot");
  const { snapshot } = result;
  assert.equal(snapshot.url, "https://github.com/acme/api/pull/42");
  assert.equal(snapshot.viewerLogin, "me");
  assert.equal(snapshot.state, "OPEN");
  assert.equal(snapshot.isDraft, true);
  assert.equal(snapshot.headSha, "abc1234");
  assert.deepEqual(snapshot.ci, {
    rollup: "FAILURE",
    hasNextPage: true,
    checks: [
      { kind: "run", name: "lint", status: "COMPLETED", conclusion: "FAILURE", url: "https://github.com/acme/api/runs/1" },
      { kind: "context", name: "ci/ext", status: "PENDING", conclusion: null, url: null },
    ],
  });
  const [review, comment] = snapshot.items;
  assert.equal(snapshot.items.length, 2, "the viewer's unsubmitted review is left out");
  assert.equal(review?.author, "coderabbitai");
  assert.equal(review?.authorIsBot, true);
  assert.equal(review?.reviewState, "CHANGES_REQUESTED");
  assert.equal(review?.inlineCount, 3);
  assert.equal(review?.excerpt.length, 300);
  assert.equal(comment?.author, "");
  assert.equal(comment?.authorIsBot, false);
  assert.equal(comment?.kind, "comment");
});

test("snapshot: no rollup yet", async () => {
  gh({ stdout: graphql(pullRequest({ commits: { nodes: [{ commit: { oid: "abc1234", statusCheckRollup: null } }] } })) });
  const result = await ask();
  assert.ok(result.outcome === "snapshot");
  assert.deepEqual(result.snapshot.ci, { rollup: null, checks: [], hasNextPage: false });
});

test("snapshot: caps a long title", async () => {
  gh({ stdout: graphql(pullRequest({ title: "t".repeat(1000) })) });
  const result = await ask();
  assert.ok(result.outcome === "snapshot" && result.snapshot.title.length === 300);
});

test("snapshot: a null pull request is not_found", async () => {
  gh({ stdout: graphql(null) });
  const result = await ask();
  assert.ok(result.outcome === "failed" && result.code === "not_found");
});

test("snapshot: an unreadable response is a failure", async () => {
  gh({ stdout: "not json" });
  const result = await ask();
  assert.ok(result.outcome === "failed" && result.code === "failed");
});

test("typed errors from gh's stderr, cut to one line of 200 chars", async () => {
  const cases = [
    ["gh auth login\nmore", "gh_unauthenticated"],
    ["HTTP 401: Bad credentials", "gh_unauthenticated"],
    ["GraphQL: API rate limit exceeded for user", "rate_limited"],
    ["GraphQL: Could not resolve to a Repository with the name 'acme/api'.", "not_found"],
    ["boom\nsecond line", "failed"],
  ] as const;
  for (const [text, expected] of cases) {
    gh({ stderr: text, code: 1 });
    const result = await ask();
    assert.ok(result.outcome === "failed");
    assert.equal(result.code, expected, text);
    assert.equal(result.message, text.split("\n")[0]);
  }
  gh({ stderr: "e".repeat(500), code: 1 });
  const long = await ask();
  assert.ok(long.outcome === "failed" && long.message.length === 200);
});

test("a missing gh is gh_missing", async () => {
  process.env.PATH = join(dir, "empty");
  try {
    const result = await ask();
    assert.ok(result.outcome === "failed" && result.code === "gh_missing");
  } finally {
    process.env.PATH = `${dir}:${savedPath}`;
  }
});

test("invalid owner, repo or number never reach gh", async () => {
  await assert.rejects(harness.experimental_call("snapshot", { owner: "a b", repo: "api", number: 1 }));
  await assert.rejects(harness.experimental_call("snapshot", { owner: "acme", repo: "--x;y", number: 1 }));
  await assert.rejects(harness.experimental_call("snapshot", { owner: "acme", repo: "api", number: 0 }));
});
