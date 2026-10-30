export type ThreadFacts = {
  id: string;
  archivedAt: number | null;
  deletedAt: number | null;
  visibility: string;
  originPluginId: string | null;
  parentThreadId: string | null;
  environmentId: string | null;
};

/** Forks by the user and child threads count; plugin-spawned threads don't. */
export function isEligible(thread: ThreadFacts): boolean {
  return (
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.visibility === "visible" &&
    thread.originPluginId === null
  );
}

/** A URL claim is branch-bound only when it names the checkout's own PR. */
export function branchBound(hasUrl: boolean, url: string, checkoutUrl: string | null): boolean {
  return !hasUrl || url === checkoutUrl;
}

export function claimKind(existingOwner: string | null, threadId: string): "enroll" | "same" | "transfer" {
  if (existingOwner === null) return "enroll";
  return existingOwner === threadId ? "same" : "transfer";
}

/** The nearest eligible parent, if it is in the same environment. */
export async function findHandoff(
  owner: ThreadFacts,
  environmentId: string,
  load: (threadId: string) => Promise<ThreadFacts | null>,
): Promise<string | null> {
  const visited = new Set([owner.id]);
  let parentId = owner.parentThreadId;
  while (parentId !== null && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = await load(parentId);
    if (!parent) return null;
    if (isEligible(parent)) return parent.environmentId === environmentId ? parent.id : null;
    parentId = parent.parentThreadId;
  }
  return null;
}
