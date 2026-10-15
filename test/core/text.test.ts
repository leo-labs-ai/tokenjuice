import { describe, expect, it } from "vitest";

import { clampText, clampTextWithMetadata, countTerminalCells, countTextChars, headCentreTail, headTail, stripAnsi } from "../../src/core/text.js";

const omittedCounts = (lines: string[]): number[] =>
  lines.flatMap((line) => {
    const match = /^\.\.\. (\d+) lines omitted \.\.\.$/u.exec(line);
    return match ? [Number(match[1])] : [];
  });

// Every output line is either one original line (whole or clipped) or a marker
// that stands for N original lines.
const accountedLines = (lines: string[]): number => {
  const counts = omittedCounts(lines);
  return lines.length - counts.length + counts.reduce((sum, count) => sum + count, 0);
};

describe("text helpers", () => {
  it("strips xterm colors and OSC hyperlinks while preserving emoji and CJK", () => {
    const input = [
      "\u001b[38;5;196m错误🔥\u001b[0m",
      "\u001b]8;;https://openclaw.ai\u0007链接🔗\u001b]8;;\u0007",
      "\u001b[38;2;120;200;255mblue🦊\u001b[0m",
    ].join(" ");

    const stripped = stripAnsi(input);

    expect(stripped).toBe("错误🔥 链接🔗 blue🦊");
    expect(stripped).not.toContain("\u001b");
    expect(countTextChars(stripped)).toBe(13);
  });

  it("clamps text without splitting emoji graphemes", () => {
    const input = "🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂abc123xyz";
    const clamped = clampText(input, 18);

    expect(clamped).toBe("\n... truncated ...");
    expect(countTextChars(clamped)).toBeLessThanOrEqual(18);
  });

  it("records tail truncation metadata when clampTextWithMetadata shortens output", () => {
    const result = clampTextWithMetadata("abcdefghijklmnopqrstuvwxyz", 10);

    expect(result.text).toContain("... truncated ...");
    expect(result.compaction).toEqual({ authoritative: true, kinds: ["tail-truncation"] });
  });

  it("does not mark headTail as omission when both sides are zero or negative", () => {
    expect(headTail(["a", "b", "c"], 0, 0)).toEqual({ lines: ["a", "b", "c"] });
    expect(headTail(["a", "b", "c"], -2, -3)).toEqual({ lines: ["a", "b", "c"] });
  });

  it("counts terminal cells for emoji, cjk, and combining characters", () => {
    expect(countTerminalCells("abc")).toBe(3);
    expect(countTerminalCells("错误")).toBe(4);
    expect(countTerminalCells("🦊")).toBe(2);
    expect(countTerminalCells("e\u0301")).toBe(1);
    expect(countTerminalCells("👨‍👩‍👧‍👦")).toBe(2);
  });

  it("counts visible cells after ansi stripping", () => {
    const input = "\u001b[31m错误🔥\u001b[0m \u001b]8;;https://openclaw.ai\u0007完了✅\u001b]8;;\u0007";
    const stripped = stripAnsi(input);

    expect(stripped).toBe("错误🔥 完了✅");
    expect(countTerminalCells(stripped)).toBe(13);
  });

  it("strips dangling ansi and osc fragments instead of leaking escape garbage", () => {
    const input = "ok \u001b[38;5;196broken \u001b]8;;https://openclaw.aibroken-link";
    const stripped = stripAnsi(input);

    expect(stripped.startsWith("ok ")).toBe(true);
    expect(stripped).not.toContain("broken-link");
    expect(stripped).not.toContain("\u001b");
  });

  it("prefers line boundaries when truncating long line-oriented text", () => {
    const input = [
      "line 1",
      "line 2",
      "line 3",
      "line 4",
      "line 5",
      "line 6",
      "line 7",
      "line 8",
    ].join("\n");

    const clamped = clampText(input, 40);

    expect(clamped).toContain("\n... truncated ...");
    expect(clamped).not.toContain("li\n... truncated ...");
  });
  describe("headCentreTail", () => {
    const rows = (count: number, width: number) =>
      Array.from({ length: count }, (_, index) => `row ${index} ${"x".repeat(width)}`);

    it("matches headTail when the lines already fit the budget", () => {
      const lines = rows(30, 2);
      expect(headCentreTail(lines, 8, 8, 1200)).toEqual(headTail(lines, 8, 8));
    });

    it("keeps head, tail and a centre excerpt with exact omission counts", () => {
      const lines = rows(1000, 40);
      const result = headCentreTail(lines, 8, 8, 1200);
      const text = result.lines.join("\n");

      expect(countTextChars(text)).toBeLessThanOrEqual(1200);
      expect(result.lines.slice(0, 8)).toEqual(lines.slice(0, 8));
      expect(result.lines.slice(-8)).toEqual(lines.slice(-8));
      expect(result.lines).toContain(lines[500]);
      expect(omittedCounts(result.lines)).toHaveLength(2);
      expect(accountedLines(result.lines)).toBe(1000);
      expect(result.compaction).toEqual({ authoritative: true, kinds: ["head-tail-omission"] });
    });

    it("counts the lines behind an earlier omission marker", () => {
      const lines = [...rows(40, 40), "... 500 lines omitted ...", ...rows(40, 40)];
      const result = headCentreTail(lines, 8, 8, 1200);

      expect(accountedLines(result.lines)).toBe(lines.length - 1 + 500);
    });

    it("clips long lines, states the cut chars and stays within the budget", () => {
      const lines = Array.from({ length: 40 }, (_, index) => `line ${index} ${"y".repeat(500)}`);
      const result = headCentreTail(lines, 8, 8, 1200);

      expect(countTextChars(result.lines.join("\n"))).toBeLessThanOrEqual(1200);
      expect(result.lines.join("\n")).toMatch(/…\[\+\d+ chars\]/u);
      expect(result.lines.some((line) => line.startsWith("line 20 "))).toBe(true);
      expect(accountedLines(result.lines)).toBe(40);
      expect(result.compaction?.kinds).toEqual(["head-tail-omission", "middle-truncation"]);
    });

    it("keeps the middle of a few overlong lines when nothing is omitted by count", () => {
      const lines = Array.from({ length: 5 }, (_, index) => `part ${index} ${"z".repeat(600)}`);
      const result = headCentreTail(lines, 8, 8, 1200);

      expect(countTextChars(result.lines.join("\n"))).toBeLessThanOrEqual(1200);
      expect(result.lines.some((line) => line.startsWith("part 2 "))).toBe(true);
      expect(accountedLines(result.lines)).toBe(5);
    });

    it("keeps a salient line from the omitted middle of long output within the budget", () => {
      const lines = rows(1000, 40);
      lines[173] = "error: disk quota exceeded while writing cache";
      const result = headCentreTail(lines, 8, 8, 1200);

      expect(countTextChars(result.lines.join("\n"))).toBeLessThanOrEqual(1200);
      expect(result.lines).toContain(lines[173]);
      expect(result.lines).toContain(lines[500]);
      expect(result.lines.slice(-8)).toEqual(lines.slice(-8));
      expect(omittedCounts(result.lines)).toHaveLength(3);
      expect(accountedLines(result.lines)).toBe(1000);
    });

    it("adds salient middle lines to headTail when the lines already fit", () => {
      const lines = rows(30, 2);
      lines[14] = "WARNING: retry budget exhausted";
      const result = headCentreTail(lines, 8, 8, 1200);

      expect(result.lines).toEqual([
        ...lines.slice(0, 8),
        "... 6 lines omitted ...",
        lines[14],
        "... 7 lines omitted ...",
        ...lines.slice(-8),
      ]);
      expect(result.compaction).toEqual({ authoritative: true, kinds: ["head-tail-omission"] });
    });

    it("caps salient lines at min(head, tail) and their share of the budget", () => {
      const lines = rows(1000, 40);
      for (const index of [100, 200, 300, 400, 600, 700, 800, 900]) {
        lines[index] = `failure ${index}: unexpected token in stream ${"q".repeat(index % 7)}`;
      }
      const result = headCentreTail(lines, 3, 3, 1200);
      const kept = result.lines.filter((line) => line.startsWith("failure "));

      expect(countTextChars(result.lines.join("\n"))).toBeLessThanOrEqual(1200);
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThanOrEqual(3);
      expect(accountedLines(result.lines)).toBe(1000);
    });

    it("falls back to headTail for one-sided or tiny inputs", () => {
      const lines = rows(100, 40);
      expect(headCentreTail(lines, 8, 0, 400)).toEqual(headTail(lines, 8, 0));
      expect(headCentreTail(["a", "b"], 1, 1, 1)).toEqual(headTail(["a", "b"], 1, 1));
    });
  });
});
