import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE projection_threads
    SET workspace_id = project_id || ':workspace:' ||
      CASE
        WHEN NULLIF(TRIM(worktree_path), '') IS NOT NULL THEN 'worktree:' || TRIM(worktree_path)
        WHEN NULLIF(TRIM(branch), '') IS NOT NULL THEN 'branch:' || TRIM(branch)
        ELSE 'local'
      END
  `;

  yield* sql`DELETE FROM projection_workspaces`;

  yield* sql`
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
    SELECT
      workspace_id,
      project_id,
      branch,
      worktree_path,
      local_checkout,
      MIN(created_at) AS created_at,
      MAX(updated_at) AS updated_at,
      NULL AS archived_at,
      NULL AS deleted_at
    FROM (
      SELECT
        workspace_id,
        project_id,
        CASE
          WHEN NULLIF(TRIM(branch), '') IS NOT NULL THEN TRIM(branch)
          ELSE NULL
        END AS branch,
        CASE
          WHEN NULLIF(TRIM(worktree_path), '') IS NOT NULL THEN TRIM(worktree_path)
          ELSE NULL
        END AS worktree_path,
        CASE
          WHEN NULLIF(TRIM(worktree_path), '') IS NULL THEN 1
          ELSE 0
        END AS local_checkout,
        created_at,
        updated_at
      FROM projection_threads
      WHERE deleted_at IS NULL
        AND workspace_id IS NOT NULL
    )
    GROUP BY workspace_id
  `;
});
