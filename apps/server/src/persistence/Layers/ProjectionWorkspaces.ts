import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionWorkspaceInput,
  ProjectionWorkspace,
  ProjectionWorkspaceRepository,
  type ProjectionWorkspaceRepositoryShape,
} from "../Services/ProjectionWorkspaces.ts";

const makeProjectionWorkspaceRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionWorkspaceRow = SqlSchema.void({
    Request: ProjectionWorkspace,
    execute: (row) =>
      sql`
        INSERT INTO projection_workspaces (
          workspace_id,
          project_id,
          branch,
          worktree_path,
          local_checkout,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          ${row.workspaceId},
          ${row.projectId},
          ${row.branch},
          ${row.worktreePath},
          ${row.localCheckout},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (workspace_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          local_checkout = excluded.local_checkout,
          created_at = MIN(projection_workspaces.created_at, excluded.created_at),
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionWorkspaceRow = SqlSchema.findOneOption({
    Request: GetProjectionWorkspaceInput,
    Result: ProjectionWorkspace,
    execute: ({ workspaceId }) =>
      sql`
        SELECT
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          branch,
          worktree_path AS "worktreePath",
          local_checkout AS "localCheckout",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          deleted_at AS "deletedAt"
        FROM projection_workspaces
        WHERE workspace_id = ${workspaceId}
      `,
  });

  const upsert: ProjectionWorkspaceRepositoryShape["upsert"] = (row) =>
    upsertProjectionWorkspaceRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.upsert:query")),
    );

  const getById: ProjectionWorkspaceRepositoryShape["getById"] = (input) =>
    getProjectionWorkspaceRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionWorkspaceRepository.getById:query")),
    );

  return {
    upsert,
    getById,
  } satisfies ProjectionWorkspaceRepositoryShape;
});

export const ProjectionWorkspaceRepositoryLive = Layer.effect(
  ProjectionWorkspaceRepository,
  makeProjectionWorkspaceRepository,
);
