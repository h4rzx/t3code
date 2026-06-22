import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_workspaces (
      workspace_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      branch TEXT,
      worktree_path TEXT,
      local_checkout INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "workspace_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN workspace_id TEXT
    `;
  }

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
        project_id,
        project_id || ':workspace:' ||
          CASE
            WHEN NULLIF(TRIM(worktree_path), '') IS NOT NULL THEN 'worktree:' || TRIM(worktree_path)
            WHEN NULLIF(TRIM(branch), '') IS NOT NULL THEN 'branch:' || TRIM(branch)
            ELSE 'local'
          END AS workspace_id,
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
    )
    GROUP BY workspace_id
    ON CONFLICT (workspace_id)
    DO UPDATE SET
      project_id = excluded.project_id,
      branch = excluded.branch,
      worktree_path = excluded.worktree_path,
      local_checkout = excluded.local_checkout,
      created_at = MIN(projection_workspaces.created_at, excluded.created_at),
      updated_at = MAX(projection_workspaces.updated_at, excluded.updated_at)
  `;

  yield* sql`
    UPDATE projection_threads
    SET workspace_id = project_id || ':workspace:' ||
      CASE
        WHEN NULLIF(TRIM(worktree_path), '') IS NOT NULL THEN 'worktree:' || TRIM(worktree_path)
        WHEN NULLIF(TRIM(branch), '') IS NOT NULL THEN 'branch:' || TRIM(branch)
        ELSE 'local'
      END
    WHERE workspace_id IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_workspaces_project
    ON projection_workspaces(project_id, deleted_at, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_threads_workspace
    ON projection_threads(workspace_id)
  `;
});
