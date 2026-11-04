// Every setting, its default, and the Config the rest of the plugin reads.
// Settings apply on the next poll after a save; no reload is needed.
import type { PluginSettingDescriptors, PluginSettingsValues } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { OptionalFailures } from "./reading.ts";

export const DEFAULT_INSTRUCTION = "Check the failures and comments and propose fixes. Don't change anything until the user agrees.";
export const DEFAULT_INFO_INSTRUCTION = "Nothing failed. Tell the user briefly what changed. Don't merge, push or change anything without their go.";

const CI_PASS = ["after-failure", "first-and-after-failure", "every-commit"] as const;
const CI_FAILURE = ["every-commit", "changed-checks"] as const;
const OPTIONAL = ["wake", "mention", "ignore"] as const;
const APPROVALS = ["ready-to-merge", "every-approval"] as const;

export type CiPassWakes = (typeof CI_PASS)[number];
export type CiFailureWakes = (typeof CI_FAILURE)[number];
export type ApprovalWakes = (typeof APPROVALS)[number];

export const SETTINGS = {
  instructionLine: {
    type: "string",
    label: "Instruction line",
    description: "The action line near the end of every message. One line, up to 300 characters.",
    default: DEFAULT_INSTRUCTION,
  },
  infoInstructionLine: {
    type: "string",
    label: "Instruction line when nothing failed",
    description: "Used instead of the instruction line when a message has nothing to fix: CI now passing, ready to merge, or still a draft.",
    default: DEFAULT_INFO_INSTRUCTION,
  },
  ciPassWakes: {
    type: "select",
    label: "When CI passes",
    description: "Which passing CI results wake the thread. A failure always wakes, and a pass is always shown in status.",
    options: [...CI_PASS],
    experimental_optionLabels: {
      "after-failure": "Only after a reported failure",
      "first-and-after-failure": "The first result, then only after a failure",
      "every-commit": "Every commit (0.1 behaviour)",
    },
    default: "after-failure",
  },
  ciFailureWakes: {
    type: "select",
    label: "When CI fails",
    description: "Whether a failure on a new commit wakes when the same checks failed on the commit before, such as after a rebase.",
    options: [...CI_FAILURE],
    experimental_optionLabels: {
      "every-commit": "Every commit",
      "changed-checks": "Only when the failing checks change",
    },
    default: "every-commit",
  },
  optionalCheckFailures: {
    type: "select",
    label: "Checks that aren't required",
    description:
      "What a failing check that the base branch doesn't require does. When no check on the PR is required, every check counts as required.",
    options: [...OPTIONAL],
    experimental_optionLabels: {
      wake: "Wake, marked (not required)",
      mention: "Only list them when something else wakes",
      ignore: "Ignore them",
    },
    default: "wake",
  },
  approvalWakes: {
    type: "select",
    label: "Approvals",
    description: "Whether an approval with no comment wakes by itself, or only as part of 'Ready to merge'. An approval with a comment always wakes.",
    options: [...APPROVALS],
    experimental_optionLabels: {
      "ready-to-merge": "Only through 'Ready to merge'",
      "every-approval": "Every approval (0.1 behaviour)",
    },
    default: "ready-to-merge",
  },
  readyToMergeWakes: {
    type: "boolean",
    label: "Ready to merge",
    description: "Wake once when the PR is approved, its checks are green and GitHub says it can merge. Not while it's queued or set to auto-merge.",
    default: true,
  },
  draftApprovalWakes: {
    type: "boolean",
    label: "Approved draft",
    description: "Wake once when a draft PR is approved and green, so it can be marked ready for review.",
    default: true,
  },
  mergeQueueWakes: {
    type: "boolean",
    label: "Left the merge queue",
    description: "Wake when the PR leaves the merge queue, or auto-merge is turned off, without merging.",
    default: true,
  },
  botAuthors: {
    type: "string",
    label: "Bot reviewers",
    description: "Comma-separated bot logins whose reviews count. Their conversation comments never wake.",
    default: "copilot-pull-request-reviewer, coderabbitai, claude, chatgpt-codex-connector",
  },
  feedbackRoles: {
    type: "string",
    label: "Feedback from",
    description: "Comma-separated GitHub author associations whose reviews and comments wake the thread.",
    default: "OWNER, MEMBER, COLLABORATOR",
  },
  quietSeconds: {
    type: "number",
    label: "Quiet time (seconds)",
    description: "How long the thread and everything under it must be idle before a wake. 0 to 3600.",
    experimental_schema: z.number().int().min(0).max(3600),
    default: 120,
  },
  activePollSeconds: {
    type: "number",
    label: "Fast poll (seconds)",
    description: "The poll interval while CI runs and for 10 minutes after the thread goes idle. 30 to 600.",
    experimental_schema: z.number().int().min(30).max(600),
    default: 60,
  },
  idlePollSeconds: {
    type: "number",
    label: "Slow poll (seconds)",
    description: "The poll interval at other times. 60 to 3600.",
    experimental_schema: z.number().int().min(60).max(3600),
    default: 300,
  },
} satisfies PluginSettingDescriptors;

export type SettingsValues = PluginSettingsValues<typeof SETTINGS>;

/** What decides a wake. */
export type WakeRules = {
  ciPassWakes: CiPassWakes;
  ciFailureWakes: CiFailureWakes;
  readyWakes: boolean;
  draftWakes: boolean;
  queueWakes: boolean;
};

/** What decides whether a review or comment counts. */
export type FeedbackRules = {
  bots: Set<string>;
  roles: Set<string>;
  /** Whether an approval with no comment counts as feedback by itself. */
  bareApprovals: boolean;
};

export type Config = {
  instructionLine: string;
  /** For a wake with nothing to fix. */
  infoInstructionLine: string;
  optionalFailures: OptionalFailures;
  wake: WakeRules;
  feedback: FeedbackRules;
  quietMs: number;
  activePollMs: number;
  idlePollMs: number;
};

const pick = <T extends string>(options: readonly T[], value: string, fallback: T): T =>
  (options as readonly string[]).includes(value) ? (value as T) : fallback;

const seconds = (value: number, min: number, max: number, fallback: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) * 1000 : fallback * 1000;

export function parseBotAuthors(setting: string): Set<string> {
  const logins = setting.split(",").map((login) => login.trim().toLowerCase().replace(/\[bot\]$/, ""));
  return new Set(logins.filter(Boolean));
}

export function parseRoles(setting: string): Set<string> {
  return new Set(setting.split(",").map((role) => role.trim().toUpperCase()).filter(Boolean));
}

/** Unknown values fall back to the defaults, so an old or hand-edited value can't break polling. */
export function toConfig(values: SettingsValues): Config {
  return {
    instructionLine: values.instructionLine,
    infoInstructionLine: values.infoInstructionLine,
    optionalFailures: pick(OPTIONAL, values.optionalCheckFailures, "wake"),
    wake: {
      ciPassWakes: pick(CI_PASS, values.ciPassWakes, "after-failure"),
      ciFailureWakes: pick(CI_FAILURE, values.ciFailureWakes, "every-commit"),
      readyWakes: values.readyToMergeWakes,
      draftWakes: values.draftApprovalWakes,
      queueWakes: values.mergeQueueWakes,
    },
    feedback: {
      bots: parseBotAuthors(values.botAuthors),
      roles: parseRoles(values.feedbackRoles),
      bareApprovals: pick(APPROVALS, values.approvalWakes, "ready-to-merge") === "every-approval",
    },
    quietMs: seconds(values.quietSeconds, 0, 3600, 120),
    activePollMs: seconds(values.activePollSeconds, 30, 600, 60),
    idlePollMs: seconds(values.idlePollSeconds, 60, 3600, 300),
  };
}

export const DEFAULT_CONFIG: Config = toConfig(
  Object.fromEntries(Object.entries(SETTINGS).map(([key, descriptor]) => [key, descriptor.default])) as SettingsValues,
);
