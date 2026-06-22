import { IsoDateTime, ProjectId, WorkspaceId, NonNegativeInt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionWorkspace = Schema.Struct({
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  localCheckout: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionWorkspace = typeof ProjectionWorkspace.Type;

export const GetProjectionWorkspaceInput = Schema.Struct({
  workspaceId: WorkspaceId,
});
export type GetProjectionWorkspaceInput = typeof GetProjectionWorkspaceInput.Type;

export interface ProjectionWorkspaceRepositoryShape {
  readonly upsert: (
    workspace: ProjectionWorkspace,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getById: (
    input: GetProjectionWorkspaceInput,
  ) => Effect.Effect<Option.Option<ProjectionWorkspace>, ProjectionRepositoryError>;
}

export class ProjectionWorkspaceRepository extends Context.Service<
  ProjectionWorkspaceRepository,
  ProjectionWorkspaceRepositoryShape
>()("t3/persistence/Services/ProjectionWorkspaces/ProjectionWorkspaceRepository") {}
