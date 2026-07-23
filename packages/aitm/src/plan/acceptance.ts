// The acceptance check the Planner attaches to a PR group (PlannedGroup.acceptance, persisted as
// PrGroup.acceptance): the command or observable that proves the group done. It travels as DATA on
// the group, but every subagent brief is prose — and the prompt builders render only titles and task
// text — so this module is the one place the check becomes prose, appended to whichever brief the
// agent that must satisfy it (the Coordinator) or judge it (the pre-PR self-review) already reads.
//
// SRP: rendering the check. No I/O, no schema import, no knowledge of who consumes it.

const ACCEPTANCE_HEADING = '## Acceptance check for this PR group';

// The rendered block, or '' when the group carries no check — a plan from before the field existed,
// or state.json written by an older aitm. Empty means every caller emits the exact prompt it did
// before, so a legacy resume is unaffected rather than carrying an empty section.
function acceptanceBlock(acceptance: string | undefined): string {
  const check = acceptance?.trim() ?? '';
  if (check === '') return '';
  return [
    ACCEPTANCE_HEADING,
    '',
    check,
    '',
    'This is the contract for the group: the work is not done until this holds. Demonstrate it — run',
    'the command, observe the behaviour — and never report it as holding on reasoning alone.',
  ].join('\n');
}

// Append the acceptance check to a brief (a role prompt, a task description). Returns the brief
// unchanged when there is no check, so callers can apply it unconditionally.
export function withAcceptanceCheck(brief: string, acceptance: string | undefined): string {
  const block = acceptanceBlock(acceptance);
  return block === '' ? brief : `${brief}\n\n${block}`;
}
