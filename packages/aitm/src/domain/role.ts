// The four subagent roles. Shared leaf type: credentials maps role → capability tier, mcp/observability
// key their tables by it, and the orchestrator addresses subagents by it — so the identity lives here,
// below all of them, rather than in credentials where it would pull mcp → credentials into a cycle.

export type Role = 'planner' | 'worker' | 'reviewer' | 'orchestrator';
