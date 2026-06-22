import { ProjectId, WorkspaceId } from "@t3tools/contracts";

export interface ThreadWorkspaceIdentity {
  readonly workspaceId?: string | null | undefined;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface ThreadWorkspaceIdentityPatch {
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}

export interface ResolvedThreadWorkspaceIdentityPatch {
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
}

export interface ResolvedThreadWorkspaceRecordForPatch {
  readonly patch: ResolvedThreadWorkspaceIdentityPatch;
  readonly workspace?: ThreadWorkspaceRecord;
}

export interface ThreadWorkspaceRecord {
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly localCheckout: 0 | 1;
}

function normalizeWorkspaceContextValue(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function deriveThreadWorkspaceRecord(input: {
  readonly projectId: ProjectId;
  readonly workspaceId?: string | null | undefined;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): ThreadWorkspaceRecord {
  const branch = normalizeWorkspaceContextValue(input.branch);
  const worktreePath = normalizeWorkspaceContextValue(input.worktreePath);
  const contextKey = worktreePath
    ? `worktree:${worktreePath}`
    : branch
      ? `branch:${branch}`
      : "local";

  return {
    workspaceId: WorkspaceId.make(
      input.workspaceId ?? `${input.projectId}:workspace:${contextKey}`,
    ),
    projectId: input.projectId,
    branch,
    worktreePath,
    localCheckout: worktreePath === null ? 1 : 0,
  };
}

export function resolveThreadWorkspaceIdentityPatch(
  thread: ThreadWorkspaceIdentity,
  patch: ThreadWorkspaceIdentityPatch,
): ResolvedThreadWorkspaceIdentityPatch {
  if (thread.worktreePath !== null && patch.worktreePath === null) {
    return {};
  }

  return {
    ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
    ...(patch.worktreePath !== undefined ? { worktreePath: patch.worktreePath } : {}),
  };
}

export function resolveThreadWorkspaceRecordForPatch(input: {
  readonly projectId: ProjectId;
  readonly thread: ThreadWorkspaceIdentity;
  readonly patch: ThreadWorkspaceIdentityPatch;
}): ResolvedThreadWorkspaceRecordForPatch {
  const resolvedPatch = resolveThreadWorkspaceIdentityPatch(input.thread, input.patch);
  if (resolvedPatch.branch === undefined && resolvedPatch.worktreePath === undefined) {
    return { patch: resolvedPatch };
  }

  const previousWorktreePath = normalizeWorkspaceContextValue(input.thread.worktreePath);
  const nextWorktreePath = normalizeWorkspaceContextValue(
    resolvedPatch.worktreePath !== undefined
      ? resolvedPatch.worktreePath
      : input.thread.worktreePath,
  );
  const nextBranch =
    resolvedPatch.branch !== undefined ? resolvedPatch.branch : input.thread.branch;
  const preserveWorkspaceId =
    previousWorktreePath !== null &&
    nextWorktreePath !== null &&
    previousWorktreePath === nextWorktreePath;

  return {
    patch: resolvedPatch,
    workspace: deriveThreadWorkspaceRecord({
      projectId: input.projectId,
      ...(preserveWorkspaceId ? { workspaceId: input.thread.workspaceId } : {}),
      branch: nextBranch,
      worktreePath: nextWorktreePath,
    }),
  };
}
