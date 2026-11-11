import { MODULE_FOLDERS, foldersOwned } from 'kehikot-module-protocol'
import { askHost } from 'kehikot-module-protocol/serve'

/**
 * Who owns each folder under `.kehikot/`, as the modules in use declare it (`module.folders`,
 * protocol 2.85.0): the folder name, the owner's name and its one line about what is in it. Found
 * through the host, never written here, so a file's sentence names its owner without the Editor
 * naming any module.
 *
 * Kept like the document provider (`document.ts`): opening and saving read `knownFolders()`
 * synchronously; the doors call `lookForFolders()` first, which asks the host at most once every
 * `FRESH_MS` and never throws. A folder nobody declares is "the <folder> module".
 */
export interface FolderOwner {
  /** The owner's name, as its descriptor says it. */
  name: string
  /** What is in the folder, in one line. */
  says: string
}

const FRESH_MS = 30_000
const ASK_MS = 2_000

let known = new Map<string, FolderOwner>()
let askedAt = 0
let asking: Promise<void> | null = null

/** The folders' owners as last found; empty when none were. */
export function knownFolders(): ReadonlyMap<string, FolderOwner> {
  return known
}

/** For tests: say what was found, and keep the host from being asked again for `freshFor` ms. */
export function setKnownFolders(owners: Record<string, FolderOwner>, freshFor = FRESH_MS): void {
  known = new Map(Object.entries(owners))
  askedAt = Date.now() - FRESH_MS + freshFor
}

/** Ask the host who owns which folder, when the last answer is stale. Never throws. */
export async function lookForFolders(module: string): Promise<void> {
  if (Date.now() - askedAt < FRESH_MS) return
  if (asking) return asking
  asking = (async () => {
    try {
      const asked = await askHost('services.find', { service: MODULE_FOLDERS }, { module, timeoutMs: ASK_MS })
      const next = new Map<string, FolderOwner>()
      if (asked.ok) {
        for (const [folder, owner] of foldersOwned(asked.data.providers)) next.set(folder, { name: owner.name, says: owner.says })
      }
      known = next
    } catch {
      known = new Map()
    } finally {
      askedAt = Date.now()
      asking = null
    }
  })()
  return asking
}
