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
const pluginStylesheetMarker = "data-bb-plugin-css";

function isStylesheet(node: Element): node is HTMLLinkElement {
  return node.localName === "link" && node.getAttribute("rel")?.toLowerCase().split(/\s+/).includes("stylesheet") === true;
}

function hasRootTypographyRules(rules: CSSRuleList): boolean {
  return Array.from(rules).some((rule) => {
    if ("styleSheet" in rule) {
      const imported = (rule as CSSImportRule).styleSheet;
      return !imported || hasRootTypographyRules(imported.cssRules);
    }
    if ("selectorText" in rule && "style" in rule) {
      const { selectorText, style, cssRules: nested } = rule as CSSStyleRule;
      if (!document.documentElement.matches(selectorText)) return false;
      return Boolean(nested?.length) || Array.from(style).some(
        (name) => name.startsWith("--") || name === "font" || name === "font-size" || name === "all",
      );
    }
    if ("cssRules" in rule) return hasRootTypographyRules((rule as CSSGroupingRule).cssRules);
    // Generated Tailwind utility registrations do not set BB theme tokens.
    return /^@property\s+--(?!tw-)/i.test(rule.cssText);
  });
}

function stylesheetMayAffectTheme(sheet: CSSStyleSheet | null | undefined): boolean {
  if (sheet === undefined) return false;
  if (sheet === null) return true;
  try {
    return hasRootTypographyRules(sheet.cssRules);
  } catch {
    // Cross-origin imports may apply to the root even when their rules are opaque.
    return true;
  }
}

type LinkedStylesheetChange = (link: HTMLLinkElement) => boolean;

function relevantNode(node: Node, linkedStylesheetChangesTheme: LinkedStylesheetChange): boolean {
  if (node instanceof Element) {
    if (node.hasAttribute("data-typography")) return false;
    if (isStylesheet(node)) return linkedStylesheetChangesTheme(node);
    if (node.localName === "style") return themeDeclarations.test(node.textContent ?? "");
    return Array.from(node.children).some((child) => relevantNode(child, linkedStylesheetChangesTheme));
  }
  return themeDeclarations.test(node.textContent ?? "");
}

function changesTheme(record: MutationRecord, linkedStylesheetChangesTheme: LinkedStylesheetChange): boolean {
  if (record.target === document.documentElement) return true;
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  if (target?.closest("[data-typography]")) return false;
  if (record.type === "attributes") {
    if (target === null) return false;
    if (isStylesheet(target) ||
      // Also catch a stylesheet link changing its rel away from stylesheet.
      (target.localName === "link" && record.attributeName === "rel" &&
        record.oldValue?.toLowerCase().split(/\s+/).includes("stylesheet") === true)) {
      return linkedStylesheetChangesTheme(target as HTMLLinkElement);
    }
    return target.localName === "style" && relevantNode(target, linkedStylesheetChangesTheme);
  }
  if (record.type === "characterData") {
    return target?.localName === "style" &&
      (relevantNode(target, linkedStylesheetChangesTheme) || themeDeclarations.test(record.oldValue ?? ""));
  }
  return (target?.localName === "style" && relevantNode(target, linkedStylesheetChangesTheme)) ||
    [...record.addedNodes, ...record.removedNodes].some((node) => relevantNode(node, linkedStylesheetChangesTheme));
}

/** Defer theme reads until after the interaction task. */
export function observeTheme(listener: () => void, signal?: AbortSignal): () => void {
  if (signal?.aborted) return () => {};
  let pending: number | undefined;
  let stopped = false;
  const pluginSheets = new WeakMap<HTMLLinkElement, CSSStyleSheet | null>();
  for (const link of document.head.querySelectorAll<HTMLLinkElement>(`link[${pluginStylesheetMarker}]`)) {
    if (isStylesheet(link) && link.sheet !== null) pluginSheets.set(link, link.sheet);
  }
  function linkedStylesheetChangesTheme(link: HTMLLinkElement, loaded = false): boolean {
    if (!link.hasAttribute(pluginStylesheetMarker)) return true;
    const previous = pluginSheets.get(link);
    // A new plugin link cannot affect the theme until it loads. Keep its last
    // sheet so removal or replacement can still reveal the underlying theme.
    const current = link.sheet ?? (loaded ? null : previous);
    if (current !== undefined) pluginSheets.set(link, current);
    return stylesheetMayAffectTheme(current) || (current !== previous && stylesheetMayAffectTheme(previous));
  }
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
    if (records.some((record) => changesTheme(record, linkedStylesheetChangesTheme))) schedule();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: rootAttributes });
  observer.observe(document.head, {
    childList: true, subtree: true, characterData: true, characterDataOldValue: true,
    attributes: true, attributeOldValue: true,
    attributeFilter: ["href", "rel", "media", "disabled"],
  });
  const loaded = (event: Event) => {
    if (event.target instanceof Element && isStylesheet(event.target) &&
      linkedStylesheetChangesTheme(event.target, true)) schedule();
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

