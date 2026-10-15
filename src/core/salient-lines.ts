// Salience scoring for lines that a head/tail compaction would drop.
//
// A line scores when it stands out from the output around it: it reports a
// problem (error, warning, failure ...) while most lines do not, it has a
// layout no other line shares, it carries words no other line uses, or it shares
// almost no words with its neighbours. Every signal is relative to the output
// itself, so a word that appears on most lines (for example "error" in a search
// for "error") does not make a line salient.

const SEVERITY_PATTERN = /\b(?:error|errors|fatal|panic|panicked|fail|failed|failure|failures|failing|exception|traceback|warn|warning|warnings|denied|refused|abort|aborted|crash|crashed|segfault|timeout|timed out|unhandled|uncaught|assert|assertion|cannot|unable|invalid|unexpected|missing|not found|deprecated)\b/iu;
const WORD_PATTERN = /[a-z]{3,}/gu;
// Severity words count only while they stay this rare in the scored lines.
const MAX_SEVERITY_SHARE = 0.2;
// Token overlap below this with both neighbours counts as "unlike its neighbours".
const NEIGHBOUR_SIMILARITY_FLOOR = 0.25;

/** Minimum score for a line to count as salient. */
export const SALIENT_SCORE_THRESHOLD = 3;

const SEVERITY_SCORE = 3;
const UNIQUE_SHAPE_SCORE = 2;
const UNIQUE_WORD_SCORE = 1;
const UNLIKE_NEIGHBOURS_SCORE = 1;

// Layout of a line with the content abstracted away: letter runs become "a",
// digit runs "0", whitespace runs one space; punctuation stays.
export function lineShape(line: string): string {
  return line
    .trim()
    .replace(/[A-Za-z]+/gu, "a")
    .replace(/\d+/gu, "0")
    .replace(/\s+/gu, " ");
}

function lineWords(line: string): Set<string> {
  return new Set(line.toLowerCase().match(WORD_PATTERN) ?? []);
}

function similarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

/**
 * Scores lines[start, end) for salience against all of `lines`. Returns one
 * score per line in the range; scores of SALIENT_SCORE_THRESHOLD and above mark
 * salient lines. Blank lines and omission markers score 0.
 */
export function scoreSalientLines(lines: string[], start: number, end: number): number[] {
  const from = Math.max(0, start);
  const to = Math.min(lines.length, end);
  if (to <= from) {
    return [];
  }

  const shapes = lines.map(lineShape);
  const words = lines.map(lineWords);
  const shapeCounts = new Map<string, number>();
  const wordCounts = new Map<string, number>();
  let severityLines = 0;
  let scoredLines = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    scoredLines += 1;
    if (SEVERITY_PATTERN.test(line)) {
      severityLines += 1;
    }
    const shape = shapes[index] ?? "";
    shapeCounts.set(shape, (shapeCounts.get(shape) ?? 0) + 1);
    for (const word of words[index] ?? []) {
      wordCounts.set(word, (wordCounts.get(word) ?? 0) + 1);
    }
  }
  const severityIsRare = severityLines <= Math.max(1, Math.floor(scoredLines * MAX_SEVERITY_SHARE));

  const scores: number[] = [];
  for (let index = from; index < to; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || /^\.\.\. \d+ lines omitted \.\.\.$/u.test(line)) {
      scores.push(0);
      continue;
    }
    let score = 0;
    if (severityIsRare && SEVERITY_PATTERN.test(line)) {
      score += SEVERITY_SCORE;
    }
    if (shapeCounts.get(shapes[index] ?? "") === 1) {
      score += UNIQUE_SHAPE_SCORE;
    }
    const own = words[index] ?? new Set<string>();
    if ([...own].some((word) => wordCounts.get(word) === 1)) {
      score += UNIQUE_WORD_SCORE;
    }
    const before = index > 0 ? words[index - 1] : undefined;
    const after = index + 1 < lines.length ? words[index + 1] : undefined;
    const neighbours = [before, after].filter((entry): entry is Set<string> => entry !== undefined && entry.size > 0);
    if (own.size > 0 && neighbours.length > 0 && neighbours.every((entry) => similarity(own, entry) < NEIGHBOUR_SIMILARITY_FLOOR)) {
      score += UNLIKE_NEIGHBOURS_SCORE;
    }
    scores.push(score);
  }
  return scores;
}

/**
 * Picks salient lines from lines[start, end): highest score first (ties go to
 * the earlier line), at most maxLines, and only while the summed cost stays
 * within maxCost. Returns the picked indices in ascending order.
 */
export function selectSalientLines(
  lines: string[],
  start: number,
  end: number,
  maxLines: number,
  maxCost: number,
  cost: (index: number) => number,
): number[] {
  if (maxLines <= 0 || maxCost <= 0) {
    return [];
  }
  const scores = scoreSalientLines(lines, start, end);
  const candidates = scores
    .map((score, offset) => ({ index: start + offset, score }))
    .filter((entry) => entry.score >= SALIENT_SCORE_THRESHOLD)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const picked: number[] = [];
  let used = 0;
  for (const { index } of candidates) {
    if (picked.length >= maxLines) {
      break;
    }
    const lineCost = cost(index);
    if (used + lineCost > maxCost) {
      continue;
    }
    used += lineCost;
    picked.push(index);
  }
  return picked.sort((left, right) => left - right);
}
