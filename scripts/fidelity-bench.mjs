#!/usr/bin/env node
// Fidelity bench: how much evidence does tokenjuice compaction drop, and at what cost?
//
// (a) Draws a seeded random sample of stored tool outputs (*.txt), runs the
//     library reducer on each, and reports compaction rate, chars omitted (raw
//     lines whose text is absent from the inline output), chars saved (raw chars
//     minus inline chars) and inline chars (what the model pays for).
// (b) Planted needles: inserts a unique NEEDLE line at the middle line of each
//     sampled file (needleRetentionPct) and, separately, at a seeded random
//     line (needleRandomRetentionPct), reduces again and checks the inline text.
//     In search output the needle carries the displaced line's path:line: prefix.
// (c) Failure path: reduces every sample again with exitCode 1 and prints a hash
//     of all failure outputs (failureSha). Equal hashes on two checkouts prove
//     that failure output did not change. tscDiagnosticsKept counts intact
//     diagnostics kept from a synthetic 100-error tsc failure.
//
// Prints one JSON summary line. No build and no dependencies: the TypeScript
// sources load directly through Node type stripping (Node >= 22.18).
//
// Usage:
//   node scripts/fidelity-bench.mjs [--dir DIR | --synthetic] [--seed N] [--sample N]
//     [--src SRC_DIR] [--max-inline-chars N] [--before ISO_OR_MS] [--by-family]
//     [--manifest-out FILE] [--vocab N]
//
// The default directory (~/.pi/vanilla-agent/tokenjuice) grows while agents
// run and is private. Pass --before (mtime cutoff) so two runs draw the same
// pool; sampleSha in the output proves both runs read identical files.
// --manifest-out writes the sampled names and content hashes (no content).
// --synthetic builds a deterministic public corpus from the seed instead.
// --vocab N (synthetic only, default 10) draws words from N generated words
// instead of the fixed 10-word list. A small vocabulary makes every line look
// alike, so a planted needle is the only outlier; use --vocab 250 to check that
// a change does not just exploit that (overfit check).
// --src benches another checkout's src/, for example a BASE commit:
//   git archive <sha> src | tar -x -C /tmp/tj-base && node scripts/fidelity-bench.mjs --src /tmp/tj-base/src

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function parseArgs(argv) {
  const opts = {
    dir: join(homedir(), ".pi", "vanilla-agent", "tokenjuice"),
    synthetic: false,
    seed: 42,
    sample: 200,
    src: resolve(dirname(fileURLToPath(import.meta.url)), "..", "src"),
    maxInlineChars: undefined,
    byFamily: false,
    before: undefined,
    manifestOut: undefined,
    vocab: 10,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (argv[i] === undefined) throw new Error("missing value for " + arg);
      return argv[i];
    };
    if (arg === "--dir") opts.dir = resolve(next());
    else if (arg === "--synthetic") opts.synthetic = true;
    else if (arg === "--seed") opts.seed = Number(next());
    else if (arg === "--sample") opts.sample = Number(next());
    else if (arg === "--src") opts.src = resolve(next());
    else if (arg === "--max-inline-chars") opts.maxInlineChars = Number(next());
    else if (arg === "--by-family") opts.byFamily = true;
    else if (arg === "--manifest-out") opts.manifestOut = resolve(next());
    else if (arg === "--vocab") {
      opts.vocab = Number(next());
      if (!Number.isInteger(opts.vocab) || opts.vocab < 2) throw new Error("--vocab must be an integer >= 2");
    }
    else if (arg === "--before") {
      const value = next();
      opts.before = /^\d+$/u.test(value) ? Number(value) : Date.parse(value);
      if (!Number.isFinite(opts.before)) throw new Error("invalid --before: " + value);
    } else throw new Error("unknown argument: " + arg);
  }
  return opts;
}

// Source imports use ".js" suffixes; map them to the ".ts" file when no ".js" exists.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && (specifier.startsWith(".") || specifier.startsWith("file:")) && context.parentURL?.endsWith(".ts")) {
      const candidate = new URL(specifier, context.parentURL);
      const tsCandidate = new URL(candidate.href.replace(/\.js$/u, ".ts"));
      if (!existsSync(fileURLToPath(candidate)) && existsSync(fileURLToPath(tsCandidate))) {
        return nextResolve(tsCandidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

// mulberry32: small deterministic PRNG so the same seed draws the same sample.
function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

function sampleDir(dir, count, seed, before) {
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".txt"))
    .filter((name) => before === undefined || statSync(join(dir, name)).mtimeMs < before)
    .sort();
  const rng = createRng(seed);
  const pool = [...names];
  const take = Math.min(count, pool.length);
  for (let i = 0; i < take; i += 1) {
    const j = i + Math.floor(rng() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return {
    pool: names.length,
    files: pool.slice(0, take).map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") })),
  };
}

const BASE_VOCAB = ["alpha", "beta", "gamma", "delta", "config", "handler", "result", "value", "index", "token"];

// N distinct lowercase words of 2-4 syllables. The first 10 are BASE_VOCAB, so
// --vocab 10 reproduces the original corpus exactly.
function buildVocab(size, seed) {
  if (size <= BASE_VOCAB.length) return BASE_VOCAB.slice(0, size);
  const rng = createRng(seed ^ 0x2545f491);
  const consonants = "bcdfghjklmnprstvwz";
  const vowels = "aeiou";
  const words = new Set(BASE_VOCAB);
  while (words.size < size) {
    const syllables = 2 + Math.floor(rng() * 3);
    let word = "";
    for (let i = 0; i < syllables; i += 1) {
      word += consonants[Math.floor(rng() * consonants.length)] + vowels[Math.floor(rng() * vowels.length)];
    }
    words.add(word);
  }
  return [...words];
}

// Deterministic public corpus: read-like, search, diff, listing and log outputs.
function syntheticCorpus(count, seed, vocabSize = BASE_VOCAB.length) {
  const rng = createRng(seed ^ 0x5bd1e995);
  const int = (max) => Math.floor(rng() * max);
  const vocab = buildVocab(vocabSize, seed);
  const word = () => vocab[int(vocab.length)];
  const path = () => "src/" + word() + "/" + word() + "-" + int(99) + ".ts";
  const makers = {
    read: (n) => Array.from({ length: n }, (_, i) => "  ".repeat(int(4)) + "const " + word() + i + " = " + word() + "(" + word() + ", " + int(1000) + ");"),
    grep: (n) => Array.from({ length: n }, () => path() + ":" + (1 + int(900)) + ":  " + word() + "." + word() + "(" + word() + ")"),
    diff: (n) => ["diff --git a/" + path() + " b/" + path(), "--- a/x.ts", "+++ b/x.ts", "@@ -1," + n + " +1," + n + " @@",
      ...Array.from({ length: n }, () => [" ", "+", "-"][int(3)] + "  " + word() + "(" + word() + ");")],
    listing: (n) => Array.from({ length: n }, () => path()),
    log: (n) => Array.from({ length: n }, (_, i) => "2026-10-14T12:" + String(i % 60).padStart(2, "0") + ":00Z INFO " + word() + " " + word() + " id=" + int(1e6)),
  };
  const kinds = Object.keys(makers);
  return Array.from({ length: count }, (_, i) => {
    const kind = kinds[i % kinds.length];
    const n = [5, 20, 60, 200, 1500][int(5)];
    return { name: kind + "-synthetic-" + i + ".txt", text: makers[kind](n).join("\n") };
  });
}

// Stored files carry no command. Infer a representative one so the matching
// reducer runs: read-* -> cat, grep-* or path:line: text -> rg, diff text ->
// git diff, path-per-line text -> find, everything else -> generic fallback.
function inferCommand(name, text) {
  if (name.startsWith("read-")) return { family: "read", command: "cat " + name };
  const head = text.slice(0, 20_000);
  if (/^diff --git /mu.test(head)) return { family: "diff", command: "git diff" };
  const sampleLines = head.split("\n").filter((line) => line.trim()).slice(0, 50);
  const share = (pattern) => sampleLines.length ? sampleLines.filter((line) => pattern.test(line)).length / sampleLines.length : 0;
  if (name.startsWith("grep-") || share(/^[^\s:]+:\d+[:-]/u) >= 0.6) return { family: "grep", command: "rg -n pattern" };
  if (name.startsWith("listing-") || share(/^[\w.@~+-]*\/[^\s]*$/u) >= 0.8) return { family: "listing", command: "find . -type f" };
  return { family: "generic", command: "bash -lc stored-output" };
}

const ANSI = new RegExp(String.raw`\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[@-_])`, "gu");

function omittedChars(raw, inline) {
  const kept = new Set(inline.split("\n").map((line) => line.trim()));
  let omitted = 0;
  for (const line of raw.replace(ANSI, "").split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !kept.has(trimmed)) omitted += trimmed.length;
  }
  return omitted;
}

// The needle copies the "path:line:" (or context "path-line-") prefix of the
// line it displaces, so a search reducer's keep filter treats it like that line.
function insertNeedle(text, needle, position) {
  const lines = text.split("\n");
  const index = Math.min(lines.length, Math.floor(lines.length * position));
  const prefix = /^[^\s:]+[:-]\d+[:-]/u.exec(lines[index] ?? "")?.[0] ?? "";
  lines.splice(index, 0, prefix + needle);
  return lines.join("\n");
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value, digits = 1) => Number(value.toFixed(digits));
const pct = (rows, pick) => round(rows.length ? (100 * rows.filter(pick).length) / rows.length : 0, 1);

function summarize(rows) {
  const n = rows.length;
  const compacted = rows.filter((row) => row.compacted);
  const omitted = rows.map((row) => row.omitted);
  const raw = rows.reduce((sum, row) => sum + row.rawChars, 0);
  const saved = rows.reduce((sum, row) => sum + row.saved, 0);
  return {
    files: n,
    compactionRate: round(n ? compacted.length / n : 0, 3),
    meanCharsOmitted: round(n ? omitted.reduce((a, b) => a + b, 0) / n : 0),
    medianCharsOmitted: median(omitted),
    charsSavedTotal: saved,
    rawCharsTotal: raw,
    inlineCharsTotal: rows.reduce((sum, row) => sum + row.inlineChars, 0),
    savedRatio: round(raw ? saved / raw : 0, 4),
    needleRetentionPct: pct(rows, (row) => row.needleKept),
    needleRetentionCompactedPct: pct(compacted, (row) => row.needleKept),
    needleRandomRetentionPct: pct(rows, (row) => row.randomNeedleKept),
  };
}

// A tsc failure with 100 diagnostics: how many survive intact on the failure path?
async function tscDiagnosticsKept(reduce, rules, reduceOpts) {
  const diagnostics = Array.from({ length: 100 }, (_, i) =>
    "src/module" + i + ".ts(" + (i + 1) + ",5): error TS2322: Type 'string' is not assignable to type 'number' in value" + i + ".");
  const result = await reduce({ toolName: "exec", command: "tsc --noEmit", stdout: [...diagnostics, "Found 100 errors in 100 files."].join("\n"), exitCode: 2 }, rules, reduceOpts);
  const inlineLines = new Set(result.inlineText.split("\n"));
  return diagnostics.filter((line) => inlineLines.has(line)).length;
}

const opts = parseArgs(process.argv.slice(2));
const srcUrl = pathToFileURL(opts.src + "/").href;
const { reduceExecutionWithRules } = await import(new URL("core/reduce.ts", srcUrl).href);
const { loadBuiltinRules } = await import(new URL("core/rules.ts", srcUrl).href);
const rules = await loadBuiltinRules();
const reduceOpts = opts.maxInlineChars ? { maxInlineChars: opts.maxInlineChars } : {};

const corpus = opts.synthetic
  ? { pool: opts.sample, files: syntheticCorpus(opts.sample, opts.seed, opts.vocab) }
  : sampleDir(opts.dir, opts.sample, opts.seed, opts.before);
const manifest = corpus.files.map(({ name, text }) => ({ name, sha256: sha(text), bytes: Buffer.byteLength(text) }));
if (opts.manifestOut) writeFileSync(opts.manifestOut, JSON.stringify({ seed: opts.seed, files: manifest }, null, 2) + "\n");

const positionRng = createRng(opts.seed ^ 0x9e3779b9);
const failureHash = createHash("sha256");
const rows = [];
for (const [index, { name, text }] of corpus.files.entries()) {
  const { family, command } = inferCommand(name, text);
  const input = { toolName: "exec", command, stdout: text, exitCode: 0 };
  const result = await reduceExecutionWithRules(input, rules, reduceOpts);
  const needle = "NEEDLE-" + opts.seed + "-" + index;
  const needled = await reduceExecutionWithRules({ ...input, stdout: insertNeedle(text, needle, 0.5) }, rules, reduceOpts);
  const randomNeedle = "NEEDLE-" + opts.seed + "-r" + index;
  const randomNeedled = await reduceExecutionWithRules({ ...input, stdout: insertNeedle(text, randomNeedle, positionRng()) }, rules, reduceOpts);
  const failed = await reduceExecutionWithRules({ ...input, exitCode: 1 }, rules, reduceOpts);
  failureHash.update(name + "\0" + failed.inlineText + "\0");
  const rawChars = result.stats.rawChars;
  const inlineChars = result.stats.reducedChars;
  rows.push({
    family,
    rawChars,
    inlineChars,
    compacted: inlineChars < rawChars,
    saved: Math.max(0, rawChars - inlineChars),
    omitted: omittedChars(text, result.inlineText),
    needleKept: needled.inlineText.includes(needle),
    randomNeedleKept: randomNeedled.inlineText.includes(randomNeedle),
  });
}

const summary = {
  bench: "tokenjuice-fidelity",
  corpus: opts.synthetic ? "synthetic" : "dir",
  seed: opts.seed,
  ...(opts.before === undefined ? {} : { before: new Date(opts.before).toISOString() }),
  ...(opts.maxInlineChars ? { maxInlineChars: opts.maxInlineChars } : {}),
  ...(opts.synthetic && opts.vocab !== BASE_VOCAB.length ? { vocab: opts.vocab } : {}),
  pool: corpus.pool,
  sampleSha: sha(manifest.map((entry) => entry.name + ":" + entry.sha256).join("\n")).slice(0, 16),
  ...summarize(rows),
  failureSha: failureHash.digest("hex").slice(0, 16),
  tscDiagnosticsKept: await tscDiagnosticsKept(reduceExecutionWithRules, rules, reduceOpts),
};
if (opts.byFamily) {
  summary.byFamily = Object.fromEntries(
    [...new Set(rows.map((row) => row.family))].sort().map((family) => [family, summarize(rows.filter((row) => row.family === family))]),
  );
}
process.stdout.write(JSON.stringify(summary) + "\n");
