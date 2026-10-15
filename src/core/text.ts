import { createCompactionMetadata, type CompactionKind, type CompactionMetadata } from "./compaction-metadata.js";
import { selectSalientLines } from "./salient-lines.js";

const ANSI_CSI_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");
const ANSI_OSC_PATTERN = new RegExp(String.raw`\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)`, "g");
const ANSI_CSI_INCOMPLETE_PATTERN = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*$`, "g");
const ANSI_OSC_INCOMPLETE_PATTERN = new RegExp(String.raw`\u001B\][^\u0007\u001B]*$`, "g");
const ANSI_SINGLE_PATTERN = new RegExp(String.raw`\u001B[@-_]`, "g");
const TRUNCATION_SUFFIX = "\n... truncated ...";
const MIDDLE_TRUNCATION_MARKER = "\n... omitted ...\n";
const COMBINING_MARK_PATTERN = /\p{Mark}/u;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const graphemeSegmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
  ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
  : null;

function graphemes(text: string): string[] {
  if (!graphemeSegmenter) {
    return Array.from(text);
  }

  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

function trimHeadToLineBoundary(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1 || lastNewline < Math.floor(text.length * 0.5)) {
    return text;
  }
  return text.slice(0, lastNewline);
}

function trimTailToLineBoundary(text: string): string {
  const firstNewline = text.indexOf("\n");
  if (firstNewline === -1 || firstNewline > Math.ceil(text.length * 0.5)) {
    return text;
  }
  return text.slice(firstNewline + 1);
}

export function stripAnsi(text: string): string {
  return text
    .replaceAll(ANSI_OSC_PATTERN, "")
    .replaceAll(ANSI_CSI_PATTERN, "")
    .replaceAll(ANSI_OSC_INCOMPLETE_PATTERN, "")
    .replaceAll(ANSI_CSI_INCOMPLETE_PATTERN, "")
    .replaceAll(ANSI_SINGLE_PATTERN, "")
    .replaceAll("\u001b", "");
}

export function countTextChars(text: string): number {
  return graphemes(text).length;
}

export function sliceTextChars(text: string, start: number, end?: number): string {
  return graphemes(text).slice(start, end).join("");
}

function codePointWidth(codePoint: number): number {
  if (
    codePoint === 0
    || (codePoint >= 0x0000 && codePoint < 0x0020)
    || (codePoint >= 0x007f && codePoint < 0x00a0)
  ) {
    return 0;
  }

  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  ) {
    return 2;
  }

  return 1;
}

function graphemeWidth(segment: string): number {
  if (segment === "") {
    return 0;
  }

  if (EMOJI_PATTERN.test(segment)) {
    return 2;
  }

  let width = 0;
  let hasVisibleCodePoint = false;
  for (const char of segment) {
    if (char === "\u200d" || char === "\ufe0f" || COMBINING_MARK_PATTERN.test(char)) {
      continue;
    }
    width = Math.max(width, codePointWidth(char.codePointAt(0) ?? 0));
    hasVisibleCodePoint = true;
  }

  return hasVisibleCodePoint ? width : 0;
}

export function countTerminalCells(text: string): number {
  return graphemes(text).reduce((sum, segment) => sum + graphemeWidth(segment), 0);
}

export function normalizeLines(text: string): string[] {
  return text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""));
}

export function trimEmptyEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start]?.trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1]?.trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

export function dedupeAdjacent(lines: string[]): string[] {
  const next: string[] = [];
  for (const line of lines) {
    if (next[next.length - 1] !== line) {
      next.push(line);
    }
  }
  return next;
}

export function headTail(lines: string[], head: number, tail: number): { lines: string[]; compaction?: CompactionMetadata } {
  const safeHead = Math.max(0, head);
  const safeTail = Math.max(0, tail);
  if (safeHead === 0 && safeTail === 0) {
    return { lines };
  }

  if (lines.length <= safeHead + safeTail) {
    return { lines };
  }

  return {
    lines: [
      ...lines.slice(0, safeHead),
      `... ${lines.length - safeHead - safeTail} lines omitted ...`,
      ...lines.slice(-safeTail),
    ],
    compaction: createCompactionMetadata("head-tail-omission"),
  };
}

const OMITTED_LINES_MARKER_PATTERN = /^\.\.\. (\d+) lines omitted \.\.\.$/u;
// Upper bound for one "... N lines omitted ..." marker plus its newline.
const OMITTED_LINES_MARKER_RESERVE = 32;
const CENTRE_EXCERPT_SHARE = 0.2;
// Share of the budget for salient lines picked from the omitted middle.
const SALIENT_SHARE = 0.15;
const HEAD_SHARE = 0.7;
const MIN_PARTIAL_LINE_CHARS = 48;

function formatOmittedLines(count: number): string {
  return `... ${count} lines omitted ...`;
}

// Counts original lines in a dropped range. An earlier "... N lines omitted ..."
// marker stands for N lines, so the new marker never under-reports.
function countOmittedLines(lines: string[]): number {
  let total = 0;
  for (const line of lines) {
    const match = OMITTED_LINES_MARKER_PATTERN.exec(line);
    total += match ? Number(match[1]) : 1;
  }
  return total;
}

// Clips one line to at most maxChars and states how many chars were cut.
function clipLine(line: string, maxChars: number, keepEnd: boolean): { text: string; clipped: boolean } {
  const segments = graphemes(line);
  if (segments.length <= maxChars) {
    return { text: line, clipped: false };
  }
  const keep = Math.max(0, maxChars - `…[+${segments.length} chars]`.length);
  const omitted = segments.length - keep;
  if (keepEnd) {
    return { text: `[+${omitted} chars]…${keep > 0 ? segments.slice(-keep).join("") : ""}`, clipped: true };
  }
  return { text: `${segments.slice(0, keep).join("")}…[+${omitted} chars]`, clipped: true };
}

// True when lines joined by newlines have at most maxChars graphemes. Stops
// counting as soon as the budget is exceeded.
function fitsInChars(lines: string[], maxChars: number): boolean {
  let codeUnits = Math.max(0, lines.length - 1);
  for (const line of lines) {
    codeUnits += line.length;
  }
  if (codeUnits <= maxChars) {
    return true;
  }
  let chars = Math.max(0, lines.length - 1);
  for (const line of lines) {
    chars += countTextChars(line);
    if (chars > maxChars) {
      return false;
    }
  }
  return true;
}

// Joins kept head lines, kept middle lines (by original index) and kept tail
// lines, putting one "... N lines omitted ..." marker on every gap.
function assembleKept(lines: string[], headLines: string[], middle: Map<number, string>, tailKeptStart: number, tailLines: string[]): { lines: string[]; omitted: boolean } {
  const output = [...headLines];
  let cursor = headLines.length;
  let omitted = false;
  for (const index of [...middle.keys()].sort((left, right) => left - right)) {
    if (index > cursor) {
      output.push(formatOmittedLines(countOmittedLines(lines.slice(cursor, index))));
      omitted = true;
    }
    output.push(middle.get(index) ?? "");
    cursor = index + 1;
  }
  if (tailKeptStart > cursor) {
    output.push(formatOmittedLines(countOmittedLines(lines.slice(cursor, tailKeptStart))));
    omitted = true;
  }
  output.push(...tailLines);
  return { lines: output, omitted };
}

/**
 * Like headTail, but for output longer than maxChars it also keeps an excerpt
 * from the centre of the dropped range and fits the result into maxChars, so a
 * later middle clamp does not cut it.
 *
 * - Salient lines of the dropped range (see salient-lines.ts: problem reports,
 *   one-off layouts or words, lines unlike their neighbours) are kept first:
 *   at most min(head, tail) lines and SALIENT_SHARE of the budget, markers
 *   included. This also applies when the output already fits maxChars.
 * - The centre excerpt grows out from the middle line: at most min(head, tail)
 *   lines and CENTRE_EXCERPT_SHARE of the budget.
 * - When head, centre and tail fit, head and tail are exactly headTail's.
 *   Otherwise head and tail share the rest of the budget 70/30, like the middle
 *   clamp, and a partly kept line states how many chars were cut.
 * - Each "... N lines omitted ..." marker counts the original lines it replaces.
 */
export function headCentreTail(lines: string[], head: number, tail: number, maxChars: number): { lines: string[]; compaction?: CompactionMetadata } {
  if (head <= 0 || tail <= 0 || lines.length < 3) {
    return headTail(lines, head, tail);
  }
  const gap = lines.length > head + tail;
  const centreCap = Math.min(head, tail);

  const charCache = new Map<number, number>();
  const lineChars = (index: number): number => {
    let chars = charCache.get(index);
    if (chars === undefined) {
      chars = countTextChars(lines[index] ?? "");
      charCache.set(index, chars);
    }
    return chars;
  };
  // A salient line costs its chars, its newline and the extra marker it splits off.
  const salientCost = (index: number): number => lineChars(index) + 1 + OMITTED_LINES_MARKER_RESERVE;

  // Output that already fits keeps headTail's head and tail and adds only the
  // salient lines of the omitted middle; the centre excerpt is for output that
  // would otherwise be clamped.
  if (fitsInChars(lines, maxChars)) {
    const plain = headTail(lines, head, tail);
    if (!gap) {
      return plain;
    }
    const picks = selectSalientLines(lines, head, lines.length - tail, centreCap, Math.floor(maxChars * SALIENT_SHARE), salientCost);
    const kept = assembleKept(lines, lines.slice(0, head), new Map(picks.map((index) => [index, lines[index] ?? ""])), lines.length - tail, lines.slice(-tail));
    return picks.length > 0 && fitsInChars(kept.lines, maxChars)
      ? { lines: kept.lines, compaction: createCompactionMetadata("head-tail-omission") }
      : plain;
  }

  const middle = Math.floor(lines.length / 2);
  const headEnd = gap ? head : middle;
  const tailStart = gap ? lines.length - tail : middle + 1;
  const seed = Math.min(Math.max(middle, headEnd), tailStart - 1);
  const available = Math.max(0, maxChars - 2 * OMITTED_LINES_MARKER_RESERVE);

  const salientPicks = gap
    ? selectSalientLines(lines, headEnd, tailStart, centreCap, Math.floor(available * SALIENT_SHARE), salientCost)
    : [];
  const salientChars = salientPicks.reduce((sum, index) => sum + salientCost(index), 0);

  // Centre excerpt [centreStart, centreEnd), grown alternately below and above the seed.
  const centreBudget = Math.floor(available * CENTRE_EXCERPT_SHARE);
  const seedLine = clipLine(lines[seed] ?? "", centreBudget, false);
  let centreChars = countTextChars(seedLine.text);
  let centreStart = seed;
  let centreEnd = seed + 1;
  let growDown = true;
  let growUp = true;
  while ((growDown || growUp) && centreEnd - centreStart < centreCap) {
    if (growDown) {
      const cost = centreEnd < tailStart ? lineChars(centreEnd) + 1 : Number.POSITIVE_INFINITY;
      growDown = centreChars + cost <= centreBudget;
      if (growDown) {
        centreChars += cost;
        centreEnd += 1;
      }
    }
    if (growUp && centreEnd - centreStart < centreCap) {
      const cost = centreStart > headEnd ? lineChars(centreStart - 1) + 1 : Number.POSITIVE_INFINITY;
      growUp = centreChars + cost <= centreBudget;
      if (growUp) {
        centreChars += cost;
        centreStart -= 1;
      }
    }
  }

  const remaining = Math.max(0, available - centreChars - salientChars);
  let headFull = 0;
  for (let index = 0; index < headEnd; index += 1) {
    headFull += lineChars(index) + 1;
  }
  let tailFull = 0;
  for (let index = tailStart; index < lines.length; index += 1) {
    tailFull += lineChars(index) + 1;
  }

  let clipped = seedLine.clipped;
  const headLines: string[] = [];
  const tailLines: string[] = [];
  let tailKeptStart = lines.length;
  if (headFull + tailFull <= remaining) {
    headLines.push(...lines.slice(0, headEnd));
    tailLines.push(...lines.slice(tailStart));
    tailKeptStart = tailStart;
  } else {
    const headBudget = Math.max(Math.floor(remaining * HEAD_SHARE), remaining - tailFull);
    let headUsed = 0;
    for (let index = 0; index < headEnd; index += 1) {
      const cost = lineChars(index) + 1;
      if (headUsed + cost <= headBudget) {
        headLines.push(lines[index] ?? "");
        headUsed += cost;
        continue;
      }
      const rest = headBudget - headUsed - 1;
      if (rest >= MIN_PARTIAL_LINE_CHARS || headLines.length === 0) {
        const partial = clipLine(lines[index] ?? "", Math.max(0, rest), false);
        headLines.push(partial.text);
        headUsed += countTextChars(partial.text) + 1;
        clipped = true;
      }
      break;
    }
    const tailBudget = Math.max(0, remaining - headUsed);
    let tailUsed = 0;
    for (let index = lines.length - 1; index >= tailStart; index -= 1) {
      const cost = lineChars(index) + 1;
      if (tailUsed + cost <= tailBudget) {
        tailLines.unshift(lines[index] ?? "");
        tailUsed += cost;
        tailKeptStart = index;
        continue;
      }
      const rest = tailBudget - tailUsed - 1;
      if (rest >= MIN_PARTIAL_LINE_CHARS || tailLines.length === 0) {
        tailLines.unshift(clipLine(lines[index] ?? "", Math.max(0, rest), true).text);
        tailKeptStart = index;
        clipped = true;
      }
      break;
    }
  }

  const middleLines = new Map<number, string>(salientPicks.map((index) => [index, lines[index] ?? ""]));
  for (let index = centreStart; index < centreEnd; index += 1) {
    middleLines.set(index, index === seed ? seedLine.text : lines[index] ?? "");
  }
  const { lines: output, omitted } = assembleKept(lines, headLines, middleLines, tailKeptStart, tailLines);
  const kinds: CompactionKind[] = [
    ...(omitted ? ["head-tail-omission" as const] : []),
    ...(clipped ? ["middle-truncation" as const] : []),
  ];
  return kinds.length > 0 ? { lines: output, compaction: createCompactionMetadata(...kinds) } : { lines: output };
}

export function clampText(text: string, maxChars: number): string {
  if (countTextChars(text) <= maxChars) {
    return text;
  }
  const bodyChars = Math.max(0, maxChars - countTextChars(TRUNCATION_SUFFIX));
  const head = trimHeadToLineBoundary(graphemes(text).slice(0, bodyChars).join(""));
  return `${head}${TRUNCATION_SUFFIX}`;
}

export function clampTextWithMetadata(text: string, maxChars: number): { text: string; compaction?: CompactionMetadata } {
  if (countTextChars(text) <= maxChars) {
    return { text };
  }

  return {
    text: clampText(text, maxChars),
    compaction: createCompactionMetadata("tail-truncation"),
  };
}

export function clampTextMiddle(text: string, maxChars: number): string {
  return clampTextMiddleWithMetadata(text, maxChars).text;
}

export function clampTextMiddleWithMetadata(text: string, maxChars: number): { text: string; compaction?: CompactionMetadata } {
  if (countTextChars(text) <= maxChars) {
    return { text };
  }

  const markerChars = countTextChars(MIDDLE_TRUNCATION_MARKER);
  const bodyChars = Math.max(0, maxChars - markerChars);
  const headChars = Math.ceil(bodyChars * 0.7);
  const tailChars = Math.max(0, bodyChars - headChars);
  const segments = graphemes(text);
  const head = trimHeadToLineBoundary(segments.slice(0, headChars).join(""));
  const tail = trimTailToLineBoundary(segments.slice(-tailChars).join(""));

  return {
    text: `${head}${MIDDLE_TRUNCATION_MARKER}${tail}`,
    compaction: createCompactionMetadata("middle-truncation"),
  };
}

export function pluralize(count: number, noun: string): string {
  if (/(?:passed|failed|skipped)$/u.test(noun)) {
    return `${count} ${noun}`;
  }

  if (count === 1) {
    return `${count} ${noun}`;
  }

  if (/[sxz]$/u.test(noun) || /(sh|ch)$/u.test(noun)) {
    return `${count} ${noun}es`;
  }

  if (/[^aeiou]y$/u.test(noun)) {
    return `${count} ${noun.slice(0, -1)}ies`;
  }

  return `${count} ${noun}s`;
}
