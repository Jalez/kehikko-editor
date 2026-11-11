import { DOCUMENT_PROPOSALS, documentsFolder } from 'kehikot-module-protocol'
import { findService } from 'kehikot-module-protocol/serve'

/**
 * The module that keeps a document per epic and takes edits to it only as proposals
 * (`document.proposals`, protocol 2.83.0), as far as the Editor needs it: what it is called, the
 * folder every epic's document is under, and the main file that marks one. Found through the host,
 * never named here.
 *
 * Opening and saving judge a file synchronously, so they read `knownDocument()`; the doors call
 * `lookForDocument()` first, which asks the host at most once every `FRESH_MS` and never throws.
 * With no provider (none in use, or a host too old to say), the generic rule in `owned.ts` still
 * keeps everything under `.kehikot/` read-only.
 */
export interface DocumentOwner {
  /** What it is called where it is told about: the descriptor's `name`. */
  name: string
  /** The folder every epic's document is under, relative to the project. */
  folder: string
  /** The document's main file, relative to an epic's folder. */
  main: string
}

const FRESH_MS = 30_000
const ASK_MS = 2_000

let known: DocumentOwner | null = null
let askedAt = 0
let asking: Promise<void> | null = null

/** The document provider as last found, or null. */
export function knownDocument(): DocumentOwner | null {
  return known
}

/** For tests: say what was found, and keep the host from being asked again for `freshFor` ms. */
export function setKnownDocument(owner: DocumentOwner | null, freshFor = FRESH_MS): void {
  known = owner
  askedAt = Date.now() - FRESH_MS + freshFor
}

/** Ask the host who keeps documents, when the last answer is stale. Never throws. */
export async function lookForDocument(module: string): Promise<void> {
  if (Date.now() - askedAt < FRESH_MS) return
  if (asking) return asking
  asking = (async () => {
    try {
      const found = await findService(DOCUMENT_PROPOSALS, { module, timeoutMs: ASK_MS })
      if (found.ok) {
        const { descriptor } = found.provider
        const folder = documentsFolder(descriptor)
        known = folder ? { name: descriptor.name, folder, main: descriptor.main } : null
      } else {
        known = null
      }
    } catch {
      known = null
    } finally {
      askedAt = Date.now()
      asking = null
    }
  })()
  return asking
}
