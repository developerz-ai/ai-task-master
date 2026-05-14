// docs/github-integration.md — JSON shapes returned by `gh` (parsed through Zod).

import { z } from 'zod';

export const PrStateSchema = z.enum(['OPEN', 'CLOSED', 'MERGED']);
export type PrState = z.infer<typeof PrStateSchema>;

export const PullRequestSchema = z.object({
  number: z.number().int().positive(),
  state: PrStateSchema,
  url: z.string().url(),
  headRefName: z.string(),
  baseRefName: z.string(),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const CheckStatusSchema = z.enum(['pending', 'success', 'failure', 'cancelled', 'skipped']);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const ReviewCommentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: z.string(),
});
export type ReviewComment = z.infer<typeof ReviewCommentSchema>;

export const ReviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  path: z.string().nullable(),
  comments: z.array(ReviewCommentSchema),
});
export type ReviewThread = z.infer<typeof ReviewThreadSchema>;
