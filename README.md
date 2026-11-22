# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tedinasia/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tedinasia/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats — a
unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool
calls as JSON — and `mend` reads all four to one written specification, finds the lines an edit names even when
the model drifted their whitespace or indentation, and changes every file or none.

Built for the [make.fun bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122): **Build mend, one patch
tool for every AI edit format**.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- The working directory is the root of the tree; every path in a patch is relative to it.
- `PATCH` is the patch file; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints one line per changed path (`A`/`D`/`M`, or `R old -> new` for a move) then `ok: <n> files`.
Exit 1 prints one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`, and writes
nothing. Exit 2 prints a single `error: usage` / `error: no-patch` / `error: format` / `error: parse <N>` line.

## How it works

- **Three matching tiers.** An edit's old lines are found at the first tier where they occur: tier 0 exact,
  tier 1 ignoring trailing spaces and tabs, tier 2 ignoring leading and trailing spaces and tabs (with
  re-indentation of the new lines to the file's own indent). `--strict` tries tier 0 only.
- **Atomic.** Every edit is applied to an in-memory tree; a failed edit changes nothing, later edits still run
  and are reported, and when any edit failed no file is written at all.
- **Faithful to the files.** A changed file keeps its own line break (CRLF or LF) and its final line break;
  context lines are written as the file's own matched lines; created files use LF.
- **Precise errors.** Each failure names the exact code (`no-match`, `ambiguous`, `missing`, `exists`,
  `unsafe`) and the exact path it concerns.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone. Written from scratch to the kit's `SPEC.md`.
- `runner.ts`: the kit's runner (kept as-is). In a trial it reads the checks from the env, runs `main.ts` on
  each one in a fresh directory, and posts the exit code, stdout and files.
- `check.ts`: runs the practice set on your own machine:

```sh
node check.ts <kit>/program/generator/practice.json
```

Practice score: **1000** (100 of 100 checks passed).

## License

MIT — see `LICENSE`.
