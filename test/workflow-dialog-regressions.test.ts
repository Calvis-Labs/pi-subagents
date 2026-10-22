import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import * as card from "../src/ui/workflow-card.js";
import { initialWorkflowDialogState, layoutWorkflowDialog, WorkflowDialog, type WorkflowDialogSource } from "../src/ui/workflow-dialog.js";
import type { WorkflowAgentEntry, WorkflowEntry } from "../src/workflow/progress.js";

const theme = { fg: (_: string, text: string) => `\x1b[32m${text}\x1b[39m`, bold: (text: string) => `\x1b[1m${text}\x1b[22m` };
const child = (index: number): WorkflowAgentEntry => ({ type: "workflow_agent", index, label: `child-${index}`, state: "progress", recordId: `rec-${index}` });
const source = (progress: WorkflowEntry[]): WorkflowDialogSource => ({ task: { status: "running", startTime: 0 }, progress });

describe("inspector regressions", () => {
  it("visits every detail line in each paging direction after resizing", () => {
    const numbered = Array.from({ length: 30 }, (_, i) => `LINE-${String(i).padStart(2, "0")}`);
    const terminal = { rows: 12 };
    const d = new WorkflowDialog({ terminal, requestRender() {} } as TUI,
      () => source([{ ...child(0), promptPreview: numbered.join("\n") }]), theme, () => {},
      { onKill() {}, onPause() {}, onSkipAgent() {}, onRetryAgent() {}, onOpenAgent() {} });
    try {
      d.handleInput("\r"); d.handleInput("\r");
      for (const [width, height] of [[43, 12], [55, 18], [108, 28], [43, 12]]) {
        terminal.rows = height;
        for (const key of ["\x1b[6~", "\x1b[5~"]) {
          const seen = new Set<string>();
          for (let page = 0; page < 100; page++) {
            const lines = d.render(width);
            expect(lines.length).toBeLessThanOrEqual(height);
            for (const match of stripTerminalSequences(lines.join("\n")).matchAll(/LINE-\d+/g)) seen.add(match[0]);
            d.handleInput(key);
          }
          expect([...seen].sort(), `${width}x${height} ${JSON.stringify(key)}`).toEqual(numbered);
        }
      }
    } finally { d.dispose(); }
  });

  it.each([false, true])("keeps the agent target when regrouping (render before action: %s)", renderFirst => {
    const progress: WorkflowEntry[] = [child(0)];
    const skip = vi.fn(), retry = vi.fn(), open = vi.fn();
    const d = new WorkflowDialog({ requestRender() {} } as TUI, () => source(progress), theme, () => {},
      { onSkipAgent: skip, onRetryAgent: retry, onOpenAgent: open });
    try {
      d.render(100);
      d.handleInput("\r");
      progress.push({ type: "workflow_phase", index: 0, title: "Later" }, { ...child(1), phaseIndex: 0 });
      if (renderFirst) expect(stripTerminalSequences(d.render(100).join("\n"))).toContain("❯ ⠋ child-0");
      d.handleInput("s"); d.handleInput("r"); d.handleInput("c");
      expect(skip).toHaveBeenLastCalledWith(0);
      expect(retry).toHaveBeenLastCalledWith(0);
      expect(open).toHaveBeenLastCalledWith("rec-0");
      progress.splice(0, 1);
      d.render(100);
      d.handleInput("s"); d.handleInput("r"); d.handleInput("c");
      expect(skip).toHaveBeenCalledTimes(1);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
      d.handleInput("j"); d.handleInput("s");
      expect(skip).toHaveBeenLastCalledWith(1);
    } finally { d.dispose(); }
  });

  it.each(["\x1b]52;c;VEVTVA==\x07", "\x1b]52;c;VEVTVA==\x1b\\", "\x9d52;c;VEVTVA==\x9c", "\x1b[2J", "\x9b2J", "\r\b\x00\x07\u202e\u2066\u2069"])("sanitizes untrusted fields before theming (%j)", attack => {
    const tagged = (s: string) => s + attack + "SAFE";
    const data = source([{ type: "workflow_phase", index: 0, title: tagged("phase") }, {
      ...child(0), state: "done", phaseIndex: 0, label: tagged("label"), model: tagged("model"),
      modelId: tagged("canonical"), requestedModel: tagged("requested"), fallbackModel: tagged("fallback"),
      thinking: tagged("thinking"), requestedThinking: tagged("asked"),
      promptPreview: tagged("prompt") + "\nsecond prompt", resultPreview: tagged("result") + "\nsecond result",
    }]);
    data.task.workflowName = tagged("name");
    data.meta = { name: tagged("meta"), description: tagged("description") };
    const d = new WorkflowDialog({ terminal: { rows: 80 }, requestRender() {} } as TUI, () => data, theme, () => {});
    try {
      const overview = d.render(300).join("\n");
      d.handleInput("\r");
      const details = d.render(300).join("\n");
      for (const output of [overview, details]) {
        expect(output).not.toContain(attack);
        expect(output).toContain("\x1b[32m");
        expect(stripTerminalSequences(output)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/);
        expect(output).not.toContain("VEVTVA==");
      }
      const plain = stripTerminalSequences(overview + "\n" + details);
      for (const field of ["phase", "label", "model", "canonical", "requested", "fallback", "thinking", "asked", "prompt", "result", "name", "description"]) expect(plain).toContain(`${field}SAFE`);
      expect(plain).toContain("second prompt"); expect(plain).toContain("second result");
    } finally { d.dispose(); }
  });

  it("sanitizes a newly observed empty phase and failed outcome", () => {
    const attack = "\x1b]52;c;VEVTVA==\x07";
    const data = source([{ type: "workflow_phase", index: 0, title: `empty${attack}` }]);
    const d = new WorkflowDialog({ requestRender() {} } as TUI, () => data, theme, () => {});
    try {
      expect(d.render(100).join("\n")).not.toContain(attack);
      data.progress = [{ ...child(0), state: "error", error: `error${attack}\nsecond error` }];
      d.handleInput("\r");
      const output = d.render(100).join("\n");
      expect(output).not.toContain(attack);
      expect(output).toContain("second error");
    } finally { d.dispose(); }
  });

  it("formats only viewport rows for large phase and child lists", () => {
    const format = vi.spyOn(card, "formatModel");
    const clamp = vi.spyOn(card, "clampLine");
    try {
      const progress: WorkflowEntry[] = Array.from({ length: 1000 }, (_, index) => ({ ...child(index), phaseIndex: 0 }));
      progress.push(...Array.from({ length: 1000 }, (_, index): WorkflowEntry => ({ type: "workflow_phase", index, title: `phase-${index}` })));
      for (const level of ["phases", "agent"] as const) {
        format.mockClear(); clamp.mockClear();
        const rows = layoutWorkflowDialog({ ...source(progress), width: 120, height: 32, state: { ...initialWorkflowDialogState(), level, selectedAgent: 999 } });
        expect(rows.flat().map(s => s.text).join("")).toContain("child-999");
        expect(format.mock.calls.length).toBeLessThanOrEqual(23);
        expect(clamp.mock.calls.length).toBeLessThan(150);
      }
    } finally { vi.restoreAllMocks(); }
  });

  it("reduces settled redraws while still reading late source updates", () => {
    vi.useFakeTimers();
    const data = source([child(0)]);
    const requestRender = vi.fn();
    const d = new WorkflowDialog({ requestRender } as unknown as TUI, () => data, theme, () => {});
    try {
      d.render(100);
      vi.advanceTimersByTime(800);
      expect(requestRender.mock.calls.length).toBeGreaterThanOrEqual(9);
      data.task.status = "completed";
      d.render(100); requestRender.mockClear();
      vi.advanceTimersByTime(800);
      expect(requestRender.mock.calls.length).toBeLessThanOrEqual(1);
      data.progress = [{ ...child(0), state: "done", label: "late-result" }];
      vi.advanceTimersByTime(1100);
      expect(requestRender).toHaveBeenCalled();
      expect(d.render(100).join("\n")).toContain("late-result");
    } finally { d.dispose(); vi.useRealTimers(); }
  });
});
