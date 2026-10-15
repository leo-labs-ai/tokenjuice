import { describe, expect, it } from "vitest";

import { isReadOnlyRerunCommand } from "../../src/core/rerun-safety.js";

describe("isReadOnlyRerunCommand", () => {
  it.each([
    [["cat", "big.log"]],
    [["head", "-n", "50", "big.log"]],
    [["sed", "-n", "1,200p", "src/main.ts"]],
    [["jq", ".items", "data.json"]],
    [["ls", "-la"]],
    [["tree", "src"]],
    [["find", ".", "-name", "*.ts"]],
    [["fd", "-e", "ts"]],
    [["rg", "-n", "TODO", "src"]],
    [["grep", "-rn", "TODO", "src"]],
    [["git", "diff", "HEAD~1"]],
    [["git", "-C", "repo", "show", "HEAD"]],
    [["git", "ls-files"]],
    [["git", "grep", "needle"]],
    [["LC_ALL=C", "rg", "needle"]],
    [["bash", "-lc", "git show HEAD --stat"]],
    // A single-quoted literal may hold metacharacters; it stays allowed.
    [["bash", "-lc", "rg -n 'a|b; c > $(d)' src"]],
    [["sed", "s/a/b/g", "file.txt"]],
    [["sed", "-n", "s,a/b,c,p", "file.txt"]],
    [["sed", "-ne", "10,20p", "file.txt"]],
    [["tree", "-L", "2", "src"]],
    [["yq", "-P", ".a", "file.yaml"]],
    [["head", "-50", "big.log"]],
    [["grep", "-A3", "--color=always", "TODO", "src"]],
    [["git", "diff", "--stat", "HEAD~1", "--", "src"]],
  ])("allows a raw re-run for read-only %j", (argv) => {
    expect(isReadOnlyRerunCommand(argv)).toBe(true);
  });

  it.each([
    [["pnpm", "test"]],
    [["npm", "install"]],
    [["make", "deploy"]],
    [["python", "script.py"]],
    [["git", "push"]],
    [["git", "commit", "-m", "x"]],
    [["git", "diff", "--output=changes.patch"]],
    [["git", "-c", "diff.external=./tool", "diff"]],
    [["git", "diff", "--ext-diff"]],
    [["sed", "-i", "s/a/b/", "file.txt"]],
    [["sed", "-n", "w out.txt", "file.txt"]],
    [["sed", "-f", "script.sed", "file.txt"]],
    [["yq", "-i", ".a = 1", "file.yaml"]],
    [["find", ".", "-name", "*.tmp", "-delete"]],
    [["find", ".", "-exec", "rm", "{}", ";"]],
    [["fd", "-x", "rm"]],
    [["rg", "--pre", "./decode", "needle"]],
    [["bash", "-lc", "git diff > out.patch"]],
    [["bash", "-lc", "cat file | tee copy"]],
    [["bash", "-lc", "cat $(make-list)"]],
    [["bash", "-lc", "rg needle; rm -rf build"]],
    [["bash", "script.sh"]],
    [[]],
    // t-0014 review: sed's w command after a substitution still writes a file.
    [["sed", "s/a/b/;w /tmp/p", "input.txt"]],
    // t-0014 review: tree -o writes its listing to a file.
    [["tree", "-o", "report.txt", "."]],
    // t-0014 review: -i inside a bundled flag still edits in place.
    [["yq", "-Pi", ".a = 1", "file.yaml"]],
    [["sed", "s/a/b/w out.txt", "file.txt"]],
    [["sed", "s/a/b/e", "file.txt"]],
    [["sed", "1p;W out.txt", "file.txt"]],
    [["sed", "-ni", "p", "file.txt"]],
    [["sed", "-e", "p", "-e", "r other.txt", "file.txt"]],
    [["tree", "-R", "-H", ".", "-L", "1"]],
    [["yq", "--inplace", ".a = 1", "file.yaml"]],
    [["tail", "-f", "app.log"]],
    [["git", "diff", "--color", "--output=changes.patch"]],
    [["git", "diff", "--out=changes.patch"]],
    [["git", "grep", "-O", "needle"]],
    [["find", ".", "-fprint", "out.txt"]],
    // t-0014 review 5539523750: the raw shell body is checked before any parsing,
    // so a substitution inside a cd prefix is caught.
    [["sh", "-c", 'cd "$(touch /tmp/tokenjuice-rerun-marker; printf .)" && cat input.txt']],
    [["sh", "-c", "cd `touch /tmp/tokenjuice-rerun-marker` && cat input.txt"]],
    [["bash", "-lc", "cat `ls`"]],
    [["bash", "-lc", 'cat "$(make-list)"']],
    [["bash", "-lc", 'cat "$HOME/notes.txt"']],
    // One simple command only: chaining, background jobs and line breaks are refused.
    [["sh", "-c", "cd repo && rg needle"]],
    [["bash", "-lc", "cat a || rm b"]],
    [["bash", "-lc", "cat a & rm b"]],
    [["bash", "-lc", "cat a\nrm b"]],
    [["bash", "-lc", "cat 'unterminated"]],
    // Direct argv: the caller's quoting is unknown, so any metacharacter is refused.
    [["rg", "a|b", "src"]],
    [["cat", "$(rm x)"]],
    // Deny by default: any flag that is not on the command's allow-list.
    [["cat", "--some-new-flag", "file.txt"]],
    [["ls", "-la", "--unknown"]],
    [["rg", "--pre-glob", "*.gz", "needle"]],
    [["jq", "--arg", "x", "1", ".", "data.json"]],
  ])("refuses a raw re-run for %j", (argv) => {
    expect(isReadOnlyRerunCommand(argv)).toBe(false);
  });
});
