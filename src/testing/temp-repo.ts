// Shared test helper: spin up a throwaway git repo in a tempdir.
// Used by *.test.ts (unit) for filesystem-touching cases AND by test/integration/*.test.ts.
// docs/runtime.md §Testing — integration tests run against real temp git repos.

export type TempRepo = {
  path: string;
  cleanup: () => Promise<void>;
};

export async function makeTempRepo(_opts?: { withClaudeMd?: boolean }): Promise<TempRepo> {
  throw new Error('not implemented');
}
