import { useMemo } from 'react'

import { pickedParts } from 'kehikot-module-protocol'
import { useHost, type Host as ProtocolHost } from 'kehikot-module-protocol/client/react'
import type { HostEvents } from 'kehikot-module-protocol/client'

import { ID } from '../../manifest.ts'

/**
 * What the screen needs from the host: the protocol's `useHost` — which has
 * already put the theme on <html> and flattened the context — plus whatever
 * this module derives from it. A plain object, so a screen can be rendered in
 * a test without a host (see `Host`).
 */
export interface Host extends Pick<ProtocolHost, 'where' | 'project' | 'projectPath' | 'epic' | 'theme' | 'request' | 'header'> {
  /**
   * The headings of the parts of the epic the person picked out in the host's
   * bar. Empty means the whole epic. A module that narrows to these has to SAY
   * it narrowed — see `context.parts`, `refInFocus`, `partInFocus` and
   * `fileInFocus` in the protocol.
   */
  focus: string[]
}

export function useKehikot(events: HostEvents = {}): Host {
  const host = useHost(ID, events)
  const focus = useMemo(() => pickedParts(host.parts).map((part) => part.heading || part.id), [host.parts])
  return useMemo(() => ({ ...host, focus }), [host, focus])
}
