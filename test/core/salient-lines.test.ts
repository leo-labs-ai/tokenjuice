import { describe, expect, it } from "vitest";

import { SALIENT_SCORE_THRESHOLD, lineShape, scoreSalientLines, selectSalientLines } from "../../src/core/salient-lines.js";

const logLines = (count: number) =>
  Array.from({ length: count }, (_, index) => `2026-10-14T12:${String(index % 60).padStart(2, "0")}:00Z INFO request served id=${1000 + index}`);

const salientIndices = (lines: string[]) =>
  scoreSalientLines(lines, 0, lines.length).flatMap((score, index) => (score >= SALIENT_SCORE_THRESHOLD ? [index] : []));

describe("salient lines", () => {
  it("abstracts letters, digits and whitespace into a line shape", () => {
    expect(lineShape("  src/app.ts:12:  call(x)")).toBe("a/a.a:0: a(a)");
    expect(lineShape("id=42 ok")).toBe(lineShape("pid=7 fine"));
  });

  it("finds nothing in uniform output", () => {
    expect(salientIndices(logLines(100))).toEqual([]);
  });

  it("flags a problem report among routine lines", () => {
    const lines = logLines(100);
    lines[37] = "2026-10-14T12:37:00Z ERROR request failed id=1037";
    expect(salientIndices(lines)).toEqual([37]);
  });

  it("flags a line with an unusual layout and words", () => {
    const lines = logLines(100);
    lines[61] = "checksum mismatch for chunk 7f3a";
    expect(salientIndices(lines)).toEqual([61]);
  });

  it("does not flag severity words that appear on most lines", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `src/file${index}.ts:${index + 1}: throw new Error("bad input")`);
    expect(salientIndices(lines)).toEqual([]);
  });

  it("ignores blank lines and omission markers", () => {
    const lines = [...logLines(20), "", "... 40 lines omitted ...", ...logLines(20)];
    expect(salientIndices(lines)).toEqual([]);
  });

  it("scores only the requested range", () => {
    const lines = logLines(30);
    lines[3] = "fatal: unable to open repository";
    lines[20] = "fatal: unable to read index";
    expect(scoreSalientLines(lines, 10, 30)).toHaveLength(20);
    expect(selectSalientLines(lines, 10, 30, 5, 1000, () => 1)).toEqual([20]);
  });

  it("selects the highest scores within the line and cost limits, in line order", () => {
    const lines = logLines(200);
    lines[150] = "2026-10-14T12:30:00Z WARN slow request id=1150";
    lines[40] = "panic: runtime error: index out of range [3] with length 3";
    lines[90] = "unrelated trailing note";

    const all = selectSalientLines(lines, 0, lines.length, 5, 10_000, () => 1);
    expect(all).toEqual([40, 90, 150]);

    expect(selectSalientLines(lines, 0, lines.length, 1, 10_000, () => 1)).toEqual([40]);
    // A line whose cost does not fit is skipped; cheaper lines still fit.
    const cost = (index: number) => (index === 40 ? 100 : 10);
    expect(selectSalientLines(lines, 0, lines.length, 5, 25, cost)).toEqual([90, 150]);
    expect(selectSalientLines(lines, 0, lines.length, 0, 10_000, () => 1)).toEqual([]);
    expect(selectSalientLines(lines, 0, lines.length, 5, 0, () => 1)).toEqual([]);
  });
});
