import { getCommandName } from "./command-identity.js";
import { stripLeadingEnvAssignments, unwrapShellRunner } from "./command-match.js";
import { isCompoundShellCommand, tokenizeCommand } from "./command-shell.js";

/**
 * Decides whether the wrap footer may suggest re-running a command with
 * `--raw`. The rule is deny-by-default: a command qualifies only when its
 * whole argv matches an explicit allow-list form for a known read-only tool.
 * Every flag must be a known-safe flag for that tool, so unknown, abbreviated,
 * in-place, output-file and script-writing flags all disqualify the command.
 * Anything that does not match is reported as "not retrievable, do not re-run".
 */

interface FlagGrammar {
  /** Single-letter flags without a value; they may be bundled ("-la"). */
  readonly short?: string;
  /** Single-letter flags that need a value, attached ("-n5") or as the next argument. */
  readonly shortValue?: string;
  /** Single-letter flags whose optional value can only be attached ("-U3"). */
  readonly shortAttached?: string;
  /** Long flags without a value. */
  readonly long?: readonly string[];
  /** Long flags that need a value, as "--flag=value" or as the next argument. */
  readonly longValue?: readonly string[];
  /** Long flags whose optional value can only be given as "--flag=value". */
  readonly longOptional?: readonly string[];
  /** Accept the "-<digits>" count shorthand (head -50, grep -3). */
  readonly numericShorthand?: boolean;
}

const CAT: FlagGrammar = {
  short: "AbeEnstTuv",
  long: ["--show-all", "--number-nonblank", "--show-ends", "--number", "--squeeze-blank", "--show-tabs", "--show-nonprinting"],
};
// tail -f/-F never ends, so it is deliberately not on the list.
const HEAD_TAIL: FlagGrammar = {
  short: "qvz",
  shortValue: "nc",
  long: ["--quiet", "--silent", "--verbose", "--zero-terminated"],
  longValue: ["--lines", "--bytes"],
  numericShorthand: true,
};
const NL: FlagGrammar = { short: "p", shortValue: "bdfhilnsvw" };
// bat --pager runs a command, so it is not on the list.
const BAT: FlagGrammar = {
  short: "pnAPu",
  shortValue: "lrH",
  long: ["--plain", "--number", "--show-all", "--no-config"],
  longValue: ["--language", "--line-range", "--highlight-line", "--style", "--color", "--theme", "--wrap", "--tabs", "--terminal-width"],
};
const JQ: FlagGrammar = {
  short: "rjcnsSeaCMR",
  long: [
    "--raw-output", "--join-output", "--compact-output", "--null-input", "--slurp", "--sort-keys", "--exit-status",
    "--ascii-output", "--color-output", "--monochrome-output", "--raw-input", "--tab",
  ],
  longValue: ["--indent"],
};
const WC: FlagGrammar = { short: "clmwL", long: ["--bytes", "--chars", "--lines", "--words", "--max-line-length"] };
const LS: FlagGrammar = {
  short: "1aAbBcCdfFgGhHiklLmnNopqQrRsStuUvxXZ",
  shortValue: "IwT",
  long: [
    "--all", "--almost-all", "--author", "--classify", "--directory", "--dereference", "--full-time",
    "--group-directories-first", "--human-readable", "--si", "--inode", "--literal", "--escape", "--no-group",
    "--numeric-uid-gid", "--recursive", "--reverse", "--size",
  ],
  longValue: ["--ignore", "--hide", "--sort", "--format", "--time", "--time-style", "--width", "--tabsize", "--block-size", "--quoting-style", "--indicator-style"],
  longOptional: ["--color"],
};
// tree -o writes a file and -R writes 00Tree.html into every directory; neither is listed.
const TREE: FlagGrammar = {
  short: "adfiklpsugDFrtvhxACNQSJX",
  shortValue: "LPI",
  long: ["--dirsfirst", "--noreport", "--gitignore", "--du", "--prune", "--matchdirs", "--ignore-case", "--si"],
  longValue: ["--filelimit", "--charset", "--sort"],
};
const GREP: FlagGrammar = {
  short: "EFGPiyvwxclLoqsbHhnTZzraRIU",
  shortValue: "efmABCdD",
  long: [
    "--extended-regexp", "--fixed-strings", "--basic-regexp", "--perl-regexp", "--ignore-case", "--no-ignore-case",
    "--invert-match", "--word-regexp", "--line-regexp", "--count", "--files-with-matches", "--files-without-match",
    "--only-matching", "--quiet", "--silent", "--no-messages", "--byte-offset", "--with-filename", "--no-filename",
    "--line-number", "--initial-tab", "--null", "--null-data", "--text", "--recursive", "--dereference-recursive",
  ],
  longValue: [
    "--regexp", "--file", "--max-count", "--context", "--before-context", "--after-context", "--include", "--exclude",
    "--exclude-from", "--exclude-dir", "--binary-files", "--label", "--devices", "--directories", "--group-separator",
  ],
  longOptional: ["--color", "--colour"],
  numericShorthand: true,
};
// ag --pager runs a command, so it is not on the list.
const AG: FlagGrammar = {
  short: "ilLcvQSswUuafHn0",
  shortValue: "ABCGgm",
  long: [
    "--literal", "--ignore-case", "--smart-case", "--case-sensitive", "--count", "--files-with-matches",
    "--files-without-matches", "--hidden", "--unrestricted", "--nocolor", "--nogroup", "--noheading", "--vimgrep",
    "--column", "--word-regexp", "--invert-match", "--follow", "--search-zip", "--only-matching", "--filename", "--nofilename",
  ],
  longValue: ["--ignore", "--file-search-regex", "--depth", "--max-count"],
  longOptional: ["--context", "--after", "--before"],
};
// rg --pre/--pre-glob run a preprocessor command for every file; neither is listed.
const RG: FlagGrammar = {
  short: "iIsSFwxvclLoqHnNuUaz0pP",
  shortValue: "egtTmABCMjEfr",
  long: [
    "--hidden", "--no-ignore", "--no-ignore-vcs", "--files", "--files-with-matches", "--files-without-match", "--count",
    "--count-matches", "--fixed-strings", "--ignore-case", "--smart-case", "--case-sensitive", "--line-number",
    "--no-line-number", "--no-heading", "--heading", "--json", "--vimgrep", "--multiline", "--multiline-dotall",
    "--follow", "--word-regexp", "--line-regexp", "--invert-match", "--only-matching", "--no-filename",
    "--with-filename", "--stats", "--column", "--trim", "--pcre2", "--null", "--unrestricted", "--no-messages",
    "--type-list", "--search-zip", "--text", "--pretty", "--sort-files", "--byte-offset", "--passthru", "--crlf",
    "--no-config", "--quiet",
  ],
  longValue: [
    "--glob", "--iglob", "--type", "--type-not", "--max-count", "--max-depth", "--context", "--before-context",
    "--after-context", "--color", "--colors", "--sort", "--sortr", "--regexp", "--replace", "--max-columns",
    "--threads", "--encoding", "--file", "--max-filesize", "--context-separator", "--path-separator", "--engine",
  ],
};
// fd -x/-X/--exec/--exec-batch run commands; none is listed.
const FD: FlagGrammar = {
  short: "HIuisgFapL0l1q",
  shortValue: "etdEcjS",
  long: [
    "--hidden", "--no-ignore", "--no-ignore-vcs", "--unrestricted", "--case-sensitive", "--ignore-case", "--glob",
    "--regex", "--fixed-strings", "--absolute-path", "--full-path", "--follow", "--print0", "--list-details",
    "--quiet", "--show-errors", "--one-file-system", "--prune", "--strip-cwd-prefix",
  ],
  longValue: [
    "--extension", "--type", "--max-depth", "--min-depth", "--exact-depth", "--exclude", "--color", "--threads",
    "--size", "--changed-within", "--changed-before", "--search-path", "--max-results",
  ],
};
// yq -i/--inplace edits files; bundles such as -Pi fail because "i" is not listed.
const YQ: FlagGrammar = {
  short: "PCMNre",
  shortValue: "pI",
  long: ["--prettyPrint", "--colors", "--no-colors", "--unwrapScalar", "--exit-status", "--no-doc", "--null-input"],
  longValue: ["--input-format", "--indent"],
};

// git: -c/--config-env, --output, --ext-diff, --textconv and -O (open in pager) are not listed.
const GIT_GLOBAL_FLAGS = new Set(["--no-pager", "--no-optional-locks"]);
const GIT_DIFF_SHOW: FlagGrammar = {
  short: "puszRwbaW",
  shortValue: "SG",
  shortAttached: "UMCB",
  long: [
    "--cached", "--staged", "--merge-base", "--no-index", "--name-only", "--name-status", "--numstat", "--shortstat",
    "--summary", "--compact-summary", "--patch", "--no-patch", "--patch-with-stat", "--raw", "--no-color",
    "--no-ext-diff", "--no-textconv", "--ignore-all-space", "--ignore-space-change", "--ignore-space-at-eol",
    "--ignore-blank-lines", "--ignore-cr-at-eol", "--minimal", "--histogram", "--patience", "--full-index",
    "--binary", "--no-renames", "--exit-code", "--quiet", "--check", "--text", "--function-context", "--oneline",
    "--no-abbrev", "--abbrev-commit", "--no-abbrev-commit", "--no-notes", "--first-parent",
  ],
  longValue: ["--unified", "--diff-filter", "--diff-algorithm"],
  longOptional: [
    "--stat", "--dirstat", "--color", "--word-diff", "--color-words", "--color-moved", "--abbrev", "--find-renames",
    "--find-copies", "--relative", "--submodule", "--ignore-submodules", "--pretty", "--format",
  ],
};
const GIT_LS_FILES: FlagGrammar = {
  short: "cdmoiskutvfz",
  shortValue: "xX",
  long: [
    "--cached", "--deleted", "--modified", "--others", "--ignored", "--stage", "--killed", "--unmerged", "--directory",
    "--no-empty-directory", "--exclude-standard", "--full-name", "--error-unmatch", "--recurse-submodules", "--eol",
    "--deduplicate", "--sparse",
  ],
  longValue: ["--exclude", "--exclude-from", "--exclude-per-directory", "--with-tree", "--format"],
  longOptional: ["--abbrev"],
};
const GIT_GREP: FlagGrammar = {
  short: "inlLvwchHEFGPoqzIaWp",
  shortValue: "eABCfm",
  long: [
    "--cached", "--untracked", "--no-index", "--ignore-case", "--line-number", "--count", "--files-with-matches",
    "--files-without-match", "--name-only", "--word-regexp", "--invert-match", "--extended-regexp", "--fixed-strings",
    "--perl-regexp", "--basic-regexp", "--break", "--heading", "--show-function", "--function-context", "--column",
    "--recurse-submodules", "--full-name", "--null", "--quiet", "--all-match", "--only-matching", "--text", "--no-color",
  ],
  longValue: ["--max-depth", "--context", "--before-context", "--after-context", "--threads", "--max-count"],
  longOptional: ["--color"],
};
const GIT_SUBCOMMANDS = new Map<string, FlagGrammar>([
  ["diff", GIT_DIFF_SHOW],
  ["show", GIT_DIFF_SHOW],
  ["ls-files", GIT_LS_FILES],
  ["grep", GIT_GREP],
]);

const COMMAND_GRAMMARS = new Map<string, FlagGrammar>([
  ["cat", CAT],
  ["head", HEAD_TAIL],
  ["tail", HEAD_TAIL],
  ["nl", NL],
  ["bat", BAT],
  ["batcat", BAT],
  ["jq", JQ],
  ["wc", WC],
  ["ls", LS],
  ["tree", TREE],
  ["grep", GREP],
  ["egrep", GREP],
  ["fgrep", GREP],
  ["ag", AG],
  ["rg", RG],
  ["fd", FD],
  ["fdfind", FD],
  ["yq", YQ],
]);

// find: only tests and stdout actions. -exec, -execdir, -ok, -okdir, -delete,
// -fprint*, -fls and every other primary are not listed.
const FIND_PRIMARIES = new Set([
  "!", "(", ")", ",", "-not", "-a", "-and", "-o", "-or", "-print", "-print0", "-ls", "-prune", "-quit", "-true",
  "-false", "-empty", "-readable", "-writable", "-executable", "-nouser", "-nogroup", "-follow", "-xdev", "-mount",
  "-depth", "-L", "-P", "-H",
]);
const FIND_PRIMARIES_WITH_VALUE = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-lname", "-ilname", "-regex", "-iregex",
  "-regextype", "-type", "-xtype", "-maxdepth", "-mindepth", "-mtime", "-mmin", "-atime", "-amin", "-ctime", "-cmin",
  "-newer", "-anewer", "-cnewer", "-size", "-user", "-group", "-uid", "-gid", "-perm", "-links", "-samefile", "-inum",
  "-fstype", "-printf",
]);

// sed options: -n -E -r -z -s -u and -e SCRIPT. -i (in-place), -f (script file)
// and every other option are refused, including inside bundles such as -ni.
const SED_SHORT_FLAGS = "nErzsu";
const SED_LONG_FLAGS = new Set(["--quiet", "--silent", "--regexp-extended", "--null-data", "--separate", "--unbuffered", "--posix"]);
const SED_ADDRESS = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?/u;
const SED_SUBSTITUTE_FLAGS = /^(?:[gpiI]|[1-9]\d*)*$/u;

// Shell metacharacters: substitution, expansion, chaining, pipes, background
// jobs, redirection, subshells, escapes, comments and line breaks. Any of them
// outside a single-quoted literal means the command is not one simple command.
const SHELL_METACHARACTERS = /[$`;&|<>()\\#\n\r]/u;

/**
 * True when every option in args is on the grammar's allow-list. Operands are
 * accepted. "--" ends option parsing. Any unknown flag returns false.
 */
function matchesFlagGrammar(args: readonly string[], grammar: FlagGrammar): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") {
      return true;
    }
    if (arg === "-" || !arg.startsWith("-")) {
      continue;
    }
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (grammar.longValue?.includes(name)) {
        if (equals === -1) {
          index += 1;
          if (index >= args.length) {
            return false;
          }
        }
        continue;
      }
      if (grammar.longOptional?.includes(name) || (equals === -1 && grammar.long?.includes(name))) {
        continue;
      }
      return false;
    }
    if (grammar.numericShorthand && /^-\d+$/u.test(arg)) {
      continue;
    }
    let needsNextValue = false;
    for (let position = 1; position < arg.length; position += 1) {
      const letter = arg[position]!;
      if (grammar.short?.includes(letter)) {
        continue;
      }
      if (grammar.shortAttached?.includes(letter)) {
        break;
      }
      if (grammar.shortValue?.includes(letter)) {
        needsNextValue = position === arg.length - 1;
        break;
      }
      return false;
    }
    if (needsNextValue) {
      index += 1;
      if (index >= args.length) {
        return false;
      }
    }
  }
  return true;
}

/**
 * True when text contains a shell metacharacter outside a single-quoted
 * literal, or an unterminated quote. Double quotes do not protect anything:
 * the shell still expands $ and backticks inside them.
 */
function hasUnquotedShellSyntax(text: string): boolean {
  let quote: "'" | '"' | null = null;
  for (const character of text) {
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === "'" && quote === null) {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (SHELL_METACHARACTERS.test(character)) {
      return true;
    }
  }
  return quote !== null;
}

/**
 * Returns the argv that would actually run, or null when it cannot be judged
 * safely. The rule is: one simple command with no shell metacharacters. A
 * shell body (sh -c BODY) is checked as the raw, unmodified string FIRST,
 * before any parsing, so nothing (for example a cd prefix) is stripped
 * before the check. Direct argv tokens are checked too, because the quoting
 * the caller used is unknown.
 */
function getRerunArgv(argv: readonly string[]): string[] | null {
  const direct = stripLeadingEnvAssignments([...argv]);
  if (direct.length === 0) {
    return null;
  }
  const shellBody = unwrapShellRunner({ argv: direct });
  if (shellBody === null) {
    const name = getCommandName(direct);
    if (!name || isShellName(name) || argv.some((token) => SHELL_METACHARACTERS.test(token))) {
      return null;
    }
    return direct;
  }
  const bodyIndex = argv.findIndex((token) => token.trim() === shellBody);
  if (
    hasUnquotedShellSyntax(shellBody)
    || argv.some((token, index) => index !== bodyIndex && SHELL_METACHARACTERS.test(token))
    || isCompoundShellCommand(shellBody)
  ) {
    return null;
  }
  const inner = stripLeadingEnvAssignments(tokenizeCommand(shellBody));
  return inner.length > 0 ? inner : null;
}

function isShellName(name: string): boolean {
  return /^(?:ba|z|da|k|mk|a|c|tc|fi)?sh$/u.test(name.replace(/\.exe$/u, ""));
}

/** Returns the index just after the closing delimiter of one s/// field, or -1. */
function skipSedField(command: string, start: number, delimiter: string): number {
  for (let position = start; position < command.length; position += 1) {
    const character = command[position];
    if (character === "\\") {
      position += 1;
      continue;
    }
    if (character === delimiter) {
      return position + 1;
    }
  }
  return -1;
}

/**
 * A sed script is read-only only when it is one command: an optional line
 * address followed by p, d or q, or one s/// whose flags are only g, p, i, I or
 * a number. Any second command (";w file", newline), and the w, W, e, r and R
 * commands or flags, make it unsafe.
 */
function isReadOnlySedScript(script: string): boolean {
  if (script.includes("\n")) {
    return false;
  }
  const command = script.slice(SED_ADDRESS.exec(script)![0].length);
  if (command === "p" || command === "d" || command === "q") {
    return true;
  }
  if (command[0] !== "s" || command.length < 2) {
    return false;
  }
  const delimiter = command[1]!;
  if (delimiter === "\\" || /\s/u.test(delimiter)) {
    return false;
  }
  const afterPattern = skipSedField(command, 2, delimiter);
  const afterReplacement = afterPattern === -1 ? -1 : skipSedField(command, afterPattern, delimiter);
  return afterReplacement !== -1 && SED_SUBSTITUTE_FLAGS.test(command.slice(afterReplacement));
}

function isReadOnlySed(args: readonly string[]): boolean {
  const scripts: string[] = [];
  const operands: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith("--")) {
      if (SED_LONG_FLAGS.has(arg)) {
        continue;
      }
      if (arg.startsWith("--expression=")) {
        scripts.push(arg.slice("--expression=".length));
        continue;
      }
      if (arg !== "--expression" || index + 1 >= args.length) {
        return false;
      }
      index += 1;
      scripts.push(args[index]!);
      continue;
    }
    for (let position = 1; position < arg.length; position += 1) {
      const letter = arg[position]!;
      if (SED_SHORT_FLAGS.includes(letter)) {
        continue;
      }
      if (letter !== "e") {
        return false;
      }
      const attached = arg.slice(position + 1);
      if (attached) {
        scripts.push(attached);
      } else {
        index += 1;
        if (index >= args.length) {
          return false;
        }
        scripts.push(args[index]!);
      }
      break;
    }
  }
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) {
      return false;
    }
    scripts.push(script);
  }
  return scripts.every(isReadOnlySedScript);
}

function isReadOnlyFind(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (FIND_PRIMARIES.has(arg)) {
      continue;
    }
    if (FIND_PRIMARIES_WITH_VALUE.has(arg)) {
      index += 1;
      if (index >= args.length) {
        return false;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return false;
    }
  }
  return true;
}

function isReadOnlyGit(args: readonly string[]): boolean {
  let index = 0;
  while (index < args.length && args[index]!.startsWith("-")) {
    const arg = args[index]!;
    if (arg === "-C") {
      index += 2;
      continue;
    }
    if (!GIT_GLOBAL_FLAGS.has(arg)) {
      return false;
    }
    index += 1;
  }
  const grammar = index < args.length ? GIT_SUBCOMMANDS.get(args[index]!) : undefined;
  return grammar !== undefined && matchesFlagGrammar(args.slice(index + 1), grammar);
}

/** True only when the argv matches an allow-list form that only reads and prints data. */
export function isReadOnlyRerunCommand(argv: readonly string[]): boolean {
  const effective = getRerunArgv(argv);
  if (!effective) {
    return false;
  }
  const name = getCommandName(effective);
  if (!name) {
    return false;
  }
  const args = effective.slice(1);
  switch (name) {
    case "sed":
      return isReadOnlySed(args);
    case "find":
      return isReadOnlyFind(args);
    case "git":
      return isReadOnlyGit(args);
    default: {
      const grammar = COMMAND_GRAMMARS.get(name);
      return grammar !== undefined && matchesFlagGrammar(args, grammar);
    }
  }
}
