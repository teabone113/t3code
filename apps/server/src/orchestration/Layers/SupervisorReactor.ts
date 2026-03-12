import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type SupervisorDelegation,
  type SupervisorDelegationStatus,
  type SupervisorThreadState,
} from "@t3tools/contracts";
import {
  buildSupervisorExecutionPlanPrompt,
  buildSupervisorReviewPrompt,
  parseSupervisorPlan,
} from "@t3tools/shared/supervisor";
import { Effect, Exit, Layer, Queue, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { SupervisorReactor, type SupervisorReactorShape } from "../Services/SupervisorReactor.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.makeUnsafe(`server:${tag}:${crypto.randomUUID()}`);

const newMessageId = (): MessageId => MessageId.makeUnsafe(crypto.randomUUID());
const newThreadId = (): ThreadId => ThreadId.makeUnsafe(crypto.randomUUID());

type SupervisorRelevantEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.supervisor-plan-approved"
      | "thread.supervisor-plan-generation-requested"
      | "thread.supervisor-plan-rejected"
      | "thread.multi-agent-configured"
      | "thread.session-set"
      | "thread.turn-diff-completed"
      | "thread.child-taken-over";
  }
>;

function asDeepComparable(value: unknown): string {
  return JSON.stringify(value);
}

function isSupervisorThread(thread: OrchestrationThread): boolean {
  return thread.agentRole === "supervisor" && thread.supervisorState !== null;
}

function deriveDelegationStatus(thread: OrchestrationThread | undefined): SupervisorDelegationStatus {
  if (!thread) return "queued";
  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return "failed";
  }
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "running";
  }
  if (thread.latestTurn?.state === "completed") {
    return "completed";
  }
  return "queued";
}

function buildChildSummary(thread: OrchestrationThread | undefined): string {
  if (!thread) return "Child thread missing from read model.";
  const assistantMessages = thread.messages.filter((message) => message.role === "assistant");
  const latestAssistant = assistantMessages.at(-1)?.text?.trim();
  const latestActivity = thread.activities.at(-1)?.summary?.trim();
  const checkpointSummary =
    thread.checkpoints.length > 0
      ? `Latest diff: ${thread.checkpoints.at(-1)?.files.length ?? 0} changed file(s).`
      : null;
  return [latestAssistant, latestActivity, checkpointSummary]
    .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    .join("\n\n");
}

function findLatestPlanForTurn(
  thread: OrchestrationThread,
  turnId: string | null | undefined,
) {
  if (!turnId) {
    return null;
  }
  return [...thread.proposedPlans]
    .filter((plan) => plan.turnId === turnId)
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1) ?? null;
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const git = yield* GitCore;

  const resolveReadModel = orchestrationEngine.getReadModel;

  const resolveThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const readModel = yield* resolveReadModel();
      return readModel.threads.find((thread) => thread.id === threadId);
    });

  const resolveSupervisorThreads = () =>
    Effect.gen(function* () {
      const readModel = yield* resolveReadModel();
      return readModel.threads.filter(isSupervisorThread);
    });

  const setSupervisorState = (
    threadId: ThreadId,
    updater: (thread: OrchestrationThread) => SupervisorThreadState | null,
  ) =>
    Effect.gen(function* () {
      const thread = yield* resolveThread(threadId);
      if (!thread?.supervisorState) {
        return;
      }
      const nextState = updater(thread);
      if (!nextState) {
        return;
      }
      if (asDeepComparable(nextState) === asDeepComparable(thread.supervisorState)) {
        return;
      }
      yield* orchestrationEngine.dispatch({
        type: "thread.multi-agent.configure",
        commandId: serverCommandId("supervisor-configure"),
        threadId,
        supervisorState: nextState,
        createdAt: new Date().toISOString(),
      });
    });

  const resolveBaseBranch = (cwd: string, fallback: string | null) =>
    Effect.gen(function* () {
      if (fallback) return fallback;
      const branches = yield* git.listBranches({ cwd });
      return branches.branches.find((branch) => branch.current)?.name ??
        branches.branches.find((branch) => branch.isDefault)?.name ??
        "main";
    }).pipe(Effect.orDie);

  const launchDelegation = (
    supervisor: OrchestrationThread,
    delegation: SupervisorDelegation,
  ) =>
    Effect.gen(function* () {
      if (!supervisor.supervisorState) {
        return;
      }
      const readModel = yield* resolveReadModel();
      const project = readModel.projects.find((entry) => entry.id === supervisor.projectId);
      if (!project) {
        return;
      }

      let branch: string | null = supervisor.branch;
      let worktreePath: string | null = supervisor.worktreePath;
      if (delegation.writeAccess) {
        const baseBranch = yield* resolveBaseBranch(project.workspaceRoot, supervisor.branch);
        const newBranch = `t3code/supervisor-${supervisor.id.slice(0, 8)}-${crypto.randomUUID().slice(0, 6)}`;
        const worktree = yield* git.createWorktree({
          cwd: project.workspaceRoot,
          branch: baseBranch,
          newBranch,
          path: null,
        });
        branch = worktree.worktree.branch;
        worktreePath = worktree.worktree.path;
      }

      const childModel = supervisor.supervisorState.childModel ?? supervisor.model;
      const createdAt = new Date().toISOString();
      yield* orchestrationEngine.dispatch({
        type: "thread.create",
        commandId: serverCommandId("supervisor-child-create"),
        threadId: delegation.childThreadId,
        projectId: supervisor.projectId,
        title: delegation.title,
        model: childModel,
        runtimeMode: supervisor.runtimeMode,
        interactionMode: "default",
        agentRole: "sub-agent",
        parentThreadId: supervisor.id,
        supervisorState: null,
        branch,
        worktreePath,
        createdAt,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("supervisor-child-start"),
        threadId: delegation.childThreadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: delegation.prompt,
          attachments: [],
        },
        model: childModel,
        runtimeMode: supervisor.runtimeMode,
        interactionMode: "default",
        createdAt,
      });
    }).pipe(Effect.orDie);

  const requestExecutionPlanGeneration = (input: {
    readonly threadId: ThreadId;
    readonly sourcePlanId: string;
  }) =>
    Effect.gen(function* () {
      const supervisor = yield* resolveThread(input.threadId);
      if (!supervisor?.supervisorState) {
        return;
      }
      const sourcePlan = supervisor.proposedPlans.find((plan) => plan.id === input.sourcePlanId);
      if (!sourcePlan) {
        return;
      }

      yield* setSupervisorState(supervisor.id, (thread) =>
        thread.supervisorState
          ? {
              ...thread.supervisorState,
              lifecycleState: "structuring_execution_plan",
              sourcePlanId: input.sourcePlanId,
              activePlanId: null,
              structuringError: null,
              delegations: [],
            }
          : null,
      );

      const refreshedSupervisor = yield* resolveThread(supervisor.id);
      if (!refreshedSupervisor?.supervisorState) {
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("supervisor-execution-plan-start"),
        threadId: refreshedSupervisor.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildSupervisorExecutionPlanPrompt({
            sourcePlanMarkdown: sourcePlan.planMarkdown,
            maxConcurrentChildren: refreshedSupervisor.supervisorState.maxConcurrentChildren,
            childModel: refreshedSupervisor.supervisorState.childModel,
          }),
          attachments: [],
        },
        model: refreshedSupervisor.model,
        runtimeMode: refreshedSupervisor.runtimeMode,
        interactionMode: "plan",
        createdAt: new Date().toISOString(),
      });
    }).pipe(Effect.orDie);

  const maybeAdvanceDraftingSupervisor = (supervisorThreadId: ThreadId) =>
    Effect.gen(function* () {
      const supervisor = yield* resolveThread(supervisorThreadId);
      if (
        !supervisor?.supervisorState ||
        supervisor.supervisorState.lifecycleState !== "drafting_plan" ||
        supervisor.latestTurn?.state !== "completed" ||
        supervisor.session?.status !== "ready"
      ) {
        return;
      }

      const latestPlan = findLatestPlanForTurn(supervisor, supervisor.latestTurn.turnId);
      if (!latestPlan) {
        return;
      }
      if (
        supervisor.supervisorState.sourcePlanId === latestPlan.id ||
        supervisor.supervisorState.activePlanId === latestPlan.id
      ) {
        return;
      }

      if (supervisor.interactionMode === "agent-plan") {
        const parsedPlan = parseSupervisorPlan(latestPlan.planMarkdown);
        if (!parsedPlan) {
          yield* setSupervisorState(supervisor.id, (thread) =>
            thread.supervisorState
              ? {
                  ...thread.supervisorState,
                  sourcePlanId: latestPlan.id,
                  activePlanId: null,
                  structuringError:
                    "Supervisor did not return a valid executable multi-agent plan. Retry generation or revise the source plan.",
                  delegations: [],
                }
              : null,
          );
          return;
        }

        yield* setSupervisorState(supervisor.id, (thread) =>
          thread.supervisorState
            ? {
                ...thread.supervisorState,
                sourcePlanId: latestPlan.id,
                activePlanId: latestPlan.id,
                lifecycleState: "awaiting_plan_approval",
                structuringError: null,
                delegations: [],
              }
            : null,
        );
        return;
      }

      yield* orchestrationEngine.dispatch({
        type: "thread.supervisor-plan.generate",
        commandId: serverCommandId("supervisor-execution-plan-request"),
        threadId: supervisor.id,
        sourcePlanId: latestPlan.id,
        createdAt: new Date().toISOString(),
      });
    }).pipe(Effect.orDie);

  const maybeFinalizeExecutionPlan = (supervisorThreadId: ThreadId) =>
    Effect.gen(function* () {
      const supervisor = yield* resolveThread(supervisorThreadId);
      if (
        !supervisor?.supervisorState ||
        supervisor.supervisorState.lifecycleState !== "structuring_execution_plan" ||
        supervisor.latestTurn?.state !== "completed" ||
        supervisor.session?.status !== "ready"
      ) {
        return;
      }

      const executionPlan = findLatestPlanForTurn(supervisor, supervisor.latestTurn.turnId);
      const parsedExecutionPlan = executionPlan
        ? parseSupervisorPlan(executionPlan.planMarkdown)
        : null;

      if (!executionPlan || !parsedExecutionPlan) {
        yield* setSupervisorState(supervisor.id, (thread) =>
          thread.supervisorState
            ? {
                ...thread.supervisorState,
                lifecycleState: "drafting_plan",
                activePlanId: null,
                structuringError:
                  "Supervisor did not return a valid executable multi-agent plan. Retry generation or ask it to revise the human plan.",
                delegations: [],
              }
            : null,
        );
        return;
      }

      yield* setSupervisorState(supervisor.id, (thread) =>
        thread.supervisorState
          ? {
              ...thread.supervisorState,
              lifecycleState: "awaiting_plan_approval",
              activePlanId: executionPlan.id,
              structuringError: null,
            }
          : null,
      );
    }).pipe(Effect.orDie);

  const maybeStartSupervisorReview = (supervisorThreadId: ThreadId) =>
    Effect.gen(function* () {
      const supervisor = yield* resolveThread(supervisorThreadId);
      if (
        !supervisor?.supervisorState ||
        supervisor.supervisorState.lifecycleState !== "executing_children"
      ) {
        return;
      }
    const { delegations } = supervisor.supervisorState;
    if (delegations.length === 0) {
      return;
    }
    if (delegations.some((entry) => entry.status === "queued" || entry.status === "running")) {
      return;
    }
    const activePlan = supervisor.proposedPlans.find(
      (plan) => plan.id === supervisor.supervisorState?.activePlanId,
    );
    if (!activePlan) {
      return;
    }
    const parsedPlan = parseSupervisorPlan(activePlan.planMarkdown);
    if (!parsedPlan) {
      return;
    }

    yield* setSupervisorState(supervisor.id, (thread) =>
      thread.supervisorState
        ? { ...thread.supervisorState, lifecycleState: "reviewing_children" }
        : null,
    );

    const updatedReadModel = yield* resolveReadModel();
    const childSummaries = delegations.map((delegation) => {
      const childThread = updatedReadModel.threads.find(
        (thread) => thread.id === delegation.childThreadId,
      );
      return {
        title: delegation.title,
        status: delegation.status,
        summary: buildChildSummary(childThread),
      };
    });

    yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: serverCommandId("supervisor-review-start"),
        threadId: supervisor.id,
        message: {
          messageId: newMessageId(),
          role: "user",
          text: buildSupervisorReviewPrompt({
            plan: parsedPlan,
            childSummaries,
          }),
          attachments: [],
        },
        model: supervisor.model,
        runtimeMode: supervisor.runtimeMode,
        interactionMode: "default",
        createdAt: new Date().toISOString(),
      });
    }).pipe(Effect.orDie);

  const maybeDrainSupervisorQueue = (supervisorThreadId: ThreadId) =>
    Effect.gen(function* () {
      const supervisor = yield* resolveThread(supervisorThreadId);
      if (
        !supervisor?.supervisorState ||
        supervisor.supervisorState.lifecycleState !== "executing_children"
      ) {
        return;
      }

      const updatedReadModel = yield* resolveReadModel();
      const nextState: SupervisorThreadState = {
        ...supervisor.supervisorState,
        delegations: supervisor.supervisorState.delegations.map((delegation) => {
          const childThread = updatedReadModel.threads.find(
            (thread) => thread.id === delegation.childThreadId,
          );
          return {
            ...delegation,
            status:
              delegation.status === "cancelled"
                ? "cancelled"
                : deriveDelegationStatus(childThread),
          };
        }),
      };

      if (asDeepComparable(nextState) !== asDeepComparable(supervisor.supervisorState)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.multi-agent.configure",
          commandId: serverCommandId("supervisor-sync-status"),
          threadId: supervisor.id,
          supervisorState: nextState,
          createdAt: new Date().toISOString(),
        });
      }

      const runningCount = nextState.delegations.filter((entry) => entry.status === "running").length;
      const availableSlots = Math.max(0, nextState.maxConcurrentChildren - runningCount);
      const queuedDelegations = nextState.delegations.filter((entry) => entry.status === "queued");

      for (const delegation of queuedDelegations.slice(0, availableSlots)) {
        const launchExit = yield* Effect.exit(launchDelegation(supervisor, delegation));
        if (Exit.isFailure(launchExit)) {
          yield* setSupervisorState(supervisor.id, (thread) =>
            thread.supervisorState
              ? {
                  ...thread.supervisorState,
                  delegations: thread.supervisorState.delegations.map((entry) =>
                    entry.delegationId === delegation.delegationId
                      ? { ...entry, status: "failed" }
                      : entry,
                  ),
                }
              : null,
          );
        }
      }

      yield* maybeStartSupervisorReview(supervisor.id);
    }).pipe(Effect.orDie);

  const initializeDelegationsFromApprovedPlan = (
    event: Extract<SupervisorRelevantEvent, { type: "thread.supervisor-plan-approved" }>,
  ) =>
    Effect.gen(function* () {
      const supervisor = yield* resolveThread(event.payload.threadId);
      if (!supervisor?.supervisorState) {
        return;
      }
      const plan = supervisor.proposedPlans.find((entry) => entry.id === event.payload.planId);
      const parsedPlan = plan ? parseSupervisorPlan(plan.planMarkdown) : null;
      if (!parsedPlan) {
        return;
      }
      const delegations: Array<SupervisorDelegation> = parsedPlan.tasks.map((task) => ({
        delegationId: crypto.randomUUID(),
        childThreadId: newThreadId(),
        title: task.title,
        prompt: task.prompt,
        expectedOutput: task.expectedOutput,
        reviewInstructions: task.reviewInstructions,
        writeAccess: task.writeAccess,
        status: "queued",
      }));
      yield* orchestrationEngine.dispatch({
        type: "thread.multi-agent.configure",
        commandId: serverCommandId("supervisor-plan-approved"),
        threadId: supervisor.id,
        supervisorState: {
          ...supervisor.supervisorState,
          activePlanId: event.payload.planId,
          lifecycleState: "executing_children",
          structuringError: null,
          delegations,
        },
        createdAt: new Date().toISOString(),
      });
      yield* maybeDrainSupervisorQueue(supervisor.id);
    }).pipe(Effect.orDie);

  const processEvent = (event: SupervisorRelevantEvent) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.supervisor-plan-generation-requested":
          yield* requestExecutionPlanGeneration({
            threadId: event.payload.threadId,
            sourcePlanId: event.payload.sourcePlanId,
          });
          return;

        case "thread.supervisor-plan-approved":
          yield* initializeDelegationsFromApprovedPlan(event);
          return;

        case "thread.supervisor-plan-rejected":
          yield* setSupervisorState(event.payload.threadId, (thread) =>
            thread.supervisorState
              ? {
                  ...thread.supervisorState,
                  activePlanId: null,
                  lifecycleState: "drafting_plan",
                  structuringError:
                    "Execution plan was rejected. Retry generation or ask the supervisor to revise the human plan.",
                  delegations: [],
                }
              : null,
          );
          return;

        case "thread.multi-agent-configured":
          yield* maybeDrainSupervisorQueue(event.payload.threadId);
          return;

        case "thread.child-taken-over": {
          const supervisors = yield* resolveSupervisorThreads();
          for (const supervisor of supervisors) {
            if (
              !supervisor.supervisorState?.delegations.some(
                (entry) => entry.childThreadId === event.payload.threadId,
              )
            ) {
              continue;
            }
            yield* setSupervisorState(supervisor.id, (thread) =>
              thread.supervisorState
                ? {
                    ...thread.supervisorState,
                    delegations: thread.supervisorState.delegations.map((entry) =>
                      entry.childThreadId === event.payload.threadId
                        ? { ...entry, status: "cancelled" }
                        : entry,
                    ),
                  }
                : null,
            );
            yield* maybeStartSupervisorReview(supervisor.id);
          }
          return;
        }

        case "thread.session-set":
        case "thread.turn-diff-completed": {
          const supervisors = yield* resolveSupervisorThreads();
          for (const supervisor of supervisors) {
            if (
              supervisor.id === event.payload.threadId &&
              supervisor.supervisorState?.lifecycleState === "drafting_plan"
            ) {
              yield* maybeAdvanceDraftingSupervisor(supervisor.id);
            }
            if (
              supervisor.id === event.payload.threadId &&
              supervisor.supervisorState?.lifecycleState === "structuring_execution_plan"
            ) {
              yield* maybeFinalizeExecutionPlan(supervisor.id);
            }
            if (
              supervisor.id === event.payload.threadId &&
              supervisor.supervisorState?.lifecycleState === "reviewing_children"
            ) {
              const updatedSupervisor = yield* resolveThread(supervisor.id);
              if (
                updatedSupervisor?.latestTurn?.state === "completed" &&
                updatedSupervisor.session?.status === "ready"
              ) {
                yield* setSupervisorState(supervisor.id, (thread) =>
                  thread.supervisorState
                    ? { ...thread.supervisorState, lifecycleState: "completed" }
                    : null,
                );
              }
            }
            if (
              supervisor.supervisorState?.delegations.some(
                (entry) => entry.childThreadId === event.payload.threadId,
              )
            ) {
              yield* maybeDrainSupervisorQueue(supervisor.id);
            }
          }
        }
      }
    }).pipe(Effect.orDie);

  const start: SupervisorReactorShape["start"] = Effect.gen(function* () {
    const queue = yield* Queue.unbounded<SupervisorRelevantEvent>();

    yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
      switch (event.type) {
        case "thread.supervisor-plan-generation-requested":
        case "thread.supervisor-plan-approved":
        case "thread.supervisor-plan-rejected":
        case "thread.multi-agent-configured":
        case "thread.session-set":
        case "thread.turn-diff-completed":
        case "thread.child-taken-over":
          return Queue.offer(queue, event);
        default:
          return Effect.void;
      }
    }).pipe(Effect.forkScoped);

    yield* Stream.runForEach(Stream.fromQueue(queue), processEvent).pipe(Effect.forkScoped);
  });

  return {
    start,
  } satisfies SupervisorReactorShape;
});

export const SupervisorReactorLive = Layer.effect(SupervisorReactor, make);
