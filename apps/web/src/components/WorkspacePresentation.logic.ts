export function resolveDefaultWorkspaceTitle(input: {
  branch: string | null;
  worktreePath: string | null;
}): string {
  const branch = input.branch?.trim();
  if (branch) {
    return branch;
  }

  const worktreePath = input.worktreePath?.trim();
  if (worktreePath) {
    const normalized = worktreePath.replace(/[/\\]+$/u, "");
    const folderName = normalized.match(/[^/\\]+$/u)?.[0]?.trim();
    if (folderName) {
      return folderName;
    }
  }

  return "Local workspace";
}
