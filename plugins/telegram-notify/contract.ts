// RPC contract between the Chats settings section and the server. Chat IDs
// cross as decimal strings: a Telegram ID can outgrow what JSON numbers carry
// safely in other tooling, and the section edits them as text anyway.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { CHAT_ID_ERROR, CHAT_ID_PATTERN, nameError, parseChatId, useError } from "./rules.ts";

export const chatIdInput = z
  .string()
  .trim()
  .regex(CHAT_ID_PATTERN, CHAT_ID_ERROR)
  .transform((text, ctx) => {
    const id = parseChatId(text);
    if (id === null) {
      ctx.addIssue({ code: "custom", message: CHAT_ID_ERROR });
      return z.NEVER;
    }
    return id;
  });

const nameInput = z
  .string()
  .trim()
  .superRefine((name, ctx) => {
    const error = nameError(name);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

const useInput = z
  .string()
  .trim()
  .superRefine((use, ctx) => {
    const error = useError(use);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });

const chatInput = z.object({ name: nameInput, chatId: chatIdInput, use: useInput });

const statusSchema = z.enum(["ready", "invalid", "unknown"]);

const chatRowSchema = z.object({
  name: z.string(),
  chatId: z.string(),
  use: z.string(),
  status: statusSchema,
  reason: z.string().optional(),
  /** Set when Telegram said the group became a supergroup; a decimal string. */
  migrateToChatId: z.string().optional(),
});

export const contract = defineRpcContract({
  listChats: {
    input: z.null(),
    output: z.object({ tokenSet: z.boolean(), chats: z.array(chatRowSchema) }),
  },
  saveChats: {
    // The count limit is a list-level error returned as `ok: false`, not a
    // schema failure, so the section can show it next to the table.
    input: z.object({ chats: z.array(chatInput) }),
    output: z.discriminatedUnion("ok", [
      z.object({
        ok: z.literal(true),
        list: z.object({ tokenSet: z.boolean(), chats: z.array(chatRowSchema) }),
      }),
      z.object({
        ok: z.literal(false),
        /** 0-based row the error belongs to; null when it concerns the list. */
        row: z.number().int().nullable(),
        error: z.string(),
      }),
    ]),
  },
  checkChat: {
    input: z.object({ chatId: chatIdInput }),
    output: z.object({
      status: statusSchema,
      reason: z.string().optional(),
      title: z.string().optional(),
    }),
  },
  findGroups: {
    input: z.null(),
    output: z.object({
      groups: z.array(z.object({ chatId: z.string(), title: z.string(), type: z.string() })),
      maybeIncomplete: z.boolean(),
    }),
  },
});

export type ChatRow = z.infer<typeof chatRowSchema>;
export type ChatList = z.infer<typeof contract.listChats.output>;
