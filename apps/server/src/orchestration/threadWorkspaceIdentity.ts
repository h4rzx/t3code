export interface ThreadWorkspaceIdentity {
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
