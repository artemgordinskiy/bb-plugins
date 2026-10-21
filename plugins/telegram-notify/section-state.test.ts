import assert from "node:assert/strict";
import test from "node:test";
import type { ChatList } from "./contract.ts";
import {
  addBlankRow,
  addFoundGroup,
  applyStatusRefresh,
  buildSavePayload,
  moveRow,
  rowsFromList,
  suggestName,
  topNotice,
  useNewId,
  visibleStatus,
  type DraftRow,
} from "./section-state.ts";

const list = (chats: ChatList["chats"], tokenSet = true): ChatList => ({ tokenSet, chats });
const chat = (name: string, chatId: string, extra: Partial<ChatList["chats"][number]> = {}) => ({
  name,
  chatId,
  use: "",
  status: "ready" as const,
  ...extra,
});
const rowsOf = (...chats: ChatList["chats"]) => rowsFromList(list(chats), { next: 0 });
const blank = (overrides: Partial<DraftRow> = {}): DraftRow => ({
  key: "k",
  name: "Home",
  chatId: "-1001",
  use: "",
  savedChatId: null,
  info: null,
  ...overrides,
});

test("a status stops showing once its row's chat ID is edited", () => {
  const [row] = rowsOf(chat("Home", "-1001"));
  assert.equal(visibleStatus(row!)?.status, "ready");
  assert.equal(visibleStatus({ ...row!, chatId: "-1002" }), null);
  assert.equal(visibleStatus({ ...row!, chatId: " -1001 " })?.status, "ready");
});

test("a status refresh updates statuses and leaves typed edits alone", () => {
  const rows = rowsOf(chat("Home", "-1001"), chat("Work", "-1002"));
  const edited = rows.map((row, index) => (index === 0 ? { ...row, name: "Home (typing)", use: "notes" } : row));
  const refreshed = applyStatusRefresh(
    edited,
    list([chat("Renamed on server", "-1001", { status: "invalid", reason: "Bot was removed." }), chat("Work", "-1002")]),
  );
  assert.equal(refreshed[0]!.name, "Home (typing)");
  assert.equal(refreshed[0]!.use, "notes");
  assert.equal(refreshed[0]!.info?.status, "invalid");
  assert.equal(refreshed[0]!.info?.reason, "Bot was removed.");
});

test("a refresh does not touch rows that were never saved", () => {
  const added = [blank({ chatId: "-1001" })];
  assert.deepEqual(applyStatusRefresh(added, list([chat("Other", "-1001")])), added);
});

test("a found group becomes a row with its title as the name, made unique", () => {
  const counter = { next: 10 };
  const first = addFoundGroup([], { chatId: "-1001", title: "Family", type: "supergroup" }, counter);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.rows[0]!.name, "Family");
  assert.equal(first.rows[0]!.chatId, "-1001");
  assert.equal(first.rows[0]!.savedChatId, null);
  const second = addFoundGroup(first.rows, { chatId: "-1002", title: "family", type: "group" }, counter);
  assert.equal(second.ok && second.rows[1]!.name, "family 2");
});

test("a long or empty title still gives a valid name", () => {
  assert.ok(suggestName("x".repeat(80), []).length <= 32);
  assert.equal(suggestName("   ", []), "Group");
  const crowded = suggestName("x".repeat(80), [blank({ name: suggestName("x".repeat(80), []) })]);
  assert.ok(crowded.length <= 32 && crowded.endsWith(" 2"));
});

test("adding stops at the limit and refuses a group that is already listed", () => {
  const counter = { next: 0 };
  const full = Array.from({ length: 10 }, (_, index) => blank({ key: `r${index}`, name: `N${index}`, chatId: `-${index + 1}` }));
  assert.equal(addFoundGroup(full, { chatId: "-99", title: "T", type: "group" }, counter).ok, false);
  assert.equal(addBlankRow(full, counter), full);
  const dup = addFoundGroup([blank()], { chatId: "-1001", title: "T", type: "group" }, counter);
  assert.equal(dup.ok, false);
});

test("Use new ID fills the migrated ID but leaves the saved one alone until saving", () => {
  const rows = rowsOf(chat("Home", "-1001", { status: "invalid", reason: "Moved.", migrateToChatId: "-1009" }));
  const next = useNewId(rows, rows[0]!.key);
  assert.equal(next[0]!.chatId, "-1009");
  assert.equal(next[0]!.savedChatId, "-1001");
  // The old status was about the old ID, so it is hidden now.
  assert.equal(visibleStatus(next[0]!), null);
  assert.equal(useNewId(rows, "missing")[0]!.chatId, "-1001");
});

test("rows move within bounds", () => {
  const rows = rowsOf(chat("A", "-1"), chat("B", "-2"), chat("C", "-3"));
  assert.deepEqual(moveRow(rows, 2, -1).map((row) => row.name), ["A", "C", "B"]);
  assert.equal(moveRow(rows, 0, -1), rows);
  assert.equal(moveRow(rows, 2, 1), rows);
});

test("the save payload trims and mirrors the server's checks", () => {
  const ok = buildSavePayload([blank({ name: " Home ", chatId: " -1001 ", use: " infra " })]);
  assert.deepEqual(ok, { ok: true, chats: [{ name: "Home", chatId: "-1001", use: "infra" }] });

  const noName = buildSavePayload([blank(), blank({ name: "  " })]);
  assert.equal(noName.ok, false);
  if (!noName.ok) assert.equal(noName.row, 1);

  const badId = buildSavePayload([blank({ chatId: "abc" })]);
  assert.equal(badId.ok === false && badId.row, 0);

  const dupName = buildSavePayload([blank({ chatId: "-1" }), blank({ name: "HOME", chatId: "-2" })]);
  assert.equal(dupName.ok, false);
  const dupId = buildSavePayload([blank({ name: "A", chatId: "-1" }), blank({ name: "B", chatId: "-1" })]);
  assert.equal(dupId.ok, false);

  const tooMany = buildSavePayload(
    Array.from({ length: 11 }, (_, index) => blank({ name: `N${index}`, chatId: `-${index + 1}` })),
  );
  assert.equal(tooMany.ok, false);
  if (!tooMany.ok) assert.equal(tooMany.row, null);
});

test("top notices say why agents don't get the tool", () => {
  assert.equal(topNotice([], false), "no-token");
  assert.equal(topNotice([], true), "no-chats");
  assert.equal(topNotice(rowsOf(chat("A", "-1", { status: "invalid" })), true), "all-invalid");
  assert.equal(topNotice(rowsOf(chat("A", "-1", { status: "invalid" }), chat("B", "-2")), true), null);
  // A row that was just added has not been checked, so it doesn't count as invalid.
  assert.equal(topNotice([...rowsOf(chat("A", "-1", { status: "invalid" })), blank()], true), null);
});
