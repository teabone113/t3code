import { Effect, Layer, ServiceMap } from "effect";
import type { Scope } from "effect";

export interface SupervisorReactorShape {
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class SupervisorReactor extends ServiceMap.Service<
  SupervisorReactor,
  SupervisorReactorShape
>()("t3/orchestration/Services/SupervisorReactor") {}

export const SupervisorReactorNoop = Layer.succeed(SupervisorReactor, {
  start: Effect.void,
} satisfies SupervisorReactorShape);
