export interface SupervisorPlanTask {
  readonly title: string;
  readonly prompt: string;
  readonly expectedOutput: string | null;
  readonly reviewInstructions: string | null;
  readonly writeAccess: boolean;
}

export interface SupervisorPlanDocument {
  readonly t3SupervisorPlanVersion: 1;
  readonly objective: string;
  readonly delegationReason: string;
  readonly concurrencyStrategy: string;
  readonly reviewStrategy: string;
  readonly completionCriteria: string;
  readonly tasks: ReadonlyArray<SupervisorPlanTask>;
}

const SUPERVISOR_PLAN_FENCE = "t3-supervisor-plan";
const JSON_CODE_FENCE_REGEX = /```([^\n]*)\n([\s\S]*?)```/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeTask(value: unknown): SupervisorPlanTask | null {
  const record = asRecord(value);
  if (!record) return null;
  const title = asTrimmedString(record.title);
  const prompt = asTrimmedString(record.prompt);
  if (!title || !prompt) return null;
  return {
    title,
    prompt,
    expectedOutput: asTrimmedString(record.expectedOutput),
    reviewInstructions: asTrimmedString(record.reviewInstructions),
    writeAccess: asBoolean(record.writeAccess) ?? false,
  };
}

export function extractSupervisorPlanJson(markdown: string): string | null {
  const exactFenceMatch = markdown.match(
    new RegExp(String.raw`(?:^|\n)\`\`\`${SUPERVISOR_PLAN_FENCE}\n([\s\S]*?)\n\`\`\`(?:\n|$)`),
  );
  if (exactFenceMatch?.[1]?.trim()) {
    return exactFenceMatch[1].trim();
  }

  for (const match of markdown.matchAll(JSON_CODE_FENCE_REGEX)) {
    const fenceLabel = match[1]?.trim().toLowerCase() ?? "";
    const body = match[2]?.trim() ?? "";
    if (!body || !body.includes('"t3SupervisorPlanVersion"')) {
      continue;
    }
    if (fenceLabel === "" || fenceLabel === "json" || fenceLabel === SUPERVISOR_PLAN_FENCE) {
      return body;
    }
  }

  const versionIndex = markdown.indexOf('"t3SupervisorPlanVersion"');
  if (versionIndex < 0) {
    return null;
  }
  const objectStart = markdown.lastIndexOf("{", versionIndex);
  const objectEnd = markdown.indexOf("}", versionIndex);
  if (objectStart < 0 || objectEnd < 0 || objectEnd <= objectStart) {
    return null;
  }
  const candidate = markdown.slice(objectStart, markdown.lastIndexOf("}") + 1).trim();
  return candidate.length > 0 ? candidate : null;
}

function parseSupervisorPlanDocument(parsed: unknown): SupervisorPlanDocument | null {
  const record = asRecord(parsed);
  if (!record) return null;
  if (record.t3SupervisorPlanVersion !== 1) return null;

  const objective = asTrimmedString(record.objective);
  const delegationReason = asTrimmedString(record.delegationReason);
  const concurrencyStrategy = asTrimmedString(record.concurrencyStrategy);
  const reviewStrategy = asTrimmedString(record.reviewStrategy);
  const completionCriteria = asTrimmedString(record.completionCriteria);
  const tasksRaw = Array.isArray(record.tasks) ? record.tasks : null;
  const tasks = tasksRaw?.map(normalizeTask).filter((entry): entry is SupervisorPlanTask => entry !== null);

  if (
    !objective ||
    !delegationReason ||
    !concurrencyStrategy ||
    !reviewStrategy ||
    !completionCriteria ||
    !tasks ||
    tasks.length === 0
  ) {
    return null;
  }

  return {
    t3SupervisorPlanVersion: 1,
    objective,
    delegationReason,
    concurrencyStrategy,
    reviewStrategy,
    completionCriteria,
    tasks,
  };
}

export function parseSupervisorPlan(markdown: string): SupervisorPlanDocument | null {
  const jsonBlock = extractSupervisorPlanJson(markdown);
  if (!jsonBlock) return null;

  try {
    return parseSupervisorPlanDocument(JSON.parse(jsonBlock));
  } catch {
    return null;
  }
}

export function buildSupervisorPlanningInstructions(input: {
  readonly maxConcurrentChildren: number;
}): string {
  return [
    "This thread is operating in T3 supervisor mode.",
    "You must first produce a multi-agent plan before delegating any work.",
    "Your plan must explain the objective, why delegation is needed, each child task, the concurrency strategy, the final review strategy, and completion criteria.",
    `Plan for at most ${input.maxConcurrentChildren} concurrently running child agents.`,
    "This first response is for the human user. Focus on clarity, tradeoffs, task breakdown, and review strategy.",
    "Do not include machine-readable JSON in this response.",
    "Do not start child execution yourself. T3 will separately ask you to convert the approved plan into structured delegation JSON.",
  ].join("\n");
}

export function buildSupervisorDirectExecutionPlanInstructions(input: {
  readonly maxConcurrentChildren: number;
  readonly childModel: string | null;
}): string {
  return [
    "This thread is operating in T3 supervisor agent-plan mode.",
    "The user's message already contains the source plan to convert into executable delegation JSON.",
    `Limit the plan to at most ${input.maxConcurrentChildren} concurrently running child agents.`,
    input.childModel
      ? `Use ${input.childModel} as the child-agent model unless a task absolutely requires otherwise.`
      : "Assume child agents inherit the supervisor model.",
    "Output only a single fenced JSON block using the language tag `t3-supervisor-plan`.",
    "Do not include any prose before or after the JSON block.",
    "Do not redesign the source plan unless it is genuinely incomplete or contradictory.",
    "Every task must include a concrete prompt for the child agent.",
    'Use this exact top-level shape: {"t3SupervisorPlanVersion":1,"objective":"...","delegationReason":"...","concurrencyStrategy":"...","reviewStrategy":"...","completionCriteria":"...","tasks":[{"title":"...","prompt":"...","expectedOutput":"...","reviewInstructions":"...","writeAccess":true}]}',
  ].join("\n");
}

export function buildSupervisorExecutionPlanPrompt(input: {
  readonly sourcePlanMarkdown: string;
  readonly maxConcurrentChildren: number;
  readonly childModel: string | null;
}): string {
  return [
    "Convert the approved supervisor plan below into executable T3 delegation JSON.",
    "Do not redesign the plan unless the source plan is genuinely incomplete or contradictory.",
    `Limit the plan to at most ${input.maxConcurrentChildren} concurrently running child agents.`,
    input.childModel
      ? `Use ${input.childModel} as the child-agent model unless a task absolutely requires otherwise.`
      : "Assume child agents inherit the supervisor model.",
    "Output only a single fenced JSON block using the language tag `t3-supervisor-plan`.",
    "Do not include any prose before or after the JSON block.",
    "Every task must include a concrete prompt for the child agent.",
    'Use this exact top-level shape: {"t3SupervisorPlanVersion":1,"objective":"...","delegationReason":"...","concurrencyStrategy":"...","reviewStrategy":"...","completionCriteria":"...","tasks":[{"title":"...","prompt":"...","expectedOutput":"...","reviewInstructions":"...","writeAccess":true}]}',
    "",
    "Approved source plan:",
    input.sourcePlanMarkdown.trim(),
  ].join("\n");
}

export function buildSupervisorReviewPrompt(input: {
  readonly plan: SupervisorPlanDocument;
  readonly childSummaries: ReadonlyArray<{
    readonly title: string;
    readonly status: string;
    readonly summary: string;
  }>;
}): string {
  const childSummaryLines = input.childSummaries.map(
    (entry, index) =>
      `${index + 1}. ${entry.title}\nStatus: ${entry.status}\nSummary:\n${entry.summary}`,
  );

  return [
    "Review the completed child-agent work and finish the supervisor task.",
    `Objective: ${input.plan.objective}`,
    `Review strategy: ${input.plan.reviewStrategy}`,
    `Completion criteria: ${input.plan.completionCriteria}`,
    "",
    "Child outputs:",
    ...childSummaryLines,
    "",
    "Check the child work against the promised review strategy and completion criteria, then report the final outcome.",
  ].join("\n");
}
