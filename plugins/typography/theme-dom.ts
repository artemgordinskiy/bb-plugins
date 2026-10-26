// DOM theme sampling and observation, independent of React for behaviour tests.
import { BB_THEME, TEXT_TOKENS, type ThemeTokens } from "./typography.ts";

export const RULES_SELECTOR = 'style[data-typography="rules"]';

function toPx(value: string, rootSize: number): number | undefined {
  const match = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (match === null) return undefined;
  const amount = Number(match[1]);
  return match[2] === "rem" ? amount * rootSize : amount;
}

/** The theme's tokens, read with this plugin's rules switched off for a moment. */
export function readThemeTokens(): ThemeTokens {
  const rules = document.querySelector<HTMLStyleElement>(RULES_SELECTOR);
  const wasDisabled = rules?.disabled ?? true;
  const suspend = rules && !wasDisabled && Boolean(rules.textContent);
  if (suspend) rules.disabled = true;
  try {
    const style = getComputedStyle(document.documentElement);
    const rootSize = Number.parseFloat(style.fontSize) || 16;
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    const text: ThemeTokens["text"] = {};
    for (const token of TEXT_TOKENS) {
      const px = toPx(style.getPropertyValue(token), rootSize);
      if (px !== undefined) text[token] = px;
    }
    return {
      fontSans: read("--font-sans", BB_THEME.fontSans),
      fontMono: read("--font-mono", BB_THEME.fontMono),
      fontTerminal: read("--font-terminal", BB_THEME.fontTerminal),
      text: Object.keys(text).length > 0 ? text : BB_THEME.text,
    };
  } finally {
    if (suspend) rules.disabled = wasDisabled;
  }
}

// Include root custom-property dependencies (e.g. --my-ui-font), not just
// the tokens we read. Ignore component-local variables, fonts and sizes.
// Imports may contain declarations we cannot see.
const themeDeclarations = /--(?:font-(?:sans|mono|terminal)|text-(?:2xs|xs|sm|base|lg|xl|2xl))\s*:|(?:^|[{}])[^{}]*(?::root|\bhtml\b|\.dark\b|\.light\b)[^{}]*\{[^{}]*(?:--[\w-]+|font-size)\s*:|@import\b/i;
const rootAttributes = ["class", "style", "data-theme"];

function isStylesheet(node: Element): boolean {
  return node.localName === "link" && node.getAttribute("rel")?.toLowerCase().split(/\s+/).includes("stylesheet") === true;
}

function relevantNode(node: Node): boolean {
  if (node instanceof Element) {
    if (node.hasAttribute("data-typography")) return false;
    if (isStylesheet(node)) return true;
    if (node.localName === "style") return themeDeclarations.test(node.textContent ?? "");
    return Array.from(node.children).some(relevantNode);
  }
  return themeDeclarations.test(node.textContent ?? "");
}

function changesTheme(record: MutationRecord): boolean {
  if (record.target === document.documentElement) return true;
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest("[data-typography]")) return false;
  if (record.type === "attributes") {
    return target !== null && (isStylesheet(target) ||
      // Also catch a stylesheet link changing its rel away from stylesheet.
      (target.localName === "link" && record.attributeName === "rel" &&
        record.oldValue?.toLowerCase().split(/\s+/).includes("stylesheet") === true) ||
      (target.localName === "style" && relevantNode(target)));
  }
  if (record.type === "characterData") {
    return target?.localName === "style" &&
      (relevantNode(target) || themeDeclarations.test(record.oldValue ?? ""));
  }
  return (target?.localName === "style" && relevantNode(target)) ||
    [...record.addedNodes, ...record.removedNodes].some(relevantNode);
}

/** Only genuine theme changes schedule a read, after the interaction task. */
export function observeTheme(listener: () => void, signal?: AbortSignal): () => void {
  if (signal?.aborted) return () => {};
  let pending: number | undefined;
  let stopped = false;
  const idle = typeof window.requestIdleCallback === "function";
  const schedule = () => {
    if (stopped || pending !== undefined) return;
    const run = () => {
      pending = undefined;
      if (!stopped) listener();
    };
    pending = idle ? window.requestIdleCallback(run, { timeout: 1000 }) : window.requestAnimationFrame(run);
  };
  const observer = new MutationObserver((records) => {
    if (records.some(changesTheme)) schedule();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: rootAttributes });
  observer.observe(document.head, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: true,
    attributes: true, attributeOldValue: true,
    attributeFilter: ["href", "rel", "media", "disabled"],
  });
  // Inserting a link precedes its load; sample again once its CSS is usable.
  const loaded = (event: Event) => {
    if (event.target instanceof Element && isStylesheet(event.target)) schedule();
  };
  document.head.addEventListener("load", loaded, true);
  const coarse = window.matchMedia("(pointer: coarse)");
  coarse.addEventListener("change", schedule);
  const stop = () => {
    stopped = true;
    observer.disconnect();
    document.head.removeEventListener("load", loaded, true);
    coarse.removeEventListener("change", schedule);
    signal?.removeEventListener("abort", stop);
    if (pending !== undefined) {
      if (idle) window.cancelIdleCallback(pending);
      else window.cancelAnimationFrame(pending);
      pending = undefined;
    }
  };
  signal?.addEventListener("abort", stop, { once: true });
  return stop;
}

