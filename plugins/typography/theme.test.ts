import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { observeTheme, readThemeTokens } from "./theme-dom.ts";
import { BB_THEME } from "./typography.ts";

function page(t: TestContext, idle = true) {
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>");
  const { window } = dom;
  const jobs = new Map<number, () => void>();
  let next = 0;
  const enqueue = (callback: () => void) => { jobs.set(++next, callback); return next; };
  const cancel = (id: number) => { jobs.delete(id); };
  if (idle) {
    window.requestIdleCallback = (callback) => enqueue(() => callback({ didTimeout: false, timeRemaining: () => 50 }));
    window.cancelIdleCallback = cancel;
  }
  window.requestAnimationFrame = (callback) => enqueue(() => callback(0));
  window.cancelAnimationFrame = cancel;
  const coarse = new window.EventTarget();
  window.matchMedia = () => coarse as MediaQueryList;
  const globals = {
    window, document: window.document, Element: window.Element,
    MutationObserver: window.MutationObserver, getComputedStyle: window.getComputedStyle.bind(window),
  };
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, globals);
  const cleanups: (() => void)[] = [];
  t.after(() => {
    cleanups.forEach((cleanup) => cleanup());
    window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const flushMutations = () => new Promise<void>((resolve) => setImmediate(resolve));
  const flushJobs = () => {
    const callbacks = [...jobs.values()];
    jobs.clear();
    callbacks.forEach((callback) => callback());
  };
  const style = (css: string, own = false) => {
    const node = window.document.createElement("style");
    if (own) node.dataset.typography = "rules";
    node.textContent = css;
    window.document.head.append(node);
    return node;
  };
  return { window, jobs, coarse, flushMutations, flushJobs, style, cleanup: (stop: () => void) => cleanups.push(stop) };
}

test("menu scroll locks, unrelated plugin styles and our sheets never sample or invalidate the theme", async (t) => {
  const p = page(t);
  const rules = p.style("html:root{--font-mono:Typography}", true);
  let toggles = 0;
  Object.defineProperty(rules, "disabled", { get: () => false, set: () => { toggles++; } });
  let reads = 0;
  globalThis.getComputedStyle = () => { reads++; throw new Error("Unexpected style read on menu path"); };
  const stop = observeTheme(readThemeTokens);
  p.cleanup(stop);
  for (let i = 0; i < 20; i++) {
    const lock = p.style("body[data-scroll-locked]{overflow:hidden!important;margin-right:15px!important}");
    await p.flushMutations();
    lock.remove();
    await p.flushMutations();
  }
  const genui = p.style(".genui{--card:red;font-size:14px}.genui p{color:var(--card)}");
  genui.firstChild!.textContent = ".genui{--card:blue;font-size:16px}";
  const own = p.style(":root{--font-sans:Own}", true);
  own.textContent = ":root{--text-sm:15px}";
  own.remove();
  rules.textContent = "html:root{--font-mono:New}";
  document.documentElement.setAttribute("data-scroll-locked", "1");
  document.documentElement.setAttribute("aria-hidden", "true");
  await p.flushMutations();
  assert.equal(p.jobs.size, 0);
  p.flushJobs();
  assert.equal(reads, 0);
  assert.equal(toggles, 0);
});

test("light/dark, inline tokens, theme replacement and pointer changes coalesce off the interaction task", async (t) => {
  const p = page(t);
  const calls: string[] = [];
  const stop = observeTheme(() => calls.push(document.documentElement.className));
  p.cleanup(stop);
  document.documentElement.className = "dark";
  document.documentElement.style.setProperty("--font-sans", "New theme");
  document.documentElement.dataset.theme = "custom";
  p.style(":root,.light{--font-sans:Light}.dark{--font-sans:Dark}");
  p.coarse.dispatchEvent(new p.window.Event("change"));
  await p.flushMutations();
  assert.deepEqual(calls, []);
  assert.equal(p.jobs.size, 1);
  p.flushJobs();
  assert.deepEqual(calls, ["dark"]);
  document.documentElement.className = "light";
  await p.flushMutations();
  p.flushJobs();
  assert.deepEqual(calls, ["dark", "light"]);
});

test("style insertion, replacement, removal and text-node edits update the theme", async (t) => {
  const p = page(t);
  let calls = 0;
  const stop = observeTheme(() => { calls++; });
  p.cleanup(stop);
  const theme = p.style("@media (pointer:coarse){:root{--text-sm:15px}}");
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 1);
  theme.firstChild!.textContent = ":root{--my-ui-font:Custom}";
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 2);
  // Deleting the last relevant declaration must restore the underlying theme.
  theme.firstChild!.textContent = "body{color:red}";
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 3);
  theme.textContent = "html{font-size:18px}";
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 4);
  theme.remove();
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 5);
});

test("stylesheet links update after load and on href, media, disabled, rel and removal changes", async (t) => {
  const p = page(t);
  let calls = 0;
  const stop = observeTheme(() => { calls++; });
  p.cleanup(stop);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "/theme.css";
  document.head.append(link);
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 1);
  link.dispatchEvent(new p.window.Event("load"));
  assert.equal(calls, 1);
  p.flushJobs();
  assert.equal(calls, 2);
  for (const [attribute, value] of [["href", "/other.css"], ["media", "print"], ["disabled", ""], ["rel", "preload"], ["rel", "stylesheet"]]) {
    link.setAttribute(attribute, value);
    await p.flushMutations(); p.flushJobs();
  }
  assert.equal(calls, 7);
  link.remove();
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 8);
  const preload = document.createElement("link");
  preload.rel = "preload";
  document.head.append(preload);
  preload.dispatchEvent(new p.window.Event("load"));
  await p.flushMutations();
  assert.equal(p.jobs.size, 0);
});

test("abort and cleanup cancel queued work and detach media and link listeners, including rAF fallback", async (t) => {
  const p = page(t, false);
  const controller = new AbortController();
  let calls = 0;
  const stop = observeTheme(() => { calls++; }, controller.signal);
  p.coarse.dispatchEvent(new p.window.Event("change"));
  assert.equal(p.jobs.size, 1);
  p.flushJobs();
  assert.equal(calls, 1);
  document.documentElement.className = "dark";
  await p.flushMutations();
  assert.equal(p.jobs.size, 1);
  controller.abort();
  assert.equal(p.jobs.size, 0);
  p.coarse.dispatchEvent(new p.window.Event("change"));
  p.style(":root{--font-sans:Ignored}");
  const link = document.createElement("link");
  link.rel = "stylesheet";
  document.head.append(link);
  link.dispatchEvent(new p.window.Event("load"));
  await p.flushMutations(); p.flushJobs();
  assert.equal(calls, 1);
  stop();
  observeTheme(() => { calls++; }, controller.signal);
  p.coarse.dispatchEvent(new p.window.Event("change"));
  assert.equal(p.jobs.size, 0);
});

test("sampling retains theme stacks and scale, and restores the sheet even if style reading fails", (t) => {
  const p = page(t);
  const rules = p.style("html:root{--font-mono:Typography}", true);
  let disabled = false;
  const toggles: boolean[] = [];
  Object.defineProperty(rules, "disabled", {
    get: () => disabled,
    set: (value: boolean) => { disabled = value; toggles.push(value); },
  });
  globalThis.getComputedStyle = () => {
    assert.equal(disabled, true);
    const values: Record<string, string> = { "--font-sans": "Theme Sans", "--text-sm": "0.7rem", "--text-xs": "12px" };
    return {
      fontSize: "20px",
      getPropertyValue: (name: string) => values[name] ?? "",
    } as CSSStyleDeclaration;
  };
  assert.deepEqual(readThemeTokens(), {
    fontSans: "Theme Sans", fontMono: BB_THEME.fontMono, fontTerminal: BB_THEME.fontTerminal,
    text: { "--text-xs": 12, "--text-sm": 14 },
  });
  assert.deepEqual(toggles, [true, false]);
  globalThis.getComputedStyle = () => { throw new Error("read failed"); };
  assert.throws(readThemeTokens, /read failed/);
  assert.equal(disabled, false);
  toggles.length = 0;
  disabled = true;
  assert.throws(readThemeTokens, /read failed/);
  assert.deepEqual(toggles, []);
  disabled = false;
  rules.textContent = "";
  assert.throws(readThemeTokens, /read failed/);
  assert.deepEqual(toggles, []);
});

test("theme imports and style media changes schedule work, and idle cleanup cancels it", async (t) => {
  const p = page(t);
  let calls = 0;
  const stop = observeTheme(() => { calls++; });
  p.cleanup(stop);
  const sheet = p.style('@import url("/theme.css");');
  await p.flushMutations();
  assert.equal(p.jobs.size, 1);
  p.flushJobs();
  assert.equal(calls, 1);
  sheet.media = "(pointer: coarse)";
  await p.flushMutations();
  assert.equal(p.jobs.size, 1);
  stop();
  assert.equal(p.jobs.size, 0);
  p.flushJobs();
  assert.equal(calls, 1);
});
