import assert from "node:assert/strict";
import test from "node:test";
import type { ChatList } from "./contract.ts";
import { buildInstructions } from "./notify.ts";
import {
  FakeTelegram,
  configContext,
  cutOff,
  fail,
  garbled,
  hang,
  network,
  ok,
  withPlugin,
  type Booted,
  type BootOptions,
} from "./test-support.ts";

const HOME = -1001000000001;
const ADMIN = -1001000000002;

/** A plugin with Home (default) and Home Admin saved and checked. */
async function ready(options: BootOptions, run: (plugin: Booted) => Promise<void>) {
  const tg = options.tg ?? new FakeTelegram();
  tg.addGroup(HOME).addGroup(ADMIN);
  await withPlugin({ ...options, tg }, async (plugin) => {
    await plugin.save([
      { name: "Home", chatId: String(HOME), use: "household matters" },
      { name: "Home Admin", chatId: String(ADMIN), use: "infrastructure, reports" },
    ]);
    await plugin.settle();
    await run(plugin);
  });
}

type ToolResult = Awaited<ReturnType<Booted["harness"]["callAgentTool"]>>;

const textOf = (result: ToolResult): string =>
  typeof result === "string" ? result : result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const isError = (result: ToolResult): boolean => typeof result !== "string" && result.isError === true;

const send = (plugin: Booted, input: Record<string, unknown> = {}, threadId = "thread-a") =>
  plugin.harness.callAgentTool("telegram_notify", { title: "Done", message: "The report is ready.", ...input }, { threadId });

const clockOf = (ms: number) => {
  const at = new Date(ms);
  return `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
};

test("offered only for top-level threads outside side chats, and only when usable", async () => {
  await ready({}, async ({ harness }) => {
    const top = await harness.resolveAgentConfiguration(configContext());
    assert.deepEqual(top.tools.map((tool) => tool.name), ["telegram_notify"]);
    assert.deepEqual(top.skills, []);

    const worker = await harness.resolveAgentConfiguration(configContext({ thread: { parentThreadId: "thr_parent" } }));
    assert.deepEqual(worker.tools, []);
    assert.equal(worker.instructions, null);

    const sideChat = await harness.resolveAgentConfiguration(configContext({ origin: { pluginId: "side-chat" } }));
    assert.deepEqual(sideChat.tools, []);
    assert.equal(sideChat.instructions, null);

    const otherPlugin = await harness.resolveAgentConfiguration(configContext({ origin: { pluginId: "automations" } }));
    assert.equal(otherPlugin.tools.length, 1);
  });
});

test("the tool instructions and the chat list follow the spec", async () => {
  await ready({}, async ({ harness }) => {
    const tool = harness.registrations.agentTools[0];
    assert.match(tool?.instructions ?? "", /^Use `telegram_notify` to message the user on their phone/);
    assert.match(tool?.instructions ?? "", /Never include secrets, tokens, passwords, or private keys\.$/);
    const { instructions } = await harness.resolveAgentConfiguration(configContext());
    assert.equal(
      instructions,
      [
        "Telegram chats (pass the name as `chat`; omit it for the first):",
        "- Home: household matters",
        "- Home Admin: infrastructure, reports",
        "",
        "Only post to a chat what its note says it's for.",
      ].join("\n"),
    );
  });
});

test("names and notes with markup or newlines stay one plain line each", () => {
  const text = buildInstructions([
    { name: "Evil\n# Heading", chatId: 1, use: "line one\n\n- injected: bullet\r\n```code``` more" },
    { name: "<b>Bold</b>", chatId: 2, use: "" },
  ]);
  const lines = text.split("\n");
  assert.deepEqual(lines, [
    "Telegram chats (pass the name as `chat`; omit it for the first):",
    "- Evil # Heading: line one - injected: bullet ```code``` more",
    "- <b>Bold</b>",
    "",
    "Only post to a chat what its note says it's for.",
  ]);
});

test("instructions are cut at 4096 characters", () => {
  const chats = Array.from({ length: 10 }, (_, n) => ({ name: `Chat ${n}`, chatId: n + 1, use: "x".repeat(2000) }));
  assert.equal(buildInstructions(chats).length, 4096);
});

test("arguments are validated", async () => {
  await ready({}, async ({ harness, tg }) => {
    const call = (input: Record<string, unknown>) => harness.callAgentTool("telegram_notify", input);
    await assert.rejects(() => call({ message: "m" }));
    await assert.rejects(() => call({ title: "t" }));
    await assert.rejects(() => call({ title: "   ", message: "m" }));
    await assert.rejects(() => call({ title: "x".repeat(81), message: "m" }));
    await assert.rejects(() => call({ title: "two\nlines", message: "m" }));
    await assert.rejects(() => call({ title: "t", message: "" }));
    await assert.rejects(() => call({ title: "t", message: "m".repeat(1001) }));
    await assert.rejects(() => call({ title: "t", message: "m", silent: "yes" }));
    assert.equal(tg.callsTo("sendMessage").length, 0);

    assert.equal(textOf(await call({ title: "x".repeat(80), message: "m".repeat(1000) })), "Sent to Home.");
  });
});

test("no chat means the first chat; names match ignoring case", async () => {
  await ready({ settings: { cooldownMinutes: "0" } }, async (plugin) => {
    const { tg } = plugin;
    assert.equal(await send(plugin), "Sent to Home.");
    assert.equal(await send(plugin, { chat: "home admin" }), "Sent to Home Admin.");
    assert.equal(await send(plugin, { chat: "  HOME  " }), "Sent to Home.");
    assert.deepEqual(tg.callsTo("sendMessage").map((call) => call.body.chat_id), [HOME, ADMIN, HOME]);
  });
});

test("an unknown chat lists the valid names and sends nothing", async () => {
  await ready({}, async (plugin) => {
    const result = await send(plugin, { chat: "Garage" });
    assert.equal(isError(result), true);
    assert.equal(textOf(result), "unknown_chat: No chat named Garage. Chats: Home, Home Admin.");
    assert.equal(plugin.tg.callsTo("sendMessage").length, 0);
  });
});

test("an invalid chat is refused with its reason while the others keep working", async () => {
  const tg = new FakeTelegram();
  await ready({ tg }, async (plugin) => {
    tg.chats.get(ADMIN)!.member = { status: "kicked" };
    await plugin.harness.callRpc("checkChat", { chatId: String(ADMIN) });
    const refused = await send(plugin, { chat: "Home Admin" });
    assert.equal(isError(refused), true);
    assert.equal(textOf(refused), "chat_invalid: The bot was removed from this group. Add it again.");
    assert.equal(textOf(await send(plugin, { chat: "Home" })), "Sent to Home.");
    assert.equal(tg.callsTo("sendMessage").length, 1);
  });
});

test("the cooldown is per thread, across chats, and says when to try again", async () => {
  await ready({}, async (plugin) => {
    assert.equal(await send(plugin, {}, "thread-a"), "Sent to Home.");

    plugin.clock.now += 2 * 60_000;
    const blocked = await send(plugin, { chat: "Home Admin" }, "thread-a");
    assert.equal(isError(blocked), true);
    assert.equal(
      textOf(blocked),
      `cooldown: Sent one for this thread 2 minutes ago; try again after ${clockOf(plugin.clock.now - 2 * 60_000 + 5 * 60_000)} or put it in your reply.`,
    );
    // Another thread isn't affected.
    assert.equal(await send(plugin, {}, "thread-b"), "Sent to Home.");

    plugin.clock.now += 3 * 60_000;
    assert.equal(await send(plugin, {}, "thread-a"), "Sent to Home.");
    assert.equal(plugin.tg.callsTo("sendMessage").length, 3);
  });
});

test("a cooldown of 0 turns it off", async () => {
  await ready({ settings: { cooldownMinutes: "0" } }, async (plugin) => {
    assert.equal(await send(plugin), "Sent to Home.");
    assert.equal(await send(plugin), "Sent to Home.");
  });
});

test("the hourly cap covers all threads and chats, and frees up as sends age out", async () => {
  await ready({ settings: { cooldownMinutes: "0", hourlyLimit: 3 } }, async (plugin) => {
    assert.equal(await send(plugin, {}, "t1"), "Sent to Home.");
    plugin.clock.now += 20 * 60_000;
    assert.equal(await send(plugin, { chat: "Home Admin" }, "t2"), "Sent to Home Admin.");
    plugin.clock.now += 20 * 60_000;
    assert.equal(await send(plugin, {}, "t3"), "Sent to Home.");

    const capped = await send(plugin, {}, "t4");
    assert.equal(isError(capped), true);
    assert.match(textOf(capped), /^hourly_limit: /);
    assert.equal(plugin.tg.callsTo("sendMessage").length, 3);

    // The first send is now more than an hour old.
    plugin.clock.now += 21 * 60_000;
    assert.equal(await send(plugin, {}, "t4"), "Sent to Home.");
  });
});

test("concurrent calls can't pass the cooldown together", async () => {
  await ready({}, async (plugin) => {
    const results = await Promise.all(Array.from({ length: 6 }, () => send(plugin, {}, "same-thread")));
    assert.equal(results.filter((result) => !isError(result)).length, 1);
    assert.equal(results.filter((result) => textOf(result).startsWith("cooldown: ")).length, 5);
    assert.equal(plugin.tg.callsTo("sendMessage").length, 1);
  });
});

test("concurrent calls can't pass the hourly cap together", async () => {
  await ready({ settings: { cooldownMinutes: "0", hourlyLimit: 2 } }, async (plugin) => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, n) => send(plugin, { chat: n % 2 ? "Home" : "Home Admin" }, `thread-${n}`)),
    );
    assert.equal(results.filter((result) => !isError(result)).length, 2);
    assert.equal(results.filter((result) => textOf(result).startsWith("hourly_limit: ")).length, 6);
    assert.equal(plugin.tg.callsTo("sendMessage").length, 2);
  });
});

test("rejected: Telegram refused it, nothing was sent, and the reservation is released", async () => {
  const tg = new FakeTelegram();
  await ready({ tg }, async (plugin) => {
    tg.on("sendMessage", () => fail(400, "Bad Request: have no rights to send a message"));
    const refused = await send(plugin);
    assert.equal(isError(refused), true);
    assert.equal(textOf(refused), "rejected Bad Request: have no rights to send a message. Nothing was sent.");

    // The released slot means no cooldown now.
    tg.on("sendMessage", () => ok({ message_id: 7 }));
    assert.equal(await send(plugin), "Sent to Home.");
  });
});

test("uncertain: no answer, a 5xx or a timeout may have been delivered, so it is never retried and the slot is kept", async () => {
  for (const [what, reply] of [
    ["a network error", network()],
    ["a 502", fail(502, "Bad Gateway")],
    ["a timeout", hang()],
    ["a 200 that isn't JSON", garbled()],
    ["a 200 cut off mid-body", cutOff()],
  ] as const) {
    const tg = new FakeTelegram();
    await ready({ tg, timeoutMs: 20 }, async (plugin) => {
      tg.on("sendMessage", () => reply);
      const result = await send(plugin);
      assert.equal(isError(result), true, what);
      assert.match(textOf(result), /^uncertain: .*Don't retry; mention it in your reply\.$/, what);
      assert.equal(tg.callsTo("sendMessage").length, 1, `${what}: one request, no retry`);
      assert.ok(!textOf(result).includes("fake_token") && !textOf(result).includes("FAKE-token"), what);

      // The reservation stays: the next call hits the cooldown.
      assert.match(textOf(await send(plugin)), /^cooldown: /, what);
    });
  }
});

test("a 429 is rate_limited with the wait, nothing is retried and the reservation is released", async () => {
  const tg = new FakeTelegram();
  await ready({ tg }, async (plugin) => {
    tg.on("sendMessage", () => fail(429, "Too Many Requests: retry after 12", { retry_after: 12 }));
    const limited = await send(plugin);
    assert.equal(isError(limited), true);
    assert.equal(
      textOf(limited),
      "rate_limited 12: Try again after 12 seconds or put it in your reply. Nothing was sent.",
    );
    assert.equal(tg.callsTo("sendMessage").length, 1);

    tg.on("sendMessage", () => undefined);
    assert.equal(await send(plugin), "Sent to Home.");
  });
});

test("a group that became a supergroup: rejected with the new ID, marked invalid, published", async () => {
  const tg = new FakeTelegram();
  await ready({ tg }, async (plugin) => {
    tg.on("sendMessage", () =>
      fail(400, "Bad Request: group chat was upgraded to a supergroup chat", { migrate_to_chat_id: -1009000000001 }),
    );
    const before = plugin.harness.realtimeSignals.length;
    const result = await send(plugin, { chat: "Home Admin" });
    assert.equal(isError(result), true);
    assert.equal(
      textOf(result),
      "rejected Home Admin moved to chat ID -1009000000001; update it in Settings → Plugins → Telegram Notify. Nothing was sent.",
    );
    assert.ok(plugin.harness.realtimeSignals.slice(before).some((signal) => signal.channel === "chats"));

    const list = (await plugin.harness.callRpc("listChats", null)) as ChatList;
    const admin = list.chats.find((chat) => chat.name === "Home Admin");
    assert.equal(admin?.status, "invalid");
    assert.equal(admin?.migrateToChatId, "-1009000000001");
    assert.match(admin?.reason ?? "", /moved to chat ID -1009000000001/);
    assert.equal(list.chats.find((chat) => chat.name === "Home")?.migrateToChatId, undefined);

    // The old chat is refused from now on, without calling Telegram again; the plugin doesn't change it by itself.
    tg.on("sendMessage", () => undefined);
    const again = await send(plugin, { chat: "Home Admin" });
    assert.match(textOf(again), /^chat_invalid: Home Admin moved to chat ID/);
    assert.equal(tg.callsTo("sendMessage").length, 1);
    assert.equal(list.chats.find((chat) => chat.name === "Home Admin")?.chatId, String(ADMIN));
  });
});

test("hostile titles and messages are escaped after truncation, and the format matches the spec", async () => {
  await ready({ threadTitle: "Fix <script>alert(1)</script> & co", projectName: "R&D <lab>" }, async (plugin) => {
    await send(plugin, { title: "<b>Hi</b> & bye", message: "a < b && c > d\n<a href=\"x\">link</a>" });
    const body = plugin.tg.callsTo("sendMessage")[0]?.body as Record<string, unknown>;
    assert.equal(
      body.text,
      "🔔 <b>&lt;b&gt;Hi&lt;/b&gt; &amp; bye</b>\n" +
        "a &lt; b &amp;&amp; c &gt; d\n&lt;a href=\"x\"&gt;link&lt;/a&gt;\n\n" +
        "<i>R&amp;D &lt;lab&gt; · Fix &lt;script&gt;alert(1)&lt;/script&gt; &amp; co</i>",
    );
    assert.equal(body.parse_mode, "HTML");
    assert.deepEqual(body.link_preview_options, { is_disabled: true });
    assert.equal(body.chat_id, HOME);
  });
});

test("project and thread names are cut to 64 characters, before escaping", async () => {
  await ready(
    { threadTitle: `${"&".repeat(40)}${"t".repeat(40)}`, projectName: "p".repeat(100) },
    async (plugin) => {
      await send(plugin, { title: "T".repeat(80), message: "M".repeat(1000) });
      const text = String(plugin.tg.callsTo("sendMessage")[0]?.body.text);
      const footer = text.slice(text.lastIndexOf("<i>"));
      assert.equal(footer, `<i>${"p".repeat(63)}… · ${"&amp;".repeat(40)}${"t".repeat(23)}…</i>`);
      // What Telegram counts, after entities are parsed, stays far below its 4096 limit.
      const counted = text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&");
      assert.ok(counted.length < 1250, `${counted.length}`);
    },
  );
});

test("a missing thread title falls back to the generated one, and failed lookups still send", async () => {
  await ready({ threadTitle: null }, async (plugin) => {
    plugin.harness.sdk.stub("threads.get", async () => {
      throw new Error("down");
    });
    plugin.harness.sdk.stub("projects.get", async () => {
      throw new Error("down");
    });
    assert.equal(await send(plugin), "Sent to Home.");
    const text = String(plugin.tg.callsTo("sendMessage")[0]?.body.text);
    assert.match(text, /<i>Unknown project · Untitled thread<\/i>$/);
    assert.ok(plugin.harness.logEntries.some((entry) => entry.level === "warn" && /lookup failed/.test(entry.message)));
  });
});

test("the Open in bb button points at the thread, and is left out without an app URL", async () => {
  await ready({ appUrl: "https://bb.example.test/" }, async (plugin) => {
    await send(plugin, {}, "thr_abc123");
    const body = plugin.tg.callsTo("sendMessage")[0]?.body as Record<string, unknown>;
    assert.deepEqual(body.reply_markup, {
      inline_keyboard: [[{ text: "Open in bb", url: "https://bb.example.test/projects/project-test/threads/thr_abc123" }]],
    });
  });
  await ready({ appUrl: null }, async (plugin) => {
    assert.equal(await send(plugin), "Sent to Home.");
    assert.equal("reply_markup" in (plugin.tg.callsTo("sendMessage")[0]?.body ?? {}), false);
  });
});

test("silent sends with disable_notification; the default is a normal notification", async () => {
  await ready({ settings: { cooldownMinutes: "0" } }, async (plugin) => {
    await send(plugin, { silent: true });
    await send(plugin);
    const [quiet, loud] = plugin.tg.callsTo("sendMessage");
    assert.equal(quiet?.body.disable_notification, true);
    assert.equal("disable_notification" in (loud?.body ?? {}), false);
  });
});

test("without a token the tool isn't offered, and calling it anyway sends nothing", async () => {
  await withPlugin({ settings: { botToken: "" } }, async (plugin) => {
    const result = await send(plugin);
    assert.equal(isError(result), true);
    assert.match(textOf(result), /^not_configured: /);
    assert.equal(plugin.tg.calls.length, 0);
  });
});

test("a token Telegram rejects at send time flags the plugin and releases the slot", async () => {
  const tg = new FakeTelegram();
  await ready({ tg }, async (plugin) => {
    tg.on("sendMessage", () => fail(401, "Unauthorized"));
    const result = await send(plugin);
    assert.match(textOf(result), /^not_configured: Telegram rejected the bot token/);
    assert.equal(plugin.harness.needsConfigurationMessages.length, 1);
    assert.deepEqual((await plugin.harness.resolveAgentConfiguration(configContext())).tools, []);
  });
});

test("only a chat ID, a thread ID and a time are stored: no message text, and old rows go", async () => {
  await ready({ settings: { cooldownMinutes: "0" } }, async (plugin) => {
    const db = plugin.bb.storage.database();
    const columns = (db.prepare("PRAGMA table_info(sends)").all() as { name: string }[]).map((column) => column.name);
    assert.deepEqual(columns, ["thread_id", "chat_id", "at"]);

    await send(plugin, { title: "secret title", message: "secret body" });
    const dump = JSON.stringify(db.prepare("SELECT * FROM sends").all());
    assert.ok(!dump.includes("secret"));

    plugin.clock.now += 25 * 60 * 60_000;
    await send(plugin);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM sends").get() as { n: number }).n, 1);
  });
});
