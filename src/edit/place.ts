/**
 * The place the person stands in, as far as the Editor needs to tell one from another.
 *
 * A place is the space the host says (`context.space`, protocol 2.89.0): its path of ids from the
 * top-level space and the children picked out together. A host from before spaces says only an epic
 * and its picked parts, which is the same place by the protocol's own mapping: the epic is the
 * top-level space, one picked part is that child, several are the epic with those picked. Both spell
 * the same key for every place an older host can name.
 */
export interface Place {
  epic?: string | null
  /** The ids of the parts picked out; empty is the whole epic. */
  parts?: readonly string[]
  space?: { path: readonly { id: string }[]; picked?: readonly string[] } | null
}

const sorted = (ids: readonly string[]) => [...new Set(ids)].sort()

/** The key of a place: equal for the same place from either kind of host, `project` for none. */
export function placeKey(place: Place): string {
  const said = place.space?.path.map((step) => step.id) ?? []
  let ids: string[]
  let picked: string[]
  if (said.length) {
    ids = said
    picked = sorted(place.space?.picked ?? [])
  } else if (place.epic) {
    const parts = sorted(place.parts ?? [])
    ;[ids, picked] = parts.length === 1 ? [[place.epic, parts[0]!], []] : [[place.epic], parts]
  } else return 'project'
  return picked.length ? `${ids.join('.')}|${picked.join(',')}` : ids.join('.')
}
