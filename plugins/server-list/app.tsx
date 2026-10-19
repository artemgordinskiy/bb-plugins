// bb-plugin-server-list frontend: a sidebar-footer disclosure listing the
// configured bb servers.
//
// - Desktop app: switches through the desktop app's own server list
//   (`window.bbDesktop`, the same undocumented bridge brsbl's
//   server-switcher uses). A server missing from that list cannot be added
//   from here, so its row says to add it in the desktop app first.
// - Mobile app: its shell sends off-origin navigation to the system browser
//   and its page bridge (`window.bb.native`) cannot select a server, so a row
//   opens the app's device settings, one tap from its own Servers list.
// - Browser: navigates the window to the server's URL.
import { useEffect, useState, type ReactNode } from "react";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import {
  currentServer,
  customServerId,
  matchDesktopChoices,
  parseDesktopChoices,
  parseServers,
  type ConfiguredServer,
  type DesktopBridge,
  type DesktopChoice,
} from "./servers";

interface MobileShell {
  openDeviceSettings(): void;
}

/** The mobile app's page bridge, when it can open its native settings screen. */
function mobileShell(): MobileShell | null {
  const root: unknown = Reflect.get(window, "bb");
  if (typeof root !== "object" || root === null) return null;
  const native: unknown = Reflect.get(root, "native");
  if (typeof native !== "object" || native === null) return null;
  const post: unknown = Reflect.get(native, "post");
  const capabilities: unknown = Reflect.get(native, "capabilities");
  if (typeof post !== "function" || !Array.isArray(capabilities)) return null;
  if (!capabilities.includes("open-native")) return null;
  return {
    openDeviceSettings() {
      Reflect.apply(post, native, [{ type: "open-native", screen: "device-settings" }]);
    },
  };
}

/** Desktop custom-server ids by server URL; null while hashing. */
function useCustomServerIds(urls: readonly string[], enabled: boolean): Map<string, string> | null {
  const key = urls.join("\n");
  const [ids, setIds] = useState<{ key: string; ids: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const list = key === "" ? [] : key.split("\n");
    Promise.all(list.map(async (url) => [url, await customServerId(url)] as const)).then(
      (pairs) => {
        if (disposed) return;
        const map = new Map<string, string>();
        for (const [url, id] of pairs) if (id !== null) map.set(url, id);
        setIds({ key, ids: map });
      },
      () => {
        // Hashing only adds a match path; name matching still works without it.
        if (!disposed) setIds({ key, ids: new Map() });
      },
    );
    return () => {
      disposed = true;
    };
  }, [key, enabled]);
  if (!enabled) return new Map();
  return ids !== null && ids.key === key ? ids.ids : null;
}

function desktopBridge(): DesktopBridge | null {
  const desktop: unknown = Reflect.get(window, "bbDesktop");
  if (typeof desktop !== "object" || desktop === null) return null;
  const getServerChoices: unknown = Reflect.get(desktop, "getServerChoices");
  const selectServer: unknown = Reflect.get(desktop, "selectServer");
  if (typeof getServerChoices !== "function" || typeof selectServer !== "function") {
    return null;
  }
  return {
    async getServerChoices() {
      const value: unknown = await Reflect.apply(getServerChoices, desktop, []);
      const choices = parseDesktopChoices(value);
      if (choices === null) throw new Error("The desktop app sent an unexpected server list.");
      return choices;
    },
    selectServer(id) {
      Reflect.apply(selectServer, desktop, [id]);
    },
  };
}

type DesktopState =
  | { status: "absent" }
  | { status: "loading" }
  | { status: "ready"; choices: DesktopChoice[] }
  | { status: "error"; message: string };

function useDesktopChoices(bridge: DesktopBridge | null): DesktopState {
  const [state, setState] = useState<DesktopState>(
    bridge === null ? { status: "absent" } : { status: "loading" },
  );
  useEffect(() => {
    if (bridge === null) return;
    let disposed = false;
    bridge.getServerChoices().then(
      (choices) => {
        if (!disposed) setState({ status: "ready", choices });
      },
      (cause: unknown) => {
        if (!disposed) {
          setState({
            status: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [bridge]);
  return state;
}

function Message({ children }: { children: ReactNode }) {
  return <p className="px-3 py-2 text-sm text-muted-foreground">{children}</p>;
}

function ServerRow({
  server,
  current,
  disabledReason,
  onSelect,
}: {
  server: ConfiguredServer;
  current: boolean;
  disabledReason: string | null;
  onSelect: () => void;
}) {
  const disabled = current || disabledReason !== null;
  return (
    <li>
      <button
        type="button"
        disabled={disabled}
        onClick={onSelect}
        aria-current={current ? "true" : undefined}
        className={cn(
          "flex w-full flex-col items-start rounded-md px-3 py-2 text-left",
          !disabled && "cursor-pointer hover:bg-state-hover",
          disabledReason !== null && "opacity-60",
        )}
      >
        <span className="flex w-full items-center gap-2 text-sm font-medium text-foreground">
          <span className="min-w-0 flex-1 truncate">{server.name}</span>
          {current ? <span className="text-xs text-muted-foreground">Current</span> : null}
        </span>
        <span className="w-full truncate text-xs text-muted-foreground">
          {disabledReason ?? server.host}
        </span>
      </button>
    </li>
  );
}

function ServerListPanel({ dismiss }: ExperimentalSidebarFooterDisclosureProps) {
  const settings = useSettings();
  const [bridge] = useState(desktopBridge);
  const [mobile] = useState(mobileShell);
  const desktop = useDesktopChoices(bridge);
  const raw = settings.values?.servers;
  const parsed = parseServers(typeof raw === "string" ? raw : "");
  const ids = useCustomServerIds(parsed.ok ? parsed.servers.map((server) => server.url) : [], bridge !== null);

  if (settings.values === undefined || desktop.status === "loading" || ids === null) {
    return <Message>Loading servers…</Message>;
  }
  if (desktop.status === "error") return <Message>{desktop.message}</Message>;
  if (!parsed.ok) return <Message>Server list setting is invalid: {parsed.error}</Message>;
  if (parsed.servers.length === 0) {
    return (
      <Message>
        No servers configured. Add them in this plugin's settings, one per line as{" "}
        <code>name url</code>.
      </Message>
    );
  }

  const matches =
    desktop.status === "ready" ? matchDesktopChoices(parsed.servers, ids, desktop.choices) : null;
  const current = currentServer(parsed.servers, window.location.host, matches);
  return (
    <>
      <ul className="max-h-96 overflow-y-auto p-1">
        {parsed.servers.map((server) => {
          const isCurrent = server === current;
          const choice = matches?.get(server.host);
          const disabledReason =
            matches !== null && choice === undefined && !isCurrent
              ? "Add this URL in the desktop app's server settings first"
              : null;
          return (
            <ServerRow
              key={server.host}
              server={server}
              current={isCurrent}
              disabledReason={disabledReason}
              onSelect={() => {
                dismiss();
                if (bridge !== null && choice !== undefined) {
                  bridge.selectServer(choice.id);
                } else if (mobile !== null) {
                  mobile.openDeviceSettings();
                } else {
                  window.location.assign(server.url);
                }
              }}
            />
          );
        })}
      </ul>
      {mobile !== null && bridge === null ? (
        <Message>Opens this device's settings: choose the server under Servers.</Message>
      ) : null}
    </>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "servers",
    label: "Servers",
    icon: "ComputerCloud",
    component: ServerListPanel,
  });
});
