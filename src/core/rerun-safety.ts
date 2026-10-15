import { getCommandName, getGitSubcommand } from "./command-identity.js";
import { stripLeadingEnvAssignments, unwrapShellRunner } from "./command-match.js";
import { isCompoundShellCommand, stripLeadingCdPrefix, tokenizeCommand } from "./command-shell.js";

/**
 * Decides whether the wrap footer may suggest re-running a command with
 * `--raw`. Only commands that read and print data qualify: cat-like reads,
 * listings, searches, `git diff` and `git show`. Anything else (builds, tests,
 * installs, deploys, scripts, writes) may have side effects, so the footer must
 * not invite a second run. Unknown or ambiguous commands are treated as unsafe.
 */

const CAT_LIKE_READS = new Set(["cat", "head", "tail", "nl", "bat", "batcat", "jq", "wc"]);
const LISTINGS = new Set(["ls", "tree"]);
const SEARCHES = new Set(["grep", "egrep", "fgrep", "ag"]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["diff", "show", "ls-files", "grep"]);

const FIND_SIDE_EFFECT_ACTIONS = new Set([
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
  "-delete",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-fls",
]);
const FD_EXEC_OPTIONS = new Set(["-x", "--exec", "-X", "--exec-batch"]);
const SED_PRINT_SCRIPT = /^(?:\d+|\$)?(?:,\s*(?:\d+|\$))?[pq]$/u;
const SED_SUBSTITUTE_SCRIPT = /^s(.)(?:\^?[^\\\n]*)\1(?:[^\\\n]*)\1[gIp]*$/u;
// Redirection, command substitution and process substitution can write or run anything.
const UNSAFE_SHELL_SYNTAX = /[<>`]|\$\(/u;

/** Returns the argv that would actually run, or null when it cannot be judged safely. */
function getRerunArgv(argv: readonly string[]): string[] | null {
  const direct = stripLeadingEnvAssignments([...argv]);
  if (direct.length === 0) {
    return null;
  }
  const shellBody = unwrapShellRunner({ argv: direct });
  if (shellBody === null) {
    return getCommandName(direct) && isShellName(getCommandName(direct)!) ? null : direct;
  }
  const body = stripLeadingCdPrefix(shellBody);
  if (!body || isCompoundShellCommand(body) || UNSAFE_SHELL_SYNTAX.test(body)) {
    return null;
  }
  const inner = stripLeadingEnvAssignments(tokenizeCommand(body));
  return inner.length > 0 ? inner : null;
}

function isShellName(name: string): boolean {
  return /^(?:ba|z|da|k|mk|a|c|tc|fi)?sh$/u.test(name.replace(/\.exe$/u, ""));
}

function isReadOnlySed(argv: readonly string[]): boolean {
  const scripts: string[] = [];
  const operands: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-n" || arg === "-E" || arg === "-r" || arg === "--quiet" || arg === "--silent") {
      continue;
    }
    if (arg === "-e" || arg === "--expression") {
      index += 1;
      if (index >= argv.length) {
        return false;
      }
      scripts.push(argv[index]!);
      continue;
    }
    if (arg.startsWith("-")) {
      // -i/--in-place edit files, -f reads a script that may write; refuse all other flags.
      return false;
    }
    operands.push(arg);
  }
  if (scripts.length === 0) {
    const script = operands.shift();
    if (script === undefined) {
      return false;
    }
    scripts.push(script);
  }
  return scripts.every((script) => SED_PRINT_SCRIPT.test(script) || SED_SUBSTITUTE_SCRIPT.test(script));
}

function isReadOnlyGit(argv: readonly string[]): boolean {
  const subcommand = getGitSubcommand([...argv]);
  if (!subcommand || !READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return false;
  }
  return argv.every((arg) => (
    // -c can set an external diff or pager command; --output writes a file;
    // --ext-diff and --textconv run configured drivers.
    arg !== "-c"
    && arg !== "--config-env"
    && !arg.startsWith("--config-env=")
    && arg !== "--output"
    && !arg.startsWith("--output=")
    && arg !== "--ext-diff"
    && arg !== "--textconv"
    && arg !== "--open-files-in-pager"
    && !arg.startsWith("--open-files-in-pager=")
    && !/^-O./u.test(arg)
  ));
}

/** True when re-running the command only reads and prints data. */
export function isReadOnlyRerunCommand(argv: readonly string[]): boolean {
  const effective = getRerunArgv(argv);
  if (!effective) {
    return false;
  }
  const name = getCommandName(effective);
  if (!name) {
    return false;
  }
  if (CAT_LIKE_READS.has(name) || LISTINGS.has(name) || SEARCHES.has(name)) {
    return true;
  }
  switch (name) {
    case "sed":
      return isReadOnlySed(effective);
    case "yq":
      return effective.every((arg) => arg !== "-i" && arg !== "--inplace" && !arg.startsWith("--inplace="));
    case "find":
      return effective.every((arg) => !FIND_SIDE_EFFECT_ACTIONS.has(arg));
    case "fd":
    case "fdfind":
      return effective.every((arg) => !FD_EXEC_OPTIONS.has(arg) && !arg.startsWith("--exec=") && !arg.startsWith("--exec-batch="));
    case "rg":
      // --pre runs a preprocessor command for every file.
      return effective.every((arg) => arg !== "--pre" && !arg.startsWith("--pre="));
    case "git":
      return isReadOnlyGit(effective);
    default:
      return false;
  }
}
