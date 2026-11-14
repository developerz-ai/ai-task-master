# Plans

Execution plans written by `/planx` (`.claude/commands/planx.md`) for another AI to implement. Plan
only, no code.

The tree currently holds no plan documents. The earlier internal plans (bug hunts, audit
remediation, improvement plans and their trackers) were removed from the public tree under #384,
because they were the team's working documents rather than user documentation. Git history is
untouched. Where a source comment still mentions a slice or a numbered step from one of them, the
comment itself carries the reasoning that matters.

## Layout

```
docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/
├── overview.md      # the map: goal, context, slices in order, done-when, risks
├── 01-<aspect>.md   # one separable slice
├── 02-<aspect>.md
└── status.yml       # live tracker: status / percent / current_focus / slices
```

- `<1NN>` is a per-day counter starting at `101`. The slug is kebab-case, five words at most.
- Slices are separable so they can be built in parallel. Never a single `plan.md`.
- `status.yml` is the only tracker; the `.md` slices stay reference maps.
- Tracker fields name roles, never people, and no file carries a home directory or a machine's
  workspace layout. This tree is public.
