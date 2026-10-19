import assert from "node:assert/strict";
import { test } from "node:test";
import { currentServer, desktopChoiceFor, parseDesktopChoices, parseServers } from "./servers.ts";

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

test("matches configured servers to desktop choices by host", () => {
  const [home, work] = servers();
  const choices = [
    { id: "builtin", name: "This Mac", active: false },
    { id: "custom:1", name: "bb.example.com", active: true },
  ];
  assert.equal(desktopChoiceFor(home, choices)?.id, "custom:1");
  assert.equal(desktopChoiceFor(work, choices), undefined);
});

test("current server prefers the desktop app's active choice over the page host", () => {
  const list = servers();
  const choices = [
    { id: "custom:1", name: "bb.example.com", active: false },
    { id: "custom:2", name: "bb-work.example.com", active: true },
  ];
  assert.equal(currentServer(list, "localhost:5173", choices)?.name, "work");
  assert.equal(currentServer(list, "bb.example.com", null)?.name, "home");
  assert.equal(currentServer(list, "elsewhere.example", null), undefined);
});
