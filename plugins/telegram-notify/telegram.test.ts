import assert from "node:assert/strict";
import test from "node:test";
import { listError, parseChatId, toOneLine, truncate } from "./rules.ts";
import { callApi, escapeHtml, redact, type Fetch } from "./telegram.ts";

const TOKEN = "123456:FAKE-token-for-tests";
const config = (fetch: Fetch, timeoutMs = 1000) => ({ token: TOKEN, fetch, timeoutMs });

test("redact removes the token and anything shaped like one", () => {
  assert.equal(redact(`error at /bot${TOKEN}/sendMessage`, TOKEN), "error at /bot[token]/sendMessage");
  assert.equal(redact("bot999999:other-Token_1 failed", TOKEN), "bot[token] failed");
  assert.equal(redact(`token ${TOKEN}`, TOKEN), "token [token]");
});

test("a failed fetch is described without the URL", async () => {
  const result = await callApi(
    config(async (url) => {
      throw new TypeError(`fetch failed for ${url}`);
    }),
    "getMe",
    {},
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.network && result.errorCode === null);
  assert.ok(!JSON.stringify(result).includes("FAKE-token"));
});

test("an HTTP error without JSON still reports the status", async () => {
  const result = await callApi(config(async () => new Response("<html>", { status: 502 })), "getMe", {});
  assert.ok(!result.ok);
  assert.equal(result.errorCode, 502);
  assert.equal(result.description, "HTTP 502");
  assert.equal(result.network, false);
});

test("a caller's abort and the timeout both end the request", async () => {
  const hanging: Fetch = (_url, init) =>
    new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
  const timedOut = await callApi(config(hanging, 10), "getMe", {});
  assert.ok(!timedOut.ok && timedOut.network && /timed out/.test(timedOut.description));
  const controller = new AbortController();
  const pending = callApi(config(hanging, 5000), "getMe", {}, controller.signal);
  controller.abort();
  const cancelled = await pending;
  assert.ok(!cancelled.ok && cancelled.network && /cancelled/.test(cancelled.description));
});

test("escapeHtml handles the three characters Telegram needs", () => {
  assert.equal(escapeHtml(`<a href="x">&</a>`), `&lt;a href="x"&gt;&amp;&lt;/a&gt;`);
});

test("truncate counts characters, not UTF-16 units, and ends in an ellipsis", () => {
  assert.equal(truncate("abc", 3), "abc");
  assert.equal(truncate("abcd", 3), "ab…");
  assert.equal(truncate("😀😀😀😀", 3), "😀😀…");
});

test("toOneLine collapses whitespace and control characters", () => {
  assert.equal(toOneLine("  a\n\nb\t c d\u0007e "), "a b c d e");
});

test("parseChatId accepts safe nonzero integers up to 16 digits", () => {
  assert.equal(parseChatId("-1001234567890"), -1001234567890);
  assert.equal(parseChatId("42"), 42);
  assert.equal(parseChatId("0"), null);
  assert.equal(parseChatId("-0"), null);
  assert.equal(parseChatId("9007199254740993"), null);
  assert.equal(parseChatId("12345678901234567"), null);
  assert.equal(parseChatId("1e5"), null);
  assert.equal(parseChatId(""), null);
});

test("listError reports the first duplicate in row order", () => {
  assert.equal(listError([{ name: "A", chatId: 1 }, { name: "B", chatId: 2 }]), null);
  assert.deepEqual(listError([{ name: "A", chatId: 1 }, { name: "a", chatId: 2 }, { name: "C", chatId: 1 }])?.row, 1);
  assert.deepEqual(listError([{ name: "A", chatId: 1 }, { name: "B", chatId: 1 }])?.row, 1);
});
