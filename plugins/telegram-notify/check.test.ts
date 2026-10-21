import assert from "node:assert/strict";
import test from "node:test";
import type { ChatBook } from "./chats.ts";
import type { ChatList } from "./contract.ts";
import { setup } from "./server.ts";
import { FakeTelegram, TOKEN, boot, configContext, fail, hang, network, ok, until, withPlugin } from "./test-support.ts";

const HOME = "-1001000000001";
const ADMIN = "-1001000000002";

const statusOf = (list: ChatList, name: string) => list.chats.find((chat) => chat.name === name);

test("a good chat is checked after load and reported ready", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001).addGroup(-1001000000002);
  await withPlugin({ tg }, async ({ harness, save, settle }) => {
    await save([
      { name: "Home", chatId: HOME },
      { name: "Home Admin", chatId: ADMIN },
    ]);
    await settle();
    const list = (await harness.callRpc("listChats", null)) as ChatList;
    assert.equal(list.tokenSet, true);
    assert.deepEqual(list.chats.map((chat) => chat.status), ["ready", "ready"]);
    // getMe runs once per round, not once per chat.
    assert.equal(tg.callsTo("getMe").length, 1);
    assert.equal(tg.callsTo("getChat").length, 2);
    assert.equal(tg.callsTo("getChatMember").length, 2);
    assert.deepEqual(tg.callsTo("getChatMember")[0]?.body, { chat_id: -1001000000001, user_id: 4242 });
  });
});

test("chats saved earlier are checked when the plugin loads", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001);
  const first = await boot({ tg });
  await first.save([{ name: "Home", chatId: HOME }]);
  await first.settle();

  // A reload keeps the database; the in-memory status starts unknown and the service decides it again.
  let book: ChatBook | undefined;
  const reloaded = await first.harness.lifecycle.reload(async (bb) => {
    book = await setup(bb, { fetch: tg.fetch, now: () => first.clock.now, sleep: first.sleeper.sleep, timeoutMs: 10_000 });
  });
  try {
    const list = (await reloaded.harness.callRpc("listChats", null)) as ChatList;
    assert.equal(list.chats[0]?.status, "unknown");
    assert.equal(list.chats[0]?.reason, "Not checked yet.");
    reloaded.harness.runService("check");
    await book?.idle();
    assert.equal(statusOf((await reloaded.harness.callRpc("listChats", null)) as ChatList, "Home")?.status, "ready");
  } finally {
    await reloaded.harness.lifecycle.dispose();
  }
});

test("a rejected token sets needsConfiguration once and the tool is not offered", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001);
  tg.acceptedToken = "another-token";
  await withPlugin({ tg }, async ({ harness, save, settle }) => {
    await save([{ name: "Home", chatId: HOME }]);
    await settle();
    assert.equal(harness.needsConfigurationMessages.length, 1);
    assert.match(harness.needsConfigurationMessages[0] ?? "", /rejected the bot token/);
    const config = await harness.resolveAgentConfiguration(configContext());
    assert.deepEqual(config.tools, []);
    const list = (await harness.callRpc("listChats", null)) as ChatList;
    assert.equal(list.chats[0]?.status, "unknown");
    assert.match(list.chats[0]?.reason ?? "", /rejected the bot token/);
  });
});

test("a missing token sets needsConfiguration and shows the chats as unchecked", async () => {
  await withPlugin({ settings: { botToken: "" } }, async ({ tg, harness, save, settle }) => {
    assert.equal(harness.needsConfigurationMessages.length, 1);
    await save([{ name: "Home", chatId: HOME }]);
    await settle();
    const list = (await harness.callRpc("listChats", null)) as ChatList;
    assert.equal(list.tokenSet, false);
    assert.equal(list.chats[0]?.status, "unknown");
    assert.equal(tg.calls.length, 0);
    assert.deepEqual((await harness.resolveAgentConfiguration(configContext())).tools, []);
  });
});

test("channels, private chats and forum groups are invalid with a reason", async () => {
  const tg = new FakeTelegram()
    .addGroup(-1001000000010, { type: "channel" })
    .addGroup(1001000000011, { type: "private" })
    .addGroup(-1001000000012, { is_forum: true });
  await withPlugin({ tg }, async ({ harness, save, settle }) => {
    await save([
      { name: "Channel", chatId: "-1001000000010" },
      { name: "Private", chatId: "1001000000011" },
      { name: "Forum", chatId: "-1001000000012" },
    ]);
    await settle();
    const list = (await harness.callRpc("listChats", null)) as ChatList;
    assert.deepEqual(list.chats.map((chat) => chat.status), ["invalid", "invalid", "invalid"]);
    assert.match(statusOf(list, "Channel")?.reason ?? "", /channel chat/);
    assert.match(statusOf(list, "Forum")?.reason ?? "", /topics/);
    // The membership call is skipped once the type is refused.
    assert.equal(tg.callsTo("getChatMember").length, 0);
    assert.deepEqual((await harness.resolveAgentConfiguration(configContext())).tools, []);
  });
});

test("the bot's membership decides the status", async () => {
  const cases: { name: string; chat: Parameters<FakeTelegram["addGroup"]>[1]; status: string; reason?: RegExp }[] = [
    { name: "Member", chat: { member: { status: "member" }, canSend: true }, status: "ready" },
    { name: "Admin", chat: { member: { status: "administrator" }, canSend: false }, status: "ready" },
    { name: "Left", chat: { member: { status: "left" } }, status: "invalid", reason: /isn't in this group/ },
    { name: "Kicked", chat: { member: { status: "kicked" } }, status: "invalid", reason: /removed from this group/ },
    { name: "Barred", chat: { member: { status: "member" }, canSend: false }, status: "invalid", reason: /Members can't post/ },
    {
      name: "Gone",
      chat: { member: { status: "restricted", is_member: false, can_send_messages: true } },
      status: "invalid",
      reason: /no longer in this group/,
    },
    {
      name: "Muted",
      chat: { member: { status: "restricted", is_member: true, can_send_messages: false } },
      status: "invalid",
      reason: /restricted from sending/,
    },
    {
      name: "Allowed",
      chat: { member: { status: "restricted", is_member: true, can_send_messages: true } },
      status: "ready",
    },
  ];
  const tg = new FakeTelegram();
  for (const [index, entry] of cases.entries()) tg.addGroup(-1002000000000 - index, entry.chat);
  await withPlugin({ tg }, async ({ harness, save, settle }) => {
    await save(cases.map((entry, index) => ({ name: entry.name, chatId: String(-1002000000000 - index) })));
    await settle();
    const list = (await harness.callRpc("listChats", null)) as ChatList;
    for (const entry of cases) {
      const row = statusOf(list, entry.name);
      assert.equal(row?.status, entry.status, entry.name);
      if (entry.reason) assert.match(row?.reason ?? "", entry.reason, entry.name);
      else assert.equal(row?.reason, undefined, entry.name);
    }
  });
});

test("a chat Telegram doesn't know is invalid", async () => {
  await withPlugin({}, async ({ harness, save, settle }) => {
    await save([{ name: "Nowhere", chatId: "-1001999999999" }]);
    await settle();
    const row = ((await harness.callRpc("listChats", null)) as ChatList).chats[0];
    assert.equal(row?.status, "invalid");
    assert.match(row?.reason ?? "", /Chat not found/);
  });
});

test("one invalid chat leaves the others working", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001).addGroup(-1001000000002, { member: { status: "kicked" } });
  await withPlugin({ tg }, async ({ harness, save, settle }) => {
    await save([
      { name: "Home", chatId: HOME },
      { name: "Home Admin", chatId: ADMIN },
    ]);
    await settle();
    const config = await harness.resolveAgentConfiguration(configContext());
    assert.deepEqual(config.tools.map((tool) => tool.name), ["telegram_notify"]);
    assert.equal(await harness.callAgentTool("telegram_notify", { title: "T", message: "M", chat: "Home" }), "Sent to Home.");
  });
});

test("a network failure leaves the chat unknown, still offered, and re-checks with backoff", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001);
  let down = true;
  tg.on("getMe", () => (down ? network() : undefined));
  await withPlugin({ tg }, async ({ harness, sleeper, save, settle }) => {
    await save([{ name: "Home", chatId: HOME }]);
    await until(() => sleeper.requested.length === 1, "first backoff");
    assert.deepEqual(sleeper.requested, [30_000]);

    const list = (await harness.callRpc("listChats", null)) as ChatList;
    assert.equal(list.chats[0]?.status, "unknown");
    assert.deepEqual(harness.needsConfigurationMessages, []);
    // Still offered, and sends go through.
    assert.deepEqual((await harness.resolveAgentConfiguration(configContext())).tools.map((tool) => tool.name), [
      "telegram_notify",
    ]);

    // Still down: the pause doubles.
    sleeper.release();
    await until(() => sleeper.requested.length === 2, "second backoff");
    assert.deepEqual(sleeper.requested, [30_000, 60_000]);

    down = false;
    const before = harness.realtimeSignals.length;
    sleeper.release();
    await settle();
    assert.equal(((await harness.callRpc("listChats", null)) as ChatList).chats[0]?.status, "ready");
    assert.ok(harness.realtimeSignals.length > before, "the status change was published");
  });
});

test("the backoff stops at 15 minutes", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001);
  tg.on("getMe", () => fail(502, "Bad Gateway"));
  await withPlugin({ tg }, async ({ sleeper, save }) => {
    await save([{ name: "Home", chatId: HOME }]);
    for (let n = 1; n <= 8; n += 1) {
      await until(() => sleeper.requested.length === n, `backoff ${n}`);
      sleeper.release();
    }
    assert.deepEqual(sleeper.requested, [30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });
});

test("a timeout and a 429 are unknown, not invalid", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001).addGroup(-1001000000002);
  tg.on("getChat", (body) => (body.chat_id === -1001000000001 ? hang() : fail(429, "Too Many Requests", { retry_after: 3 })));
  await withPlugin({ tg, timeoutMs: 20 }, async ({ harness, save, sleeper }) => {
    await save([
      { name: "Home", chatId: HOME },
      { name: "Home Admin", chatId: ADMIN },
    ]);
    await until(() => sleeper.requested.length === 1, "backoff");
    const list = (await harness.callRpc("listChats", null)) as ChatList;
    assert.deepEqual(list.chats.map((chat) => chat.status), ["unknown", "unknown"]);
    assert.deepEqual(harness.needsConfigurationMessages, []);
  });
});

test("no chats: the tool is not offered and no status is set", async () => {
  await withPlugin({}, async ({ harness, settle }) => {
    await settle();
    assert.deepEqual((await harness.resolveAgentConfiguration(configContext())).tools, []);
    assert.deepEqual(harness.needsConfigurationMessages, []);
    assert.deepEqual(((await harness.callRpc("listChats", null)) as ChatList).chats, []);
  });
});

test("checkChat checks any ID, including one that isn't saved yet, and stores nothing for it", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000077, { title: "Fresh group" });
  await withPlugin({ tg }, async ({ harness }) => {
    const result = await harness.callRpc("checkChat", { chatId: "-1001000000077" });
    assert.deepEqual(result, { status: "ready", title: "Fresh group" });
    assert.equal(((await harness.callRpc("listChats", null)) as ChatList).chats.length, 0);
    const missing = await harness.callRpc("checkChat", { chatId: "-1001000000078" });
    assert.equal((missing as { status: string }).status, "invalid");
  });
});

test("the Check button updates a saved chat's status and publishes it", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001, { member: { status: "left" } });
  await withPlugin({ tg }, async ({ harness, save, settle }) => {
    await save([{ name: "Home", chatId: HOME }]);
    await settle();
    assert.equal(statusOf((await harness.callRpc("listChats", null)) as ChatList, "Home")?.status, "invalid");

    tg.chats.get(-1001000000001)!.member = { status: "member" };
    const before = harness.realtimeSignals.length;
    await harness.callRpc("checkChat", { chatId: HOME });
    assert.equal(statusOf((await harness.callRpc("listChats", null)) as ChatList, "Home")?.status, "ready");
    assert.ok(harness.realtimeSignals.slice(before).some((signal) => signal.channel === "chats"));
  });
});

test("the token never appears in logs, RPC results or errors", async () => {
  const tg = new FakeTelegram().addGroup(-1001000000001);
  tg.on("getMe", () => network());
  tg.on("getUpdates", () => fail(502, `Bad Gateway for /bot${TOKEN}/getUpdates`));
  await withPlugin({ tg }, async ({ harness, save, sleeper }) => {
    await save([{ name: "Home", chatId: HOME }]);
    await until(() => sleeper.requested.length === 1, "backoff");
    const seen: string[] = [JSON.stringify(await harness.callRpc("listChats", null))];
    seen.push(JSON.stringify(await harness.callRpc("checkChat", { chatId: HOME })));
    await assert.rejects(
      () => harness.callRpc("findGroups", null),
      (error: Error) => {
        seen.push(error.message);
        return true;
      },
    );
    seen.push(JSON.stringify(harness.logEntries));
    for (const text of seen) assert.ok(!text.includes(TOKEN) && !text.includes("FAKE-token"), text);
  });
});
