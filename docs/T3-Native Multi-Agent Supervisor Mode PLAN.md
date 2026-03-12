# T3-Native Multi-Agent Supervisor Mode V1

## Summary

Add a `supervisor` thread type that can coordinate child T3 threads while keeping orchestration fully T3-native.

Core rules:

- Supervisors and children are first-class T3 threads.
- Child threads are created fresh in V1.
- A supervisor must propose a multi-agent plan before any delegation starts.
- The user must approve that plan.
- Child threads are read-only for normal chat by default, but can be explicitly taken over.

## Goals

- Let a supervisor break work into parallel child tasks.
- Keep execution, history, and inspection inside normal T3 threads.
- Give the user clear control before agent fan-out begins.
- Make review and verification part of the contract, not an afterthought.

## V1 Scope

- New thread roles:
  - `standard`
  - `supervisor`
  - `sub-agent`
- Child threads nested under the supervisor in the sidebar.
- Supervisor plan approval required before delegation.
- Fresh child threads only.
- Concurrency cap per supervisor.
- Child threads inherit supervisor runtime mode.
- Child threads use isolated worktrees for write-capable work.
- Child threads are read-only for normal chat by default.
- Users can inspect children, answer approvals there, and explicitly take over a child.

## Thread Model

Add to thread state:

- `agentRole`
- `parentThreadId`
- `supervisorState`

`supervisorState` should include:

- `maxConcurrentChildren`
- `childModel`
- `lifecycleState`
- `activePlanId`
- `delegations`

Each delegation should include:

- `delegationId`
- `childThreadId`
- `title`
- `prompt`
- `expectedOutput`
- `writeAccess`
- `status`

## Supervisor Lifecycle

- `drafting_plan`
- `awaiting_plan_approval`
- `executing_children`
- `reviewing_children`
- `completed`

## Plan Approval Flow

Before any child thread is launched, the supervisor must propose a structured multi-agent plan.

The plan must include:

- overall objective
- why delegation is needed
- each sub-agent:
  - title
  - task
  - expected output
  - whether it is expected to write or only inspect/analyze
- concurrency strategy:
  - what runs in parallel
  - what depends on earlier outputs
- review strategy:
  - how the supervisor will inspect each child’s work
  - what checks it will run at the end
- completion criteria:
  - what must be true before the supervisor reports success

User approval is required before delegation begins.

## Supervisor Capabilities

V1 should provide:

- supervisor thread creation and configuration
- structured plan approval
- fresh child delegation
- child progress tracking
- final supervisor review after children complete
- child takeover

## Execution Rules

- Child model resolution:
  - supervisor-configured child model, else
  - app default child model, else
  - supervisor model
- No child reuse in V1.
- No delegation before plan approval.
- Review phase is mandatory if the approved plan promised review checks.

## UI

Add support for:

- creating a thread as `standard` or `supervisor`
- configuring `max agents`
- configuring optional `child model`
- showing nested child threads under supervisors
- rendering a supervisor plan approval card
- rendering a supervisor progress card
- disabling normal composer sends in child threads
- a `Take over child` action in child threads

### Supervisor plan card

Show:

- objective
- child task breakdown
- concurrency plan
- final review strategy
- completion criteria

Actions:

- `Approve`
- `Reject`

### Supervisor progress card

Show:

- lifecycle state
- running / blocked / completed / failed counts
- child list with deep links
- review phase status

## Child Thread Rules

By default child threads:

- cannot accept arbitrary user chat
- can still show full history
- can still accept approval and user-input responses
- can be explicitly converted with `Take over child`

## Deferred to V2

- reusable child threads
- blocking wait tools
- ask-once child model prompts
- supervisor steering of existing children
- mixed reuse/new delegation
- Codex-native sub-agent ownership

## Why This Version

This version is safer because:

- delegation requires visible user approval
- supervisor intent is explicitly recorded
- child execution is fresh and isolated
- review is part of the promised workflow
- failure recovery exists through child takeover
- it fits the current T3 architecture better than a more implicit design
