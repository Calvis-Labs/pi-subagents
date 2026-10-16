import { type Component, Editor, type Terminal, TuiAltScreen, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentWidget } from "../src/ui/agent-widget.js";
import { FleetList, type FleetUICtx } from "../src/ui/fleet-list.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const LEFT = "\x1b[D";
const ESC = "\x1b";
const ENTER = "\r";
const identity = (text: string) => text;
const selectList = {
  selectedPrefix: identity, selectedText: identity, description: identity,
  scrollInfo: identity, noMatch: identity,
};
const theme = { fg: (_color: string, text: string) => text, bold: identity };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function mount(Tui: typeof TuiMainScreen | typeof TuiAltScreen, count = 2) {
  let input: (data: string) => void = () => {};
  const terminal: Terminal = {
    start: (onInput) => { input = onInput; }, stop: vi.fn(),
    drainInput: async () => {}, write: () => {}, columns: 120, rows: 40, kittyProtocolActive: false,
    moveBy: () => {}, hideCursor: () => {}, showCursor: () => {}, clearLine: () => {},
    clearFromCursor: () => {}, clearScreen: () => {}, setTitle: () => {},
    setProgress: () => {}, setProgramStatus: () => {},
  };
  const tui = new Tui(terminal);
  const editor = new Editor(tui, { borderColor: identity, selectList });
  const agents = Array.from({ length: count }, (_, i) => ({
    id: `a${i}`, type: "general-purpose", description: `task ${i}`, status: "running",
    toolUses: 0, startedAt: Date.now() + i, compactionCount: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    session: { subscribe: () => () => {}, messages: [] },
  } as unknown as AgentRecord));
  const abort = vi.fn();
  const manager = { listAgents: () => agents, abort, steer: vi.fn() } as unknown as AgentManager;
  const statuses = new Map<string, string | undefined>();
  let component: Component | undefined;
  const custom = vi.fn<FleetUICtx["custom"]>();
  const ui: FleetUICtx = {
    setWidget: (_key, factory) => { component = factory?.(tui, theme); },
    onTerminalInput: handler => tui.addInputListener(handler),
    getEditorText: () => editor.getText(), notify: vi.fn(), custom,
  };
  const widget = new AgentWidget(manager, new Map());
  widget.setUICtx({ setWidget: () => {}, setStatus: (key, value) => { statuses.set(key, value); } });
  widget.update();
  const fleet = new FleetList(manager, new Map());
  fleet.setUICtx(ui);
  fleet.update();
  tui.addChild(editor);
  tui.addChild({ render: width => component?.render(width) ?? [], invalidate: () => {} });
  tui.setFocus(editor);
  tui.start();
  cleanups.push(() => { fleet.dispose(); widget.dispose(); tui.stop(); });
  return {
    fleet, tui, editor, agents, abort, custom, statuses,
    press: (data: string) => input(data),
    render: (width = 120) => component?.render(width) ?? [],
  };
}

describe.each([TuiMainScreen, TuiAltScreen])("FleetList native %s input", Tui => {
  it.each([
    ["Enter on main", [DOWN, ENTER]],
    ["Up on main", [DOWN, UP]],
    ["Up on first agent", [DOWN, DOWN, UP]],
    ["Escape on agent", [DOWN, DOWN, ESC]],
    ["printable input", [DOWN, DOWN, "q"]],
  ])("visibly dismisses on %s without stopping agents", (_name, keys) => {
    const h = mount(Tui);
    expect(h.render().join("\n")).toContain("task 0");
    expect(h.statuses.get("subagents")).toBe("2 running agents");
    for (const key of keys) h.press(key);
    expect(h.render()).toEqual([]);
    h.fleet.update();
    expect(h.render()).toEqual([]);
    expect(h.statuses.get("subagents")).toBe("2 running agents");
    expect(h.agents.map(agent => agent.status)).toEqual(["running", "running"]);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.editor.getText()).toBe(keys.includes("q") ? "q" : "");
    expect(h.tui.getFocusedComponent()).toBe(h.editor);
  });

  it.each([DOWN, LEFT])("reopens with %j only at an empty prompt", key => {
    const h = mount(Tui);
    h.press(DOWN);
    h.press(ESC);
    expect(h.render()).toEqual([]);
    h.editor.setText("draft");
    h.press(key);
    expect(h.render()).toEqual([]);
    h.editor.setText("");
    h.press(key);
    expect(h.render()[0]).toContain("enter view");
    expect(h.render().find(line => line.includes("main"))).toContain("●");
    expect(h.abort).not.toHaveBeenCalled();
  });

  it.each([1, 8])("has exactly one trailing blank row with %i agents, none when dismissed", count => {
    const h = mount(Tui, count);
    for (const width of [20, 120]) {
      const lines = h.render(width);
      expect(lines.at(-1)).toBe("");
      expect(lines.at(-2)?.trim()).not.toBe("");
    }
    h.press(DOWN);
    h.press(ESC);
    expect(h.render()).toEqual([]);
  });

  it.each([false, true])("leaves an empty editor's autocomplete in charge (fleet active: %s)", async active => {
    const h = mount(Tui);
    if (active) h.press(DOWN);
    h.editor.setAutocompleteProvider({
      getSuggestions: async () => ({
        items: [{ value: "alpha", label: "alpha" }, { value: "beta", label: "beta" }], prefix: "",
      }),
      applyCompletion: (_lines, _line, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
    });
    h.editor.handleInput("\t");
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(h.editor.getText()).toBe("");
    expect(h.editor.isShowingAutocomplete()).toBe(true);
    h.press(DOWN);
    h.press(ENTER);
    expect(h.editor.getText()).toBe("beta");
    expect(h.editor.isShowingAutocomplete()).toBe(false);
    if (active) expect(h.render()).toEqual([]);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
  });

  it("ignores releases before activation, during navigation and after dismissal", () => {
    const h = mount(Tui);
    h.press("\x1b[1;1:3B");
    expect(h.render()[0]).toContain("← for agents");
    h.press(DOWN);
    h.press("\x1b[1;1:3B");
    expect(h.render().find(line => line.includes("main"))).toContain("●");
    h.press(DOWN);
    for (const release of ["\x1b[1;1:3A", "\x1b[13;1:3u", "\x1b[27;1:3u", "\x1b[113;1:3u"]) h.press(release);
    expect(h.render().find(line => line.includes("task 0"))).toContain("●");
    h.press(UP);
    h.press("\x1b[1;1:3B");
    h.press("\x1b[1;1:3D");
    expect(h.render()).toEqual([]);
    expect(h.abort).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
    expect(h.editor.getText()).toBe("");
  });
});
