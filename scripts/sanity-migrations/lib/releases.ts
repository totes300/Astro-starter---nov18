// Which release versions a migration may write: Sanity refuses every write to a version whose release is not active.

import { buildReleasesQuery, type Release, releaseLock } from "../../trim-features/language-removal";

export { buildReleasesQuery, type Release, releaseLock };

/** Splits planned writes into those Sanity accepts and those it would refuse, with the reason. */
export function partitionLocked<T extends { id: string }>(
  writes: readonly T[],
  releases: readonly Release[]
): { open: T[]; locked: { id: string; reason: string }[] } {
  const open: T[] = [];
  const locked: { id: string; reason: string }[] = [];

  for (const write of writes) {
    const reason = releaseLock(write.id, releases);

    if (reason) {
      locked.push({ id: write.id, reason });
    } else {
      open.push(write);
    }
  }

  return { open, locked };
}
