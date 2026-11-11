import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { KEHIKOT_DIR } from 'kehikot-module-protocol'

import { contains } from './confine.ts'
import { knownDocument, type DocumentOwner } from './document.ts'

/**
 * Files another program owns, which this app opens read-only and says whose they are.
 *
 * ## All of `.kehikot/`
 *
 * Every module keeps a project's data in `<project>/.kehikot/<module>/`, and each
 * one is the only writer of its folder: a document that takes edits only as
 * proposals (so a change is shown for review), notes, journeys, the host's own
 * epics and `project.json`. A save from here would be a second writer the owner
 * does not know about, racing its own atomic writes and skipping its review. So
 * nothing under `.kehikot/` is saved here, whoever owns it, and the sentence names
 * the owner where it can so the remedy is plain.
 *
 * ## The document provider, by where its folders lead
 *
 * The module that provides `document.proposals` (found through the host, see
 * `document.ts`; never named here) says where its documents live. A file under
 * that folder is its, by the path as written or as resolved, and an epic's folder
 * there that is itself a link to a folder elsewhere in the project (holding the
 * document's main file) makes every file in that folder its too. With no provider
 * the generic `.kehikot/` rule below still holds.
 *
 * ## Judged as written and as resolved
 *
 * A link with a plain name into `.kehikot/` is judged by what it leads to (the
 * real path), and a path written under `.kehikot/` is judged by its name even
 * when it resolves elsewhere.
 */

/** The folder names under `.kehikot/` with an owner worth naming in words. */
const NAMES: Record<string, string> = {
  notes: 'Notes',
  journeys: 'Journeys',
  slides: 'Slides',
  checklist: 'Checklist',
  learning: 'Learning',
  citations: 'Citations',
  host: 'the Kehikot app',
  kehikko: 'the Kehikot app',
}

/** The sentence for the document provider's files, in its own name. Never markup. */
export function documentSentence(name: string): string {
  const owner = name.slice(0, 64)
  return `${owner} keeps this file and takes changes to it as proposals, so it is read-only here; suggest changes there.`
}

/** The sentence for one owner. Never markup: a folder name goes in as text. */
export function ownedSentence(folder: string): string {
  if (folder === '' || folder === 'project.json') {
    return 'This file is the Kehikot app’s own record of the project. It is read-only here.'
  }
  const owner = NAMES[folder] ?? `the ${folder.slice(0, 64)} module`
  return `This file belongs to ${owner}, which keeps it in ${KEHIKOT_DIR}/${folder.slice(0, 64)}/ and is its only writer. `
    + `It is read-only here; change it in ${owner}.`
}

/** The owner folder of a project-relative path under `.kehikot/`, or null when it is not under it. */
export function ownerFolder(relativePath: string): string | null {
  const segments = relativePath.replace(/\\/g, '/').split('/').filter((one) => one && one !== '.')
  if (segments[0] !== KEHIKOT_DIR) return null
  /* `.kehikot` itself, and `.kehikot/project.json`, are the host's; anything deeper is its folder's. */
  return segments[1] ?? ''
}

/** Whether a project-relative path is inside the project-relative folder `folder`. */
function under(folder: string, relativePath: string): boolean {
  const want = folder.replace(/\\/g, '/').split('/').filter((one) => one && one !== '.')
  const have = relativePath.replace(/\\/g, '/').split('/').filter((one) => one && one !== '.')
  return want.length > 0 && have.length > want.length && want.every((one, i) => have[i] === one)
}

/**
 * Why the file at `real` (an absolute real path inside `realRoot`) is read-only
 * because somebody else owns it, or null. `written` is the path as the request
 * named it. `document` is the document provider as last found.
 */
export function ownedBy(realRoot: string, real: string, written: string, document: DocumentOwner | null = knownDocument()): string | null {
  const resolved = relative(realRoot, real)
  const asNamed = written.startsWith('/') ? relative(realRoot, written) : written
  if (document) {
    if (under(document.folder, resolved) || under(document.folder, asNamed)) return documentSentence(document.name)
    for (const dir of documentFolders(realRoot, document)) {
      if (contains(dir, real)) return documentSentence(document.name)
    }
  }
  const asResolved = ownerFolder(resolved)
  if (asResolved !== null) return ownedSentence(asResolved)
  const asWritten = ownerFolder(asNamed)
  if (asWritten !== null) return ownedSentence(asWritten)
  return null
}

/**
 * The real folders of the project's documents: each `<folder>/<epic>/` that holds
 * the main file, resolved. One directory read; nothing is cached, because a
 * document started a second ago is its owner's a second ago.
 */
function documentFolders(realRoot: string, document: DocumentOwner): string[] {
  const documents = join(realRoot, document.folder)
  if (!contains(realRoot, documents)) return []
  let entries: string[]
  try {
    entries = readdirSync(documents)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.slice(0, 256)) {
    try {
      const at = realpathSync(join(documents, entry))
      if (!existsSync(join(at, document.main))) continue
      /* A document folder that leads outside the project owns nothing here to protect. */
      if (contains(realRoot, at) && at !== realRoot) out.push(at.endsWith(sep) ? at.slice(0, -1) : at)
    } catch {
      /* Unresolvable: not a document this app can see. */
    }
  }
  return out
}
