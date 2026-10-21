// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));

afterEach(cleanup);

interface Chat {
  name: string;
  chatId: string;
  use: string;
  status: "ready" | "invalid" | "unknown";
  reason?: string;
  migrateToChatId?: string;
}

const home: Chat = { name: "Home", chatId: "-1001000000001", use: "Personal", status: "ready" };
const work: Chat = {
  name: "Work",
  chatId: "-1001000000002",
  use: "",
  status: "invalid",
  reason: "The bot was removed from Work.",
};

type Handlers = Record<string, (input: unknown) => unknown>;

function mount(handlers: Handlers = {}, chats: Chat[] = [home, work], tokenSet = true) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        listChats: () => ({ tokenSet, chats }),
        saveChats: () => ({ ok: true, list: { tokenSet, chats } }),
        checkChat: () => ({ status: "ready" }),
        findGroups: () => ({ groups: [], maybeIncomplete: false }),
        ...handlers,
      },
    },
  );
}

const callsTo = (slot: ReturnType<typeof mount>, method: string) =>
  slot.rpcCalls.filter((call) => call.method === method);

describe("Chats section", () => {
  it("registers one section titled Chats", () => {
    expect(app.settingsSections).toHaveLength(1);
    expect(app.settingsSections[0]!.title).toBe("Chats");
  });

  it("shows each chat with its status and reason", async () => {
    const slot = mount();
    expect(await slot.findByDisplayValue("Home")).toBeTruthy();
    expect(slot.getByDisplayValue(work.chatId)).toBeTruthy();
    expect(slot.getByText("Ready")).toBeTruthy();
    expect(slot.getByText("Can't be used")).toBeTruthy();
    expect(slot.getByText("The bot was removed from Work.")).toBeTruthy();
  });

  it("explains an unset token and an empty list", async () => {
    const slot = mount({}, [], false);
    expect(await slot.findByText(/No bot token is set/)).toBeTruthy();
  });

  it("offers a retry when the first load fails", async () => {
    let attempts = 0;
    const slot = mount({
      listChats: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("server is down");
        return { tokenSet: true, chats: [home] };
      },
    });
    expect((await slot.findByRole("alert")).textContent).toMatch(/server is down/);
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    expect(await slot.findByDisplayValue("Home")).toBeTruthy();
  });

  it("keeps the edits and shows the server's message when a save is refused", async () => {
    const slot = mount({
      saveChats: () => ({ ok: false, row: 0, error: "Another chat already has that name." }),
    });
    const name = await slot.findByLabelText("Name of Home");
    fireEvent.change(name, { target: { value: "Home Renamed" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect((await slot.findByRole("alert")).textContent).toBe("Another chat already has that name.");
    expect((slot.getByLabelText("Name of Home Renamed") as HTMLInputElement).value).toBe("Home Renamed");
    expect(slot.getByLabelText("Name of Home Renamed").getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps the edits when the save call itself fails", async () => {
    const slot = mount({
      saveChats: () => {
        throw new Error("connection lost");
      },
    });
    const use = await slot.findByLabelText("When to use Home");
    fireEvent.change(use, { target: { value: "Only urgent things" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect((await slot.findByRole("alert")).textContent).toMatch(/connection lost/);
    expect((slot.getByLabelText("When to use Home") as HTMLInputElement).value).toBe("Only urgent things");
  });

  it("does not call the server for a row that fails the local checks", async () => {
    const slot = mount();
    fireEvent.change(await slot.findByLabelText("Chat ID of Home"), { target: { value: "not-an-id" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect((await slot.findByRole("alert")).textContent).toMatch(/chat ID/i);
    expect(callsTo(slot, "saveChats")).toHaveLength(0);
  });

  it("sends the trimmed list in the table's order and shows the saved result", async () => {
    const slot = mount();
    fireEvent.change(await slot.findByLabelText("Name of Home"), { target: { value: "  Home  " } });
    fireEvent.click(slot.getByRole("button", { name: "Move Work up" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(slot, "saveChats")).toHaveLength(1));
    expect(callsTo(slot, "saveChats")[0]!.input).toEqual({
      chats: [
        { name: "Work", chatId: work.chatId, use: "" },
        { name: "Home", chatId: home.chatId, use: "Personal" },
      ],
    });
    expect((await slot.findByRole("status")).textContent).toBe("Saved.");
  });

  it("checks a row and shows what the server found", async () => {
    const slot = mount({
      checkChat: (input) => {
        expect(input).toEqual({ chatId: work.chatId });
        return { status: "ready" };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Check Work" }));
    await waitFor(() => expect(slot.getAllByText("Ready")).toHaveLength(2));
    expect(slot.queryByText("The bot was removed from Work.")).toBeNull();
  });

  it("keeps edits and shows the error when a check call is rejected", async () => {
    const slot = mount({
      checkChat: () => {
        throw new Error("check failed to run");
      },
    });
    fireEvent.change(await slot.findByLabelText("When to use Work"), { target: { value: "Edited" } });
    fireEvent.click(slot.getByRole("button", { name: "Check Work" }));
    expect((await slot.findByRole("alert")).textContent).toMatch(/check failed to run/);
    expect((slot.getByLabelText("When to use Work") as HTMLInputElement).value).toBe("Edited");
  });

  it("a realtime refresh updates statuses without touching what the user typed", async () => {
    let current: Chat[] = [home, work];
    const slot = mount({ listChats: () => ({ tokenSet: true, chats: current }) });
    const name = await slot.findByLabelText("Name of Home");
    fireEvent.change(name, { target: { value: "Home (typing)" } });

    current = [home, { name: work.name, chatId: work.chatId, use: work.use, status: "ready" }];
    await slot.emitRealtime("chats", {});
    await waitFor(() => expect(slot.getAllByText("Ready")).toHaveLength(2));
    expect((slot.getByLabelText("Name of Home (typing)") as HTMLInputElement).value).toBe("Home (typing)");
  });

  it("fills a new row from Find groups and checks it", async () => {
    const slot = mount(
      {
        findGroups: () => ({
          groups: [{ chatId: "-1001000000003", title: "Family chat", type: "supergroup" }],
          maybeIncomplete: true,
        }),
        checkChat: () => ({ status: "ready", title: "Family chat" }),
      },
      [home],
    );
    fireEvent.click(await slot.findByRole("button", { name: "Find groups" }));
    expect(await slot.findByText(/Family chat/)).toBeTruthy();
    expect(slot.getByText(/may be incomplete/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Add Family chat" }));
    expect((await slot.findByDisplayValue("Family chat")) as HTMLInputElement).toBeTruthy();
    expect(slot.getByDisplayValue("-1001000000003")).toBeTruthy();
    await waitFor(() => expect(callsTo(slot, "checkChat")).toHaveLength(1));
  });

  it("says what to do when no group is found", async () => {
    const slot = mount();
    fireEvent.click(await slot.findByRole("button", { name: "Find groups" }));
    expect(await slot.findByText(/No groups found/)).toBeTruthy();
  });

  it("Use new ID fills the migrated ID and only saving applies it", async () => {
    const moved: Chat = {
      ...work,
      reason: "The group became a supergroup.",
      migrateToChatId: "-1009999999999",
    };
    const slot = mount({}, [home, moved]);
    fireEvent.click(await slot.findByRole("button", { name: "Use new ID" }));
    expect((slot.getByLabelText("Chat ID of Work") as HTMLInputElement).value).toBe("-1009999999999");
    expect(callsTo(slot, "saveChats")).toHaveLength(0);
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(slot, "saveChats")).toHaveLength(1));
    expect(callsTo(slot, "saveChats")[0]!.input).toMatchObject({
      chats: [{ chatId: home.chatId }, { chatId: "-1009999999999" }],
    });
  });

  it("removes a row and adds a blank one", async () => {
    const slot = mount();
    fireEvent.click(await slot.findByRole("button", { name: "Remove Work" }));
    expect(slot.queryByDisplayValue("Work")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Add chat" }));
    expect(slot.getAllByRole("textbox")).toHaveLength(6);
  });

  it("warns that names and notes reach every agent's instructions", async () => {
    const slot = mount();
    expect(await slot.findByText(/added to every agent's instructions/)).toBeTruthy();
  });
});
