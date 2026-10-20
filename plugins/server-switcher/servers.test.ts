import assert from "node:assert/strict";
import { test } from "node:test";
import {
  currentServer,
  customServerId,
  matchDesktopChoices,
  parseDesktopChoices,
  parseServers,
} from "./servers.ts";

const LIST = `
# servers
home https://bb.example.com
work https://bb-work.example.com/
lan http://192.168.0.10:38886
`;

function servers() {
  const result = parseServers(LIST);
  assert.ok(result.ok);
  return result.servers;
}

test("parses names and normalizes URLs, skipping blanks and comments", () => {
  assert.deepEqual(servers(), [
    { name: "home", url: "https://bb.example.com", host: "bb.example.com" },
    { name: "work", url: "https://bb-work.example.com", host: "bb-work.example.com" },
    { name: "lan", url: "http://192.168.0.10:38886", host: "192.168.0.10:38886" },
  ]);
});

test("rejects malformed lines with the line number", () => {
  for (const [text, error] of [
    ["bb", 'Line 1: expected "<name> <url>"'],
    ["bb not-a-url", 'Line 1: "not-a-url" is not a URL'],
    ["bb ftp://bb.example.com", "Line 1: URL must use http or https"],
    ["bb https://bb.example.com/app", "Line 1: use the server's root URL, without a path"],
    ["a https://bb.example.com\nb https://bb.example.com/", "Line 2: bb.example.com is listed twice"],
  ] as const) {
    assert.deepEqual(parseServers(text), { ok: false, error });
  }
});

test("an empty setting is a valid empty list", () => {
  assert.deepEqual(parseServers(""), { ok: true, servers: [] });
});

test("desktop choices must have the expected shape", () => {
  assert.deepEqual(parseDesktopChoices([{ id: "custom:1", name: "bb.example.com", active: true }]), [
    { id: "custom:1", name: "bb.example.com", active: true },
  ]);
  assert.equal(parseDesktopChoices([{ id: "custom:1", name: "bb.example.com" }]), null);
  assert.equal(parseDesktopChoices({}), null);
});

const HOME_ID = "custom:27507868b77da4d1bac952f1cc060bba77573107e64d18889f34adeeb434279e";
const WORK_ID = "custom:49a8a483c3dfce9622de628b87c61d9dc6eb2790f2293cfb8a84475a2dcb7278";

test("derives the desktop app's custom-server id from the URL", async () => {
  assert.equal(await customServerId("https://bb.example.com"), HOME_ID);
});

test("matches desktop choices by custom-server id, even when renamed", () => {
  const [home, work] = servers();
  const ids = new Map([
    [home.url, HOME_ID],
    [work.url, WORK_ID],
  ]);
  const choices = [
    { id: "builtin", name: "This Mac", active: false },
    { id: HOME_ID, name: "bb.example.com", active: true },
    { id: WORK_ID, name: "work", active: false },
  ];
  const matches = matchDesktopChoices([home, work], ids, choices);
  assert.equal(matches.get(home.host)?.id, HOME_ID);
  assert.equal(matches.get(work.host)?.id, WORK_ID);
});

test("falls back to the host name when no id matches", () => {
  const [home, work] = servers();
  const choices = [{ id: "connect:abc", name: "bb.example.com", active: true }];
  const matches = matchDesktopChoices([home, work], new Map(), choices);
  assert.equal(matches.get(home.host)?.id, "connect:abc");
  assert.equal(matches.has(work.host), false);
});

test("current server prefers the desktop app's active choice over the page host", () => {
  const list = servers();
  const [home, work] = list;
  const ids = new Map([
    [home.url, HOME_ID],
    [work.url, WORK_ID],
  ]);
  const matches = matchDesktopChoices(list, ids, [
    { id: HOME_ID, name: "bb.example.com", active: false },
    { id: WORK_ID, name: "work", active: true },
  ]);
  assert.equal(currentServer(list, "localhost:5173", matches)?.name, "work");
  assert.equal(currentServer(list, "bb.example.com", null)?.name, "home");
  assert.equal(currentServer(list, "elsewhere.example", null), undefined);
});
