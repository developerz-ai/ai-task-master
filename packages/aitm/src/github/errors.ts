// docs/github-integration.md §"Result typing" — never raw stderr; always domain errors.

export class PrNotFound extends Error {
  override readonly name = 'PrNotFound';
}

export class ReviewThreadStale extends Error {
  override readonly name = 'ReviewThreadStale';
}

export class CiFailed extends Error {
  override readonly name = 'CiFailed';
}

export class GhCliMissing extends Error {
  override readonly name = 'GhCliMissing';
}

export class GhAuthRequired extends Error {
  override readonly name = 'GhAuthRequired';
}

export class MergeConflict extends Error {
  override readonly name = 'MergeConflict';
}
