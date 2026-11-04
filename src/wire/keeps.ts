import { useMemo, useRef, useState } from 'react'

import type { KeepsFor } from 'kehikot-module-protocol/client/react'

/**
 * What `useKept` writes this container's view through: the host's kept value when there is a host,
 * and otherwise a plain local one, so a screen drawn in a test without a host still switches.
 *
 * The host keeps it per container — this module on this kehikko — and gives it back in the
 * greeting, so the view is as it was left after a restart. Never browser storage.
 */
export function useKeeps(host: Partial<KeepsFor>): KeepsFor {
  const [local, setLocal] = useState<unknown>(null)
  const now = useRef(local)
  now.current = local
  const { kept, read, remember } = host
  return useMemo<KeepsFor>(
    () =>
      read && remember
        ? { kept, read, remember }
        : {
            kept: local,
            read: () => ({ kept: now.current }),
            remember: ((next: unknown) => {
              now.current = next
              setLocal(next)
            }) as KeepsFor['remember'],
          },
    [kept, read, remember, local],
  )
}
