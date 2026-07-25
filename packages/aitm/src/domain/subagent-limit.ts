// How many subagents one lead may have working at once — the single fan-out knob.
//
// Every phase that fans out (the scout survey's wave, the Worker's editor leaves, and any reviewer
// fan-out that follows) is one lead deciding how much help it needs. That decision is the agent's:
// the lead sizes its own team from the work in front of it, and one subagent is a legitimate answer.
// This is only the ceiling on how many of them run CONCURRENTLY, so a lead that overreaches queues
// instead of opening an unbounded burst of provider calls.
//
// One knob rather than one per role: an operator throttling a rate-limited endpoint means "fewer
// agents at once", not "fewer editors but the same scouts". Overridable per project/global through
// the `subagentLimit` config key.
//
// 10 by default: 1 main agent + up to 10 subagents. High enough that the lead's judgment is what
// bounds a wave in practice rather than this number, low enough to stay inside ordinary provider
// concurrency limits.
export const SUBAGENT_LIMIT_DEFAULT = 10;
