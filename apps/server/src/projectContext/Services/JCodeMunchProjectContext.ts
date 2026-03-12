import type { ProjectBuildContextInput, ProjectBuildContextResult } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

export interface JCodeMunchProjectContextShape {
  readonly buildContext: (
    input: ProjectBuildContextInput,
  ) => Effect.Effect<ProjectBuildContextResult, never>;
}

export class JCodeMunchProjectContext extends ServiceMap.Service<
  JCodeMunchProjectContext,
  JCodeMunchProjectContextShape
>()("t3/projectContext/Services/JCodeMunchProjectContext") {}
