// bb-plugin-server-list frontend: a sidebar-footer disclosure listing the
// configured bb servers.
//
// - Desktop app: switches through the desktop app's own server list
//   (`window.bbDesktop`, the same undocumented bridge brsbl's
//   server-switcher uses). A server missing from that list cannot be added
//   from here, so its row says to add it in the desktop app first.
// - Browser and mobile app: navigates the window to the server's URL.
import { useEffect, useState, type ReactNode } from "react";
import type { ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
import { definePluginApp, useSettings } from "@get-bb/plugin-sdk/app";
import { cn } from "@/lib/utils";
import {
  currentServer,
  desktopChoiceFor,
  parseDesktopChoices,
  parseServers,
  type ConfiguredServer,
  type DesktopBridge,
  type DesktopChoice,
} from "./servers";

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
  const desktop = useDesktopChoices(bridge);

  if (settings.values === undefined || desktop.status === "loading") {
    return <Message>Loading servers…</Message>;
  }
  if (desktop.status === "error") return <Message>{desktop.message}</Message>;
  const raw = settings.values.servers;
  const parsed = parseServers(typeof raw === "string" ? raw : "");
  if (!parsed.ok) return <Message>Server list setting is invalid: {parsed.error}</Message>;
  if (parsed.servers.length === 0) {
    return (
      <Message>
        No servers configured. Add them in this plugin's settings, one per line as{" "}
        <code>name url</code>.
      </Message>
    );
  }

  const choices = desktop.status === "ready" ? desktop.choices : null;
  const current = currentServer(parsed.servers, window.location.host, choices);
  return (
    <ul className="max-h-96 overflow-y-auto p-1">
      {parsed.servers.map((server) => {
        const isCurrent = server === current;
        const choice = choices === null ? undefined : desktopChoiceFor(server, choices);
        const disabledReason =
          choices !== null && choice === undefined && !isCurrent
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
              } else {
                window.location.assign(server.url);
              }
            }}
          />
        );
      })}
    </ul>
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
