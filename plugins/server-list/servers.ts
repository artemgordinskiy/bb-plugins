// Pure server-list logic shared by the settings validator (server.ts) and the
// sidebar disclosure (app.tsx).

export interface ConfiguredServer {
  name: string;
  /** Normalized origin, e.g. https://bb.artem.cool */
  url: string;
  /** URL host, including a non-default port. */
  host: string;
}

export type ParseResult =
  | { ok: true; servers: ConfiguredServer[] }
  | { ok: false; error: string };

const MAX_SERVERS = 20;

/**
 * Parses the `servers` setting: one server per line as `<name> <url>`.
 * Blank lines and lines starting with `#` are ignored.
 */
export function parseServers(text: string): ParseResult {
  const servers: ConfiguredServer[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const lineNumber = index + 1;
    const match = /^(\S+)\s+(\S+)$/.exec(line);
    if (match === null) {
      return { ok: false, error: `Line ${lineNumber}: expected "<name> <url>"` };
    }
    const [, name, rawUrl] = match;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { ok: false, error: `Line ${lineNumber}: "${rawUrl}" is not a URL` };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: `Line ${lineNumber}: URL must use http or https` };
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      return {
        ok: false,
        error: `Line ${lineNumber}: use the server's root URL, without a path`,
      };
    }
    if (servers.some((server) => server.host === parsed.host)) {
      return { ok: false, error: `Line ${lineNumber}: ${parsed.host} is listed twice` };
    }
    servers.push({ name, url: parsed.origin, host: parsed.host });
  }
  if (servers.length > MAX_SERVERS) {
    return { ok: false, error: `List at most ${MAX_SERVERS} servers` };
  }
  return { ok: true, servers };
}

/** One entry of the desktop app's own server list. */
export interface DesktopChoice {
  id: string;
  name: string;
  active: boolean;
}

/** The desktop shell's undocumented server bridge on `window.bbDesktop`. */
export interface DesktopBridge {
  getServerChoices(): Promise<DesktopChoice[]>;
  selectServer(id: string): void;
}

export function parseDesktopChoices(value: unknown): DesktopChoice[] | null {
  if (!Array.isArray(value)) return null;
  const choices: DesktopChoice[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { id, name, active } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || typeof active !== "boolean") {
      return null;
    }
    choices.push({ id, name, active });
  }
  return choices;
}

/** Finds the desktop app's saved choice for a configured server. */
export function desktopChoiceFor(
  server: ConfiguredServer,
  choices: readonly DesktopChoice[],
): DesktopChoice | undefined {
  return choices.find((choice) => choice.name === server.host);
}

/**
 * Picks which configured server this window is showing: the desktop app's
 * active choice when known, otherwise the page's own host.
 */
export function currentServer(
  servers: readonly ConfiguredServer[],
  pageHost: string,
  choices: readonly DesktopChoice[] | null,
): ConfiguredServer | undefined {
  const active = choices?.find((choice) => choice.active);
  if (active !== undefined) {
    const match = servers.find((server) => server.host === active.name);
    if (match !== undefined) return match;
  }
  return servers.find((server) => server.host === pageHost);
}
