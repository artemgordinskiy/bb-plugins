import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, DEFAULT_INSTRUCTION, parseBotAuthors, parseRoles, SETTINGS, type SettingsValues, toConfig } from "./config.ts";
import { nextPollDelay } from "./triggers.ts";

const defaults = Object.fromEntries(Object.entries(SETTINGS).map(([key, descriptor]) => [key, descriptor.default])) as SettingsValues;

test("every setting has a default, and the defaults give the documented behaviour", () => {
  for (const [key, descriptor] of Object.entries(SETTINGS)) assert.notEqual(descriptor.default, undefined, key);
  assert.equal(DEFAULT_CONFIG.instructionLine, DEFAULT_INSTRUCTION);
  assert.equal(DEFAULT_CONFIG.optionalFailures, "wake");
  assert.equal(DEFAULT_CONFIG.feedback.bareApprovals, false);
  assert.deepEqual([...DEFAULT_CONFIG.feedback.roles], ["OWNER", "MEMBER", "COLLABORATOR"]);
  assert.deepEqual([DEFAULT_CONFIG.quietMs, DEFAULT_CONFIG.activePollMs, DEFAULT_CONFIG.idlePollMs], [120_000, 60_000, 300_000]);
});

test("every select default is one of its options", () => {
  for (const [key, descriptor] of Object.entries(SETTINGS)) {
    if (descriptor.type === "select") assert.ok((descriptor.options as string[]).includes(String(descriptor.default)), key);
  }
});

test("an unknown select value falls back to its default", () => {
  const config = toConfig({ ...defaults, ciPassWakes: "sometimes", optionalCheckFailures: "shout", approvalWakes: "?" });
  assert.equal(config.wake.ciPassWakes, "after-failure");
  assert.equal(config.optionalFailures, "wake");
  assert.equal(config.feedback.bareApprovals, false);
});

test("times are clamped to their ranges and given in milliseconds", () => {
  const config = toConfig({ ...defaults, quietSeconds: -5, activePollSeconds: 5, idlePollSeconds: 99_999 });
  assert.deepEqual([config.quietMs, config.activePollMs, config.idlePollMs], [0, 30_000, 3_600_000]);
  assert.equal(toConfig({ ...defaults, quietSeconds: Number.NaN }).quietMs, 120_000);
});

test("bot and role lists are trimmed and normalised", () => {
  assert.deepEqual([...parseBotAuthors(" CodeRabbitAI[bot] , claude,, ")], ["coderabbitai", "claude"]);
  assert.deepEqual([...parseRoles(" owner, ,member ")], ["OWNER", "MEMBER"]);
});

test("the poll intervals come from the settings", () => {
  const timing = { activePollMs: 30_000, idlePollMs: 600_000 };
  assert.equal(nextPollDelay({ kind: "running" }, null, 0, timing), 30_000);
  assert.equal(nextPollDelay({ kind: "none" }, null, 0, timing), 600_000);
});
