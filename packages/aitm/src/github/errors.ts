// docs/github-integration.md §"Result typing" — a non-zero gh/git exit throws a typed error, never a
// bare Error carrying raw stderr. GhCommandFailed is the generic case (command + exitCode + stderr as
// fields); CiFailed (poll timeout), MergeConflict, and GhCliMissing (gh absent) are the specific
// reasons a caller branches on. Expected non-results are NOT errors: no PR for a branch returns null,
// and gh's auth state is a { ok } result — neither throws.

export class CiFailed extends Error {
  override readonly name = 'CiFailed';
}

export class GhCliMissing extends Error {
  override readonly name = 'GhCliMissing';
}

export class MergeConflict extends Error {
  override readonly name = 'MergeConflict';
}

// A gh subprocess — or the client's one plain-`git` call (`git rev-parse` in currentBranch) — exited
// non-zero for a reason no caller branches on. Carries the command label, its exit code, and stderr
// as fields so the failure is inspectable by type instead of every throw site re-formatting
// `<cmd> failed: <stderr>` into an opaque Error. `message` keeps that exact wording so an operator
// (and the existing message assertions) read the same line.
export class GhCommandFailed extends Error {
  override readonly name = 'GhCommandFailed';
  readonly command: string;
  readonly exitCode: number;
  readonly stderr: string;
  constructor(command: string, result: { stderr: string; stdout: string; exitCode: number }) {
    const detail = result.stderr.trim() || result.stdout.trim();
    super(`${command} failed: ${detail}`);
    this.command = command;
    this.exitCode = result.exitCode;
    this.stderr = result.stderr;
  }
}
