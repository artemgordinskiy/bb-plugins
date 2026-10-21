// bb-plugin-telegram-notify frontend: the Chats settings section, where the
// chat list is edited, checked and saved. Everything the user types stays on
// screen when a save or a check fails, and a realtime refresh only updates the
// status column.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { contract } from "./contract.ts";
import { MAX_CHATS, NAME_MAX, USE_MAX, parseChatId, CHAT_ID_ERROR } from "./rules.ts";
import {
  addBlankRow,
  addFoundGroup,
  applyStatusRefresh,
  buildSavePayload,
  moveRow,
  rowsFromList,
  setRowStatus,
  topNotice,
  useNewId,
  visibleStatus,
  type DraftRow,
  type FoundGroup,
  type TopNotice,
} from "./section-state.ts";

const CHATS_CHANNEL = "chats";

interface FormError {
  /** The row the error belongs to; null for the list as a whole. */
  key: string | null;
  text: string;
}

interface Found {
  groups: FoundGroup[];
  maybeIncomplete: boolean;
}

const NOTICES: Record<TopNotice, string> = {
  "no-token":
    "No bot token is set. Add it in this plugin's settings and reload the plugin; agents don't get the tool until then.",
  "no-chats": "No chats yet. Add one below; agents don't get the tool until a chat is ready.",
  "all-invalid": "Every chat is invalid, so agents don't get the tool until one is fixed.",
};

const STATUS_LABEL = { ready: "Ready", invalid: "Can't be used", unknown: "Not checked" } as const;

const STATUS_CLASS = {
  ready: "text-foreground",
  invalid: "text-destructive",
  unknown: "text-muted-foreground",
} as const;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TelegramChats() {
  const rpc = useRpc<typeof contract>();
  const [rows, setRows] = useState<DraftRow[] | null>(null);
  const [tokenSet, setTokenSet] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [checking, setChecking] = useState<ReadonlySet<string>>(new Set());
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<Found | null>(null);
  const activeRef = useRef(true);
  const savingRef = useRef(false);
  const loadedRef = useRef(false);
  const counter = useRef({ next: 0 });

  const refetch = useCallback(() => {
    if (savingRef.current) return;
    void rpc.call("listChats").then(
      (list) => {
        if (!activeRef.current || savingRef.current) return;
        setTokenSet(list.tokenSet);
        setLoadError(null);
        if (loadedRef.current) {
          setRows((current) => (current === null ? current : applyStatusRefresh(current, list)));
        } else {
          loadedRef.current = true;
          setRows(rowsFromList(list, counter.current));
        }
      },
      (error: unknown) => {
        if (activeRef.current && !loadedRef.current) setLoadError(errorMessage(error));
      },
    );
  }, [rpc]);

  useEffect(() => {
    activeRef.current = true;
    refetch();
    return () => {
      activeRef.current = false;
    };
  }, [refetch]);
  useRealtime(CHATS_CHANNEL, refetch);

  function edit(key: string, field: "name" | "chatId" | "use", value: string): void {
    setRows((current) => current?.map((row) => (row.key === key ? { ...row, [field]: value } : row)) ?? current);
    setSaved(false);
    if (formError?.key === key) setFormError(null);
  }

  function change(next: (current: DraftRow[]) => DraftRow[]): void {
    setRows((current) => (current === null ? current : next(current)));
    setSaved(false);
    setFormError(null);
  }

  async function check(row: DraftRow): Promise<void> {
    const chatId = row.chatId.trim();
    if (parseChatId(chatId) === null) {
      setFormError({ key: row.key, text: CHAT_ID_ERROR });
      return;
    }
    setChecking((current) => new Set(current).add(row.key));
    try {
      const result = await rpc.call("checkChat", { chatId });
      if (!activeRef.current) return;
      setRows((current) => (current === null ? current : setRowStatus(current, row.key, result, chatId)));
    } catch (error) {
      if (activeRef.current) setFormError({ key: row.key, text: errorMessage(error) });
    } finally {
      if (activeRef.current) {
        setChecking((current) => {
          const next = new Set(current);
          next.delete(row.key);
          return next;
        });
      }
    }
  }

  async function findGroups(): Promise<void> {
    setFinding(true);
    setFormError(null);
    try {
      const result = await rpc.call("findGroups");
      if (activeRef.current) setFound(result);
    } catch (error) {
      if (activeRef.current) setFormError({ key: null, text: errorMessage(error) });
    } finally {
      if (activeRef.current) setFinding(false);
    }
  }

  function addGroup(group: FoundGroup): void {
    if (rows === null) return;
    const added = addFoundGroup(rows, group, counter.current);
    if (!added.ok) {
      setFormError({ key: null, text: added.error });
      return;
    }
    setRows(added.rows);
    setSaved(false);
    setFormError(null);
    const row = added.rows.find((entry) => entry.key === added.key);
    if (row) void check(row);
  }

  async function save(): Promise<void> {
    if (rows === null || savingRef.current) return;
    const payload = buildSavePayload(rows);
    if (!payload.ok) {
      setFormError({ key: payload.row === null ? null : (rows[payload.row]?.key ?? null), text: payload.error });
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setFormError(null);
    setSaved(false);
    try {
      const result = await rpc.call("saveChats", { chats: payload.chats });
      if (!activeRef.current) return;
      if (result.ok) {
        setRows(rowsFromList(result.list, counter.current));
        setTokenSet(result.list.tokenSet);
        setSaved(true);
      } else {
        setFormError({ key: result.row === null ? null : (rows[result.row]?.key ?? null), text: result.error });
      }
    } catch (error) {
      if (activeRef.current) setFormError({ key: null, text: errorMessage(error) });
    } finally {
      savingRef.current = false;
      if (activeRef.current) setSaving(false);
    }
  }

  if (rows === null) {
    return (
      <div className="space-y-2">
        <p
          className={loadError === null ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
          role={loadError === null ? "status" : "alert"}
        >
          {loadError ?? "Loading chats…"}
        </p>
        {loadError !== null && (
          <Button size="sm" variant="outline" onClick={refetch}>
            Retry
          </Button>
        )}
      </div>
    );
  }

  const notice = topNotice(rows, tokenSet);
  const full = rows.length >= MAX_CHATS;

  return (
    <div className="w-full space-y-4">
      <p className="text-xs leading-relaxed text-muted-foreground">
        Agents post to the first chat unless they name another. Names and notes are added to every agent's
        instructions, so keep them short and leave secrets out.
      </p>

      {notice !== null && (
        <p className="text-sm text-muted-foreground" role="status">
          {NOTICES[notice]}
        </p>
      )}

      {rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Chat ID</TableHead>
              <TableHead>When to use</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => {
              const status = visibleStatus(row);
              const invalid = formError?.key === row.key;
              const label = row.name.trim() || `chat ${index + 1}`;
              return (
                <TableRow key={row.key}>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`Name of ${label}`}
                      aria-invalid={invalid}
                      maxLength={NAME_MAX * 2}
                      value={row.name}
                      onChange={(event) => edit(row.key, "name", event.target.value)}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`Chat ID of ${label}`}
                      aria-invalid={invalid}
                      inputMode="numeric"
                      value={row.chatId}
                      onChange={(event) => edit(row.key, "chatId", event.target.value)}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Input
                      aria-label={`When to use ${label}`}
                      aria-invalid={invalid}
                      maxLength={USE_MAX * 2}
                      placeholder="Optional"
                      value={row.use}
                      onChange={(event) => edit(row.key, "use", event.target.value)}
                    />
                  </TableCell>
                  <TableCell className="align-top text-xs">
                    {checking.has(row.key) ? (
                      <span className="text-muted-foreground">Checking…</span>
                    ) : (
                      <>
                        <span className={STATUS_CLASS[status?.status ?? "unknown"]}>
                          {STATUS_LABEL[status?.status ?? "unknown"]}
                        </span>
                        {status?.reason && <p className="mt-1 text-muted-foreground">{status.reason}</p>}
                        {status?.migrateToChatId && (
                          <Button
                            className="mt-1"
                            size="sm"
                            variant="outline"
                            onClick={() => change((current) => useNewId(current, row.key))}
                          >
                            Use new ID
                          </Button>
                        )}
                      </>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Check ${label}`}
                        disabled={checking.has(row.key)}
                        onClick={() => void check(row)}
                      >
                        Check
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move ${label} up`}
                        disabled={index === 0}
                        onClick={() => change((current) => moveRow(current, index, -1))}
                      >
                        Up
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Move ${label} down`}
                        disabled={index === rows.length - 1}
                        onClick={() => change((current) => moveRow(current, index, 1))}
                      >
                        Down
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove ${label}`}
                        onClick={() => change((current) => current.filter((entry) => entry.key !== row.key))}
                      >
                        Remove
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={full}
          onClick={() => change((current) => addBlankRow(current, counter.current))}
        >
          Add chat
        </Button>
        <Button size="sm" variant="outline" disabled={finding || !tokenSet} onClick={() => void findGroups()}>
          {finding ? "Looking…" : "Find groups"}
        </Button>
        <Button size="sm" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {full && <span className="text-xs text-muted-foreground">At most {MAX_CHATS} chats.</span>}
      </div>

      {found !== null && (
        <div className="space-y-2 rounded-md border border-border/60 p-3">
          {found.groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No groups found. Add the bot to a group, send a message there, then try again.
            </p>
          ) : (
            <ul className="space-y-1">
              {found.groups.map((group) => (
                <li key={group.chatId} className="flex items-center justify-between gap-3 text-sm">
                  <span className="min-w-0 truncate">
                    {group.title} <span className="text-muted-foreground">({group.type})</span>
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Add ${group.title}`}
                    onClick={() => addGroup(group)}
                  >
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {found.maybeIncomplete && (
            <p className="text-xs text-muted-foreground">
              This list may be incomplete: Telegram only keeps recent activity. Send a message in the group and try
              again, or enter its ID by hand.
            </p>
          )}
        </div>
      )}

      <div className="min-h-5" aria-live="polite">
        {formError !== null ? (
          <p className="text-xs text-destructive" role="alert">
            {formError.text}
          </p>
        ) : saved ? (
          <p className="text-xs text-muted-foreground" role="status">
            Saved.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "chats",
    title: "Chats",
    description: "Where agents can send Telegram messages.",
    component: TelegramChats,
  });
});
