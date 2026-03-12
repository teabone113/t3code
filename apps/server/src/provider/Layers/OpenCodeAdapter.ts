// @ts-nocheck
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  createOpencodeClient,
  type Event as OpenCodeEvent,
  type OpencodeClient,
  type Part as OpenCodePart,
} from "@opencode-ai/sdk";
import {
  type ProviderCatalog,
  type ProviderCatalogModel,
  type ProviderStartOauthResult,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderTurnStartResult,
  ProviderItemId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderTurnSteerResult,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";

const PROVIDER = "opencode" as const;
const OPENCODE_APPROVAL_AGENT = "t3-approval-required";
const OPENCODE_FULL_ACCESS_AGENT = "t3-full-access";

type SessionContext = {
  session: ProviderSession;
  sessionId: string;
  cwd: string;
  activeTurnId: TurnId | undefined;
};

type WorkspaceRuntime = {
  cwd: string;
  binaryPath: string;
  url: string;
  child: ChildProcessWithoutNullStreams;
  client: OpencodeClient;
  stop: () => void;
  eventAbort: AbortController;
  sessionsByThreadId: Map<ThreadId, SessionContext>;
  threadIdBySessionId: Map<string, ThreadId>;
  permissionSessionByRequestId: Map<string, string>;
  messageRoleByMessageId: Map<string, string>;
  textByPartId: Map<string, string>;
  partTypeByPartId: Map<string, string>;
  toolStateByPartId: Map<string, string>;
  connectedProviderIds: Set<string>;
};

const SYNTHETIC_DELEGATED_PROVIDERS = [
  {
    id: "openrouter",
    name: "OpenRouter",
    env: ["OPENROUTER_API_KEY"],
    models: {},
  },
] as const satisfies ReadonlyArray<Record<string, any>>;

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function makeEventId(): EventId {
  return EventId.makeUnsafe(`evt-opencode-${randomUUID()}`);
}

function makeTurnId(): TurnId {
  return TurnId.makeUnsafe(`turn-opencode-${randomUUID()}`);
}

function toRuntimeEvent(event: any): ProviderRuntimeEvent {
  return { provider: PROVIDER, ...event } as ProviderRuntimeEvent;
}

function toRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function isNotFoundCause(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  const normalized = message.toLowerCase();
  return normalized.includes("404") || normalized.includes("not found");
}

async function requestOpenCodeJson<T>(input: {
  url: string;
  path: string;
  method: "GET" | "POST" | "PUT";
  body?: unknown;
}): Promise<T> {
  const response = await fetch(new URL(input.path, input.url), {
    method: input.method,
    headers: input.body === undefined ? undefined : { "Content-Type": "application/json" },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${input.method} ${input.path} failed with ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function toProcessError(threadId: ThreadId, detail: string, cause?: unknown): ProviderAdapterProcessError {
  return new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function resolveWorkspaceCwd(input: {
  cwd: string | undefined;
  fallback: string;
}): string {
  return nonEmpty(input.cwd) ?? input.fallback;
}

function unwrapData<T>(value: unknown): T {
  if (value && typeof value === "object" && "data" in (value as Record<string, unknown>)) {
    return (value as { data: T }).data;
  }
  return value as T;
}

async function findAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate port for OpenCode server.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.once("error", reject);
  });
}

function makeServerConfig() {
  return {
    agent: {
      [OPENCODE_APPROVAL_AGENT]: {
        mode: "primary",
        permission: {
          edit: "ask",
          bash: "ask",
          webfetch: "allow",
          external_directory: "ask",
          doom_loop: "ask",
        },
      },
      [OPENCODE_FULL_ACCESS_AGENT]: {
        mode: "primary",
        permission: {
          edit: "allow",
          bash: "allow",
          webfetch: "allow",
          external_directory: "allow",
          doom_loop: "allow",
        },
      },
    },
  } as const;
}

async function startOpenCodeServer(binaryPath: string): Promise<{
  url: string;
  child: ChildProcessWithoutNullStreams;
  stop: () => void;
}> {
  const port = await findAvailablePort();
  const child = spawn(binaryPath, ["serve", "--hostname=127.0.0.1", `--port=${port}`], {
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(makeServerConfig()),
    },
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for OpenCode server startup."));
    }, 6_000);
    let output = "";

    const handleChunk = (chunk: Buffer | string) => {
      output += chunk.toString();
      for (const line of output.split("\n")) {
        if (!line.startsWith("opencode server listening")) {
          continue;
        }
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (!match) {
          continue;
        }
        clearTimeout(timeout);
        const url = match[1];
        if (!url) {
          continue;
        }
        resolve(url);
        return;
      }
    };

    child.stdout.on("data", handleChunk);
    child.stderr.on("data", handleChunk);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode server exited before startup (code ${code ?? "unknown"}).`));
    });
  });

  return {
    url,
    child,
    stop: () => {
      child.kill();
    },
  };
}

function encodeOpenCodeModel(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function decodeOpenCodeModel(model: string | undefined): { providerId?: string; modelId?: string } {
  const normalized = nonEmpty(model);
  if (!normalized) {
    return {};
  }
  for (const separator of [":", "/"] as const) {
    const separatorIndex = normalized.indexOf(separator);
    if (separatorIndex > 0 && separatorIndex < normalized.length - 1) {
      return {
        providerId: normalized.slice(0, separatorIndex),
        modelId: normalized.slice(separatorIndex + 1),
      };
    }
  }
  return { modelId: normalized };
}

function mapApprovalDecision(decision: ProviderApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

function agentForRuntimeMode(runtimeMode: ProviderSession["runtimeMode"]): string {
  return runtimeMode === "approval-required" ? OPENCODE_APPROVAL_AGENT : OPENCODE_FULL_ACCESS_AGENT;
}

function supportsRequestType(type: string): boolean {
  return type.includes("read") || type.includes("edit") || type.includes("bash");
}

function toCanonicalRequestType(type: string): string {
  const normalized = type.toLowerCase();
  if (normalized.includes("read")) {
    return "file_read_approval";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change_approval";
  }
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("shell")) {
    return "command_execution_approval";
  }
  return "unknown";
}

function toCanonicalItemType(toolName: string): string {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("shell")) {
    return "command_execution";
  }
  if (normalized.includes("edit") || normalized.includes("write") || normalized.includes("patch")) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  return "dynamic_tool_call";
}

function extractTextDelta(part: OpenCodePart, previousText: string): string | undefined {
  if (part.type !== "text" && part.type !== "reasoning") {
    return undefined;
  }
  const nextText = part.text ?? "";
  if (nextText.length === 0) {
    return undefined;
  }
  if (nextText.startsWith(previousText)) {
    return nextText.slice(previousText.length) || undefined;
  }
  return nextText;
}

function readSessionIdFromEvent(payload: any): string | undefined {
  const properties = payload?.properties;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }
  if (typeof properties.sessionID === "string") {
    return properties.sessionID;
  }
  if (properties.info && typeof properties.info === "object" && typeof properties.info.sessionID === "string") {
    return properties.info.sessionID;
  }
  if (properties.part && typeof properties.part === "object" && typeof properties.part.sessionID === "string") {
    return properties.part.sessionID;
  }
  if (properties.error && typeof properties.error === "object" && typeof properties.error.sessionID === "string") {
    return properties.error.sessionID;
  }
  return undefined;
}

function readPermissionType(payload: any): string | undefined {
  const properties = payload?.properties;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }
  if (typeof properties.type === "string") {
    return properties.type;
  }
  if (typeof properties.permission === "string") {
    return properties.permission;
  }
  return undefined;
}

function readPermissionDetail(payload: any): string | undefined {
  const properties = payload?.properties;
  if (!properties || typeof properties !== "object") {
    return undefined;
  }
  if (typeof properties.title === "string" && properties.title.length > 0) {
    return properties.title;
  }
  if (Array.isArray(properties.patterns) && properties.patterns.length > 0) {
    return properties.patterns.join(", ");
  }
  return undefined;
}

function toContentStreamKind(partType: string | undefined): "assistant_text" | "reasoning_text" {
  return partType === "reasoning" ? "reasoning_text" : "assistant_text";
}

function toCatalog(input: {
  cwd: string;
  delegatedProviders: ReadonlyArray<Record<string, any>>;
  connected: ReadonlySet<string>;
  defaultByProviderId: Readonly<Record<string, string>>;
  authMethodsByProviderId: Readonly<Record<string, ReadonlyArray<Record<string, any>>>>;
}): ProviderCatalog {
  const providers = input.delegatedProviders.toSorted((left, right) => {
    const leftConnected = input.connected.has(left.id) ? 0 : 1;
    const rightConnected = input.connected.has(right.id) ? 0 : 1;
    return leftConnected - rightConnected || left.name.localeCompare(right.name);
  });

  const models: ProviderCatalogModel[] = [];
  for (const provider of providers) {
    for (const model of Object.values(provider.models ?? {})) {
      if (!model.id || !model.name) {
        continue;
      }
      models.push({
        slug: encodeOpenCodeModel(provider.id, model.id),
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        name: model.name,
        connected: input.connected.has(provider.id),
        supportsAttachments: Boolean(model.attachment),
        supportsReasoning: Boolean(model.reasoning),
        supportsToolCalls: Boolean(model.tool_call),
        ...(model.experimental ? { experimental: true } : {}),
        ...(model.status === "alpha" || model.status === "beta" || model.status === "deprecated"
          ? { status: model.status }
          : {}),
      });
    }
  }

  models.sort((left, right) => {
    const leftConnected = left.connected ? 0 : 1;
    const rightConnected = right.connected ? 0 : 1;
    return (
      leftConnected - rightConnected ||
      left.providerName.localeCompare(right.providerName) ||
      left.name.localeCompare(right.name)
    );
  });

  return {
    provider: PROVIDER,
    cwd: input.cwd,
    fetchedAt: nowIso(),
    delegatedProviders: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      connected: input.connected.has(provider.id),
      defaultModelSlug: nonEmpty(input.defaultByProviderId[provider.id])
        ? encodeOpenCodeModel(provider.id, input.defaultByProviderId[provider.id]!)
        : null,
      authMethods: (input.authMethodsByProviderId[provider.id] ?? []).map((method) => ({
        type: method.type,
        label: method.label,
      })),
    })),
    models,
  };
}

function withSyntheticDelegatedProviders(
  delegatedProviders: ReadonlyArray<Record<string, any>>,
): Array<Record<string, any>> {
  const merged = [...delegatedProviders];
  for (const provider of SYNTHETIC_DELEGATED_PROVIDERS) {
    if (merged.some((candidate) => candidate.id === provider.id)) {
      continue;
    }
    merged.push({ ...provider });
  }
  return merged;
}

function inferAuthMethodsByProviderId(
  delegatedProviders: ReadonlyArray<Record<string, any>>,
): Record<string, Array<{ type: "api"; label: string }>> {
  return Object.fromEntries(
    delegatedProviders
      .filter(
        (provider) =>
          provider.id === "openrouter" ||
          (Array.isArray(provider.env) &&
            provider.env.some((value) => typeof value === "string" && value.length > 0)),
      )
      .map((provider) => [provider.id, [{ type: "api" as const, label: "API key" }]]),
  );
}

function mergeAuthMethodsByProviderId(input: {
  delegatedProviders: ReadonlyArray<Record<string, any>>;
  authMethodsByProviderId: Readonly<Record<string, ReadonlyArray<Record<string, any>>>>;
}): Record<string, Array<Record<string, any>>> {
  const inferred = inferAuthMethodsByProviderId(input.delegatedProviders);
  const merged = Object.fromEntries(
    Object.entries(input.authMethodsByProviderId).map(([providerId, methods]) => [providerId, [...methods]]),
  ) as Record<string, Array<Record<string, any>>>;

  for (const [providerId, methods] of Object.entries(inferred)) {
    if ((merged[providerId]?.length ?? 0) > 0) {
      continue;
    }
    merged[providerId] = [...methods];
  }

  return merged;
}

function readResumeSessionId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const raw = (resumeCursor as Record<string, unknown>).sessionId;
  return typeof raw === "string" ? nonEmpty(raw) : undefined;
}

function readResumeCwd(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const raw = (resumeCursor as Record<string, unknown>).cwd;
  return typeof raw === "string" ? nonEmpty(raw) : undefined;
}

function makeOpenCodeAdapterLive(): Layer.Layer<OpenCodeAdapter> {
  return Layer.effect(
    OpenCodeAdapter,
    Effect.gen(function* () {
      const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const workspaces = new Map<string, WorkspaceRuntime>();

      const publish = (event: ProviderRuntimeEvent): void => {
        void Effect.runPromise(PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid));
      };

      const updateSession = (
        context: SessionContext,
        patch: Partial<ProviderSession> & { activeTurnId?: TurnId | undefined },
      ) => {
        context.session = {
          ...context.session,
          ...patch,
          updatedAt: nowIso(),
        };
        context.activeTurnId = patch.activeTurnId ?? context.activeTurnId;
      };

      const getSessionContext = (threadId: ThreadId): SessionContext | undefined => {
        for (const workspace of workspaces.values()) {
          const context = workspace.sessionsByThreadId.get(threadId);
          if (context) {
            return context;
          }
        }
        return undefined;
      };

      const getWorkspaceByThreadId = (threadId: ThreadId): WorkspaceRuntime | undefined => {
        for (const workspace of workspaces.values()) {
          if (workspace.sessionsByThreadId.has(threadId)) {
            return workspace;
          }
        }
        return undefined;
      };

      const resolveModelForRuntime = async (
        workspace: WorkspaceRuntime,
        requestedModel: string | undefined,
      ): Promise<{ providerId: string; modelId: string } | undefined> => {
        const catalog = await (async () => {
          try {
            const providerCatalog = unwrapData<{
              all: Array<Record<string, any>>;
              connected: string[];
              default: Record<string, string>;
            }>(
              await workspace.client.provider.list({
                throwOnError: true,
              }),
            );
            return {
              all: withSyntheticDelegatedProviders(providerCatalog.all ?? []),
              connected: [...new Set([...(providerCatalog.connected ?? []), ...workspace.connectedProviderIds])],
              default: providerCatalog.default ?? {},
            };
          } catch (cause) {
            if (!isNotFoundCause(cause)) {
              throw cause;
            }
            const configProviders = unwrapData<{
              providers: Array<Record<string, any>>;
              default: Record<string, string>;
            }>(
              await workspace.client.config.providers({
                throwOnError: true,
              }),
            );
            return {
              all: withSyntheticDelegatedProviders(configProviders.providers ?? []),
              connected: [...workspace.connectedProviderIds],
              default: configProviders.default ?? {},
            };
          }
        })();
        const requested = decodeOpenCodeModel(requestedModel);
        if (requested.providerId && requested.modelId) {
          return requested as { providerId: string; modelId: string };
        }
        const defaultEntries = Object.entries(catalog.default ?? {});
        const connected = new Set(catalog.connected ?? []);
        const defaultConnected = defaultEntries.find(([providerId]) => connected.has(providerId));
        if (defaultConnected) {
          return {
            providerId: defaultConnected[0],
            modelId: defaultConnected[1],
          };
        }
        const firstConnectedProvider = (catalog.all ?? []).find((provider) => connected.has(provider.id));
        const firstConnectedModel = firstConnectedProvider
          ? Object.values(firstConnectedProvider.models ?? {}).find((model) => nonEmpty(model.id))
          : undefined;
        if (firstConnectedProvider && firstConnectedModel?.id) {
          return {
            providerId: firstConnectedProvider.id,
            modelId: firstConnectedModel.id,
          };
        }
        const firstProvider = (catalog.all ?? [])[0];
        const firstModel = firstProvider
          ? Object.values(firstProvider.models ?? {}).find((model) => nonEmpty(model.id))
          : undefined;
        if (firstProvider && firstModel?.id) {
          return {
            providerId: firstProvider.id,
            modelId: firstModel.id,
          };
        }
        return undefined;
      };

      const emitWorkspaceShutdown = (workspace: WorkspaceRuntime, detail: string) => {
        for (const context of workspace.sessionsByThreadId.values()) {
          publish(
            toRuntimeEvent({
              eventId: makeEventId(),
              type: "session.exited",
              threadId: context.session.threadId,
              createdAt: nowIso(),
              ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
              payload: {
                reason: detail,
                exitKind: "error",
                recoverable: true,
              },
              raw: {
                source: "opencode.event",
                payload: {
                  detail,
                },
              },
            }),
          );
        }
      };

      const ensureWorkspace = (cwd: string, binaryPath?: string) =>
        Effect.tryPromise({
          try: async () => {
            const key = cwd;
            const existing = workspaces.get(key);
            if (existing) {
              return existing;
            }

            const resolvedBinaryPath = nonEmpty(binaryPath) ?? "opencode";
            const server = await startOpenCodeServer(resolvedBinaryPath);
            const client = createOpencodeClient({
              baseUrl: server.url,
              directory: cwd,
            });
            const runtime: WorkspaceRuntime = {
              cwd,
              binaryPath: resolvedBinaryPath,
              url: server.url,
              child: server.child,
              client,
              stop: server.stop,
              eventAbort: new AbortController(),
              sessionsByThreadId: new Map(),
              threadIdBySessionId: new Map(),
              permissionSessionByRequestId: new Map(),
              messageRoleByMessageId: new Map(),
              textByPartId: new Map(),
              partTypeByPartId: new Map(),
              toolStateByPartId: new Map(),
              connectedProviderIds: new Set(),
            };
            workspaces.set(key, runtime);

            void (async () => {
              try {
                const subscription = await runtime.client.event.subscribe({
                  signal: runtime.eventAbort.signal,
                });
                for await (const event of subscription.stream) {
                  const payload = event as OpenCodeEvent;
                  const sessionId = readSessionIdFromEvent(payload);
                  const threadId = sessionId ? runtime.threadIdBySessionId.get(sessionId) : undefined;
                  if (!threadId) {
                    continue;
                  }
                  const context = runtime.sessionsByThreadId.get(threadId);
                  if (!context) {
                    continue;
                  }

                  switch (payload.type) {
                    case "session.status": {
                      const nextState =
                        payload.properties.status.type === "busy" ? "running" : "ready";
                      updateSession(context, {
                        status: nextState === "running" ? "running" : "ready",
                        activeTurnId: context.activeTurnId,
                      });
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "session.state.changed",
                          threadId,
                          createdAt: nowIso(),
                          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                          payload: {
                            state: nextState,
                            detail: payload.properties.status,
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      if (payload.properties.status.type === "idle" && context.activeTurnId) {
                        publish(
                          toRuntimeEvent({
                            eventId: makeEventId(),
                            type: "turn.completed",
                            threadId,
                            createdAt: nowIso(),
                            turnId: context.activeTurnId,
                            payload: {
                              state: "completed",
                            },
                            raw: {
                              source: "opencode.event",
                              payload,
                            },
                          }),
                        );
                        context.activeTurnId = undefined;
                      }
                      break;
                    }

                    case "session.error": {
                      const message = payload.properties.error?.data?.message ?? "OpenCode session error";
                      updateSession(context, {
                        status: "error",
                        lastError: message,
                        activeTurnId: context.activeTurnId,
                      });
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "runtime.error",
                          threadId,
                          createdAt: nowIso(),
                          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                          payload: {
                            class: "provider_error",
                            message,
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      if (context.activeTurnId) {
                        publish(
                          toRuntimeEvent({
                            eventId: makeEventId(),
                            type: "turn.completed",
                            threadId,
                            createdAt: nowIso(),
                            turnId: context.activeTurnId,
                            payload: {
                              state: "failed",
                              errorMessage: message,
                            },
                            raw: {
                              source: "opencode.event",
                              payload,
                            },
                          }),
                        );
                        context.activeTurnId = undefined;
                      }
                      break;
                    }

                    case "message.updated": {
                      runtime.messageRoleByMessageId.set(
                        payload.properties.info.id,
                        payload.properties.info.role,
                      );
                      if (payload.properties.info.role === "assistant") {
                        const providerRefs = {
                          providerTurnId: payload.properties.info.id,
                          providerItemId: ProviderItemId.makeUnsafe(payload.properties.info.id),
                        };
                        publish(
                          toRuntimeEvent({
                            eventId: makeEventId(),
                            type: "item.started",
                            threadId,
                            createdAt: nowIso(),
                            ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                            itemId: RuntimeItemId.makeUnsafe(payload.properties.info.id),
                            providerRefs,
                            payload: {
                              itemType: "assistant_message",
                              title: "Assistant message",
                            },
                            raw: {
                              source: "opencode.event",
                              payload,
                            },
                          }),
                        );
                      }
                      break;
                    }

                    case "message.part.updated": {
                      const turnId = context.activeTurnId;
                      const part = payload.properties.part;
                      runtime.partTypeByPartId.set(part.id, part.type);
                      const messageRole = runtime.messageRoleByMessageId.get(part.messageID);
                      if (part.type === "text" || part.type === "reasoning") {
                        if (messageRole !== "assistant" && part.type !== "reasoning") {
                          runtime.textByPartId.set(part.id, part.text);
                          break;
                        }
                        const previousText = runtime.textByPartId.get(part.id) ?? "";
                        const delta = payload.properties.delta ?? extractTextDelta(part, previousText);
                        runtime.textByPartId.set(part.id, part.text);
                        if (delta) {
                          publish(
                            toRuntimeEvent({
                              eventId: makeEventId(),
                              type: "content.delta",
                              threadId,
                              createdAt: nowIso(),
                              ...(turnId ? { turnId } : {}),
                              itemId: RuntimeItemId.makeUnsafe(part.messageID),
                              payload: {
                                streamKind: toContentStreamKind(part.type),
                                delta,
                              },
                              raw: {
                                source: "opencode.event",
                                payload,
                              },
                            }),
                          );
                        }
                        break;
                      }

                      if (part.type === "tool") {
                        const previousState = runtime.toolStateByPartId.get(part.id);
                        const nextState = part.state.status;
                        runtime.toolStateByPartId.set(part.id, nextState);
                        const runtimeItemId = RuntimeItemId.makeUnsafe(part.id);
                        if (!previousState) {
                          publish(
                            toRuntimeEvent({
                              eventId: makeEventId(),
                              type: "item.started",
                              threadId,
                              createdAt: nowIso(),
                              ...(turnId ? { turnId } : {}),
                              itemId: runtimeItemId,
                              payload: {
                                itemType: toCanonicalItemType(part.tool),
                                title: part.tool,
                                detail: part.state.title ?? part.state.raw ?? undefined,
                                status: "inProgress",
                              },
                              raw: {
                                source: "opencode.event",
                                payload,
                              },
                            }),
                          );
                        }
                        if (nextState === "completed" || nextState === "error") {
                          publish(
                            toRuntimeEvent({
                              eventId: makeEventId(),
                              type: "item.completed",
                              threadId,
                              createdAt: nowIso(),
                              ...(turnId ? { turnId } : {}),
                              itemId: runtimeItemId,
                              payload: {
                                itemType: toCanonicalItemType(part.tool),
                                title: part.state.title ?? part.tool,
                                detail:
                                  nextState === "completed" ? part.state.output : part.state.error,
                                status: nextState === "completed" ? "completed" : "failed",
                              },
                              raw: {
                                source: "opencode.event",
                                payload,
                              },
                            }),
                          );
                        } else {
                          publish(
                            toRuntimeEvent({
                              eventId: makeEventId(),
                              type: "item.updated",
                              threadId,
                              createdAt: nowIso(),
                              ...(turnId ? { turnId } : {}),
                              itemId: runtimeItemId,
                              payload: {
                                itemType: toCanonicalItemType(part.tool),
                                title: part.state.title ?? part.tool,
                                detail:
                                  part.state.status === "pending"
                                    ? part.state.raw
                                    : part.state.metadata ?? part.state.input,
                                status: "inProgress",
                              },
                              raw: {
                                source: "opencode.event",
                                payload,
                              },
                            }),
                          );
                        }
                      }
                      break;
                    }

                    case "message.part.delta": {
                      const turnId = context.activeTurnId;
                      if (payload.properties.field !== "text") {
                        break;
                      }
                      const partId = payload.properties.partID;
                      const delta = payload.properties.delta;
                      const messageRole = runtime.messageRoleByMessageId.get(payload.properties.messageID);
                      const partType = runtime.partTypeByPartId.get(partId);
                      if (!partId || typeof delta !== "string" || delta.length === 0) {
                        break;
                      }
                      if (messageRole !== "assistant" && partType !== "reasoning") {
                        const previousText = runtime.textByPartId.get(partId) ?? "";
                        runtime.textByPartId.set(partId, previousText + delta);
                        break;
                      }
                      const previousText = runtime.textByPartId.get(partId) ?? "";
                      runtime.textByPartId.set(partId, previousText + delta);
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "content.delta",
                          threadId,
                          createdAt: nowIso(),
                          ...(turnId ? { turnId } : {}),
                          itemId: RuntimeItemId.makeUnsafe(payload.properties.messageID),
                          payload: {
                            streamKind: toContentStreamKind(partType),
                            delta,
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      break;
                    }

                    case "permission.updated":
                    case "permission.asked": {
                      const permissionType = readPermissionType(payload)?.toLowerCase();
                      if (!permissionType) {
                        break;
                      }
                      const requestId = RuntimeRequestId.makeUnsafe(payload.properties.id);
                      runtime.permissionSessionByRequestId.set(requestId, payload.properties.sessionID);
                      if (!supportsRequestType(permissionType)) {
                        break;
                      }
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "request.opened",
                          threadId,
                          createdAt: nowIso(),
                          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                          requestId,
                          payload: {
                            requestType: toCanonicalRequestType(permissionType),
                            detail: readPermissionDetail(payload),
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      break;
                    }

                    case "permission.replied": {
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "request.resolved",
                          threadId,
                          createdAt: nowIso(),
                          ...(context.activeTurnId ? { turnId: context.activeTurnId } : {}),
                          requestId: RuntimeRequestId.makeUnsafe(
                            payload.properties.requestID ?? payload.properties.permissionID,
                          ),
                          payload: {
                            requestType: "unknown",
                            decision: payload.properties.reply ?? payload.properties.response,
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      break;
                    }

                    case "todo.updated": {
                      if (!context.activeTurnId) {
                        break;
                      }
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "turn.plan.updated",
                          threadId,
                          createdAt: nowIso(),
                          turnId: context.activeTurnId,
                          payload: {
                            plan: payload.properties.todos.map((todo) => ({
                              step: todo.content,
                              status:
                                todo.status === "in_progress"
                                  ? "inProgress"
                                  : todo.status === "completed"
                                    ? "completed"
                                    : "pending",
                            })),
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      break;
                    }

                    case "file.edited": {
                      if (!context.activeTurnId) {
                        break;
                      }
                      publish(
                        toRuntimeEvent({
                          eventId: makeEventId(),
                          type: "files.persisted",
                          threadId,
                          createdAt: nowIso(),
                          turnId: context.activeTurnId,
                          payload: {
                            files: [payload.properties.file],
                          },
                          raw: {
                            source: "opencode.event",
                            payload,
                          },
                        }),
                      );
                      break;
                    }

                    default:
                      break;
                  }
                }
              } catch (error) {
                if (runtime.eventAbort.signal.aborted) {
                  return;
                }
                emitWorkspaceShutdown(runtime, error instanceof Error ? error.message : String(error));
              }
            })();

            runtime.child.once("exit", (code) => {
              runtime.eventAbort.abort();
              workspaces.delete(key);
              emitWorkspaceShutdown(
                runtime,
                `OpenCode server exited with code ${code ?? "unknown"}.`,
              );
            });

            return runtime;
          },
          catch: (cause) => toProcessError(ThreadId.makeUnsafe("opencode-bootstrap"), "Failed to start OpenCode server.", cause),
        });

      const getCatalog: OpenCodeAdapterShape["getCatalog"] = (input) =>
        Effect.gen(function* () {
          const cwd = resolveWorkspaceCwd({
            cwd: input.cwd,
            fallback: process.cwd(),
          });
          const workspace = yield* ensureWorkspace(cwd, input.binaryPath);
          const providersResponse = yield* Effect.tryPromise({
            try: async () => {
              try {
                const providerCatalog = unwrapData<{
                  all: Array<Record<string, any>>;
                  connected: string[];
                  default: Record<string, string>;
                }>(
                  await workspace.client.provider.list({
                    throwOnError: true,
                  }),
                );
                return {
                  delegatedProviders: withSyntheticDelegatedProviders(providerCatalog.all ?? []),
                  connected: new Set([
                    ...(providerCatalog.connected ?? []),
                    ...workspace.connectedProviderIds,
                  ]),
                  defaultByProviderId: providerCatalog.default ?? {},
                };
              } catch (cause) {
                if (!isNotFoundCause(cause)) {
                  throw cause;
                }
                const configProviders = unwrapData<{
                  providers: Array<Record<string, any>>;
                  default: Record<string, string>;
                }>(
                  await workspace.client.config.providers({
                    throwOnError: true,
                  }),
                );
                return {
                  delegatedProviders: withSyntheticDelegatedProviders(configProviders.providers ?? []),
                  connected: new Set(workspace.connectedProviderIds),
                  defaultByProviderId: configProviders.default ?? {},
                };
              }
            },
            catch: (cause) => toRequestError("provider.list", cause),
          });
          const authMethodsResponse = yield* Effect.tryPromise({
            try: async () => {
              try {
                const authMethods = unwrapData<Record<string, Array<Record<string, any>>>>(
                  await workspace.client.provider.auth({
                    throwOnError: true,
                  }),
                );
                return mergeAuthMethodsByProviderId({
                  delegatedProviders: providersResponse.delegatedProviders,
                  authMethodsByProviderId: authMethods ?? {},
                });
              } catch (cause) {
                if (!isNotFoundCause(cause)) {
                  throw cause;
                }
                return mergeAuthMethodsByProviderId({
                  delegatedProviders: providersResponse.delegatedProviders,
                  authMethodsByProviderId: {},
                });
              }
            },
            catch: (cause) => toRequestError("provider.auth", cause),
          });
          return toCatalog({
            cwd,
            delegatedProviders: providersResponse.delegatedProviders,
            connected: providersResponse.connected,
            defaultByProviderId: providersResponse.defaultByProviderId,
            authMethodsByProviderId: authMethodsResponse ?? {},
          });
        });

      const setApiKeyAuth: OpenCodeAdapterShape["setApiKeyAuth"] = (input) =>
        Effect.gen(function* () {
          const cwd = resolveWorkspaceCwd({
            cwd: input.cwd,
            fallback: process.cwd(),
          });
          const workspace = yield* ensureWorkspace(cwd, input.binaryPath);
          yield* Effect.tryPromise({
            try: async () =>
              await requestOpenCodeJson<boolean>({
                url: workspace.url,
                path: `/auth/${encodeURIComponent(input.delegatedProviderId)}`,
                method: "PUT",
                body: {
                  type: "api",
                  key: input.apiKey,
                },
              }),
            catch: (cause) => toRequestError("auth.set", cause),
          });
          const providers = yield* Effect.tryPromise({
            try: async () =>
              unwrapData<{
                connected: string[];
              }>(
                await workspace.client.provider.list({
                  throwOnError: true,
                }),
              ),
            catch: (cause) => toRequestError("provider.list", cause),
          });
          for (const providerId of providers.connected ?? []) {
            workspace.connectedProviderIds.add(providerId);
          }
          return true;
        });

      const startOauth: OpenCodeAdapterShape["startOauth"] = (input) =>
        Effect.gen(function* () {
          const cwd = resolveWorkspaceCwd({
            cwd: input.cwd,
            fallback: process.cwd(),
          });
          const workspace = yield* ensureWorkspace(cwd, input.binaryPath);
          return yield* Effect.tryPromise({
            try: async () =>
              await requestOpenCodeJson<ProviderStartOauthResult>({
                url: workspace.url,
                path: `/provider/${encodeURIComponent(input.delegatedProviderId)}/oauth/authorize`,
                method: "POST",
                body: { method: input.methodIndex },
              }),
            catch: (cause) => toRequestError("provider.oauth.authorize", cause),
          });
        });

      const completeOauth: OpenCodeAdapterShape["completeOauth"] = (input) =>
        Effect.gen(function* () {
          const cwd = resolveWorkspaceCwd({
            cwd: input.cwd,
            fallback: process.cwd(),
          });
          const workspace = yield* ensureWorkspace(cwd, input.binaryPath);
          return yield* Effect.tryPromise({
            try: async () =>
              await requestOpenCodeJson<boolean>({
                url: workspace.url,
                path: `/provider/${encodeURIComponent(input.delegatedProviderId)}/oauth/callback`,
                method: "POST",
                body: {
                  method: input.methodIndex,
                  ...(input.code ? { code: input.code } : {}),
                },
              }),
            catch: (cause) => toRequestError("provider.oauth.callback", cause),
          });
        });

      const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
        Effect.gen(function* () {
          const cwd = resolveWorkspaceCwd({
            cwd: input.cwd ?? readResumeCwd(input.resumeCursor),
            fallback: process.cwd(),
          });
          const workspace = yield* ensureWorkspace(cwd, input.providerOptions?.opencode?.binaryPath);

          const existing = workspace.sessionsByThreadId.get(input.threadId);
          if (existing) {
            return existing.session;
          }

          const resumeSessionId = readResumeSessionId(input.resumeCursor);
          let sessionId = resumeSessionId;
          if (!sessionId) {
            const created = yield* Effect.tryPromise({
              try: async () =>
                unwrapData<{ id: string }>(
                  await workspace.client.session.create({
                  body: {
                    title: `Thread ${input.threadId}`,
                  },
                  throwOnError: true,
                }),
                ),
              catch: (cause) => toRequestError("session.create", cause),
            });
            sessionId = created.id;
          } else {
            yield* Effect.tryPromise({
              try: () =>
                workspace.client.session.get({
                  path: { id: resumeSessionId },
                  throwOnError: true,
                }),
              catch: (cause) => toRequestError("session.get", cause),
            });
          }

          const now = nowIso();
          const session: ProviderSession = {
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            threadId: input.threadId,
            cwd,
            ...(input.model ? { model: input.model } : {}),
            resumeCursor: {
              sessionId,
              cwd,
            },
            createdAt: now,
            updatedAt: now,
          };
          workspace.sessionsByThreadId.set(input.threadId, {
            session,
            sessionId,
            cwd,
            activeTurnId: undefined,
          });
          workspace.threadIdBySessionId.set(sessionId, input.threadId);

          publish(
            toRuntimeEvent({
              eventId: makeEventId(),
              type: "session.started",
              threadId: input.threadId,
              createdAt: now,
              payload: {
                resume: session.resumeCursor,
              },
              raw: {
                source: "opencode.event",
                payload: {
                  sessionId,
                  cwd,
                },
              },
            }),
          );
          publish(
            toRuntimeEvent({
              eventId: makeEventId(),
              type: "thread.started",
              threadId: input.threadId,
              createdAt: now,
              payload: {
                providerThreadId: sessionId,
              },
              raw: {
                source: "opencode.event",
                payload: {
                  sessionId,
                  cwd,
                },
              },
            }),
          );

          return session;
        });

      const sendMessage = (
        context: SessionContext,
        input: Pick<ProviderSendTurnInput, "input" | "attachments" | "model">,
      ) =>
        Effect.gen(function* () {
          const workspace = getWorkspaceByThreadId(context.session.threadId);
          if (!workspace) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: context.session.threadId,
            });
          }
          const resolvedModel = yield* Effect.tryPromise({
            try: () => resolveModelForRuntime(workspace, input.model ?? context.session.model),
            catch: (cause) => toRequestError("provider.list", cause),
          });
          const turnId = context.activeTurnId ?? makeTurnId();
          context.activeTurnId = turnId;
          updateSession(context, {
            status: "running",
            ...(input.model ? { model: input.model } : {}),
            activeTurnId: turnId,
          });

          const attachmentParts = yield* Effect.forEach(input.attachments ?? [], (attachment) =>
            Effect.tryPromise({
              try: async () => ({
                type: "file" as const,
                mime: attachment.mimeType,
                filename: attachment.name,
                url: pathToFileURL(resolveAttachmentPath(attachment.id)).toString(),
              }),
              catch: (cause) => toRequestError("attachment.resolve", cause),
            }),
          );
          yield* Effect.tryPromise({
            try: async () => {
              await workspace.client.session.promptAsync({
                path: { id: context.sessionId },
                body: {
                  ...(resolvedModel
                    ? {
                        model: {
                          providerID: resolvedModel.providerId,
                          modelID: resolvedModel.modelId,
                        },
                      }
                    : {}),
                  agent: agentForRuntimeMode(context.session.runtimeMode),
                  parts: [
                    ...(input.input
                      ? [
                          {
                            type: "text" as const,
                            text: input.input,
                          },
                        ]
                      : []),
                    ...attachmentParts,
                  ],
                },
                throwOnError: true,
              });
            },
            catch: (cause) => toRequestError("session.promptAsync", cause),
          });

          publish(
            toRuntimeEvent({
              eventId: makeEventId(),
              type: "turn.started",
              threadId: context.session.threadId,
              createdAt: nowIso(),
              turnId,
              payload: input.model ? { model: input.model } : {},
              raw: {
                source: "opencode.event",
                payload: {
                  sessionId: context.sessionId,
                },
              },
            }),
          );

          return {
            threadId: context.session.threadId,
            turnId,
            resumeCursor: {
              sessionId: context.sessionId,
              cwd: context.cwd,
            },
          } satisfies ProviderTurnStartResult;
        });

      const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
        Effect.gen(function* () {
          const context = getSessionContext(input.threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          return yield* sendMessage(context, input);
        });

      const steerTurn: OpenCodeAdapterShape["steerTurn"] = (input) =>
        Effect.gen(function* () {
          const context = getSessionContext(input.threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          context.activeTurnId = input.expectedTurnId;
          yield* sendMessage(context, input);
          return {
            threadId: input.threadId,
            turnId: input.expectedTurnId,
          } satisfies ProviderTurnSteerResult;
        });

      const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId) =>
        Effect.gen(function* () {
          const context = getSessionContext(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const workspace = getWorkspaceByThreadId(threadId);
          if (!workspace) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          yield* Effect.tryPromise({
            try: () =>
              workspace.client.session.abort({
                path: { id: context.sessionId },
                throwOnError: true,
              }),
            catch: (cause) => toRequestError("session.abort", cause),
          });
          if (context.activeTurnId) {
            publish(
              toRuntimeEvent({
                eventId: makeEventId(),
                type: "turn.aborted",
                threadId,
                createdAt: nowIso(),
                turnId: context.activeTurnId,
                payload: {
                  reason: "Interrupted by user.",
                },
                raw: {
                  source: "opencode.event",
                  payload: {
                    sessionId: context.sessionId,
                  },
                },
              }),
            );
            context.activeTurnId = undefined;
          }
          updateSession(context, {
            status: "ready",
            activeTurnId: context.activeTurnId,
          });
        });

      const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = (
        threadId,
        requestId,
        decision,
      ) =>
        Effect.gen(function* () {
          const context = getSessionContext(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const workspace = getWorkspaceByThreadId(threadId);
          if (!workspace) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          yield* Effect.tryPromise({
            try: () =>
              workspace.client.postSessionIdPermissionsPermissionId({
                path: {
                  id: context.sessionId,
                  permissionID: requestId,
                },
                body: {
                  response: mapApprovalDecision(decision),
                },
                throwOnError: true,
              }),
            catch: (cause) => toRequestError("session.permission.reply", cause),
          });
        });

      const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = (
        _threadId,
        _requestId,
        _answers,
      ) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "respondToUserInput",
            issue: "OpenCode does not expose structured user-input requests through this adapter.",
          }),
        );

      const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
        Effect.gen(function* () {
          const context = getSessionContext(threadId);
          if (!context) {
            return;
          }
          const workspace = getWorkspaceByThreadId(threadId);
          if (!workspace) {
            return;
          }
          yield* Effect.catchAll(interruptTurn(threadId), () => Effect.void);
          workspace.sessionsByThreadId.delete(threadId);
          workspace.threadIdBySessionId.delete(context.sessionId);
        });

      const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
        Effect.sync(() =>
          [...workspaces.values()].flatMap((workspace) =>
            [...workspace.sessionsByThreadId.values()].map((context) => context.session),
          ),
        );

      const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
        Effect.sync(() => getSessionContext(threadId) !== undefined);

      const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
        Effect.gen(function* () {
          const context = getSessionContext(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const workspace = getWorkspaceByThreadId(threadId);
          if (!workspace) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const messages = yield* Effect.tryPromise({
            try: async () =>
              unwrapData<Array<{ info: { id: string }; parts: unknown[] }>>(
                await workspace.client.session.messages({
                path: { id: context.sessionId },
                throwOnError: true,
              }),
              ),
            catch: (cause) => toRequestError("session.messages", cause),
          });
          return {
            threadId,
            turns: messages.map((message) => ({
              id: TurnId.makeUnsafe(message.info.id),
              items: message.parts,
            })),
          } satisfies ProviderThreadSnapshot;
        });

      const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
        Effect.gen(function* () {
          if (numTurns <= 0) {
            return { threadId, turns: [] } satisfies ProviderThreadSnapshot;
          }
          const context = getSessionContext(threadId);
          if (!context) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const workspace = getWorkspaceByThreadId(threadId);
          if (!workspace) {
            return yield* new ProviderAdapterSessionNotFoundError({
              provider: PROVIDER,
              threadId,
            });
          }
          const messages = yield* Effect.tryPromise({
            try: async () =>
              unwrapData<Array<{ info: { id: string; role: string }; parts: unknown[] }>>(
                await workspace.client.session.messages({
                path: { id: context.sessionId },
                throwOnError: true,
              }),
              ),
            catch: (cause) => toRequestError("session.messages", cause),
          });
          const assistantMessages = messages
            .filter((message) => message.info.role === "assistant")
            .slice(-numTurns)
            .toReversed();
          for (const message of assistantMessages) {
            yield* Effect.tryPromise({
              try: () =>
                workspace.client.session.revert({
                  path: { id: context.sessionId },
                  body: { messageID: message.info.id },
                  throwOnError: true,
                }),
              catch: (cause) => toRequestError("session.revert", cause),
            });
          }
          return {
            threadId,
            turns: assistantMessages.map((message) => ({
              id: TurnId.makeUnsafe(message.info.id),
              items: message.parts,
            })),
          } satisfies ProviderThreadSnapshot;
        });

      const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
        Effect.sync(() => {
          for (const workspace of workspaces.values()) {
            workspace.eventAbort.abort();
            workspace.stop();
          }
          workspaces.clear();
        });

      yield* Effect.addFinalizer(() => Effect.catchAll(stopAll(), () => Effect.void));

      return {
        provider: PROVIDER,
        capabilities: {
          sessionModelSwitch: "in-session",
        },
        startSession,
        sendTurn,
        steerTurn,
        interruptTurn,
        respondToRequest,
        respondToUserInput,
        stopSession,
        listSessions,
        hasSession,
        readThread,
        rollbackThread,
        stopAll,
        getCatalog,
        setApiKeyAuth,
        startOauth,
        completeOauth,
        streamEvents: Stream.fromPubSub(runtimeEvents),
      } satisfies OpenCodeAdapterShape;
    }),
  );
}

export const OpenCodeAdapterLive = makeOpenCodeAdapterLive();
