import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { KEHIKOT_DIR } from 'kehikot-module-protocol'

import { contains } from './confine.ts'

/**
 * Files another program owns, which this app opens read-only and says whose they are.
 *
 * ## All of `.kehikot/`
 *
 * Every module keeps a project's data in `<project>/.kehikot/<module>/`, and each
 * one is the only writer of its folder: Paper's LaTeX sources (which Paper edits
 * through its proposals, so a change is shown for review), Notes' notes, the
 * journeys, the host's own epics and `project.json`. A save from here would be a
 * second writer the owner does not know about, racing its own atomic writes and
 * skipping its review. So nothing under `.kehikot/` is saved here, whoever owns
 * it, and the sentence names the owner so the remedy is plain.
 *
 * ## Judged as written and as resolved, and Paper's folders by where they lead
 *
 * A link with a plain name into `.kehikot/` is judged by what it leads to (the
 * real path), and a path written under `.kehikot/` is judged by its name even
 * when it resolves elsewhere. A paper folder that is itself a link to a folder
 * elsewhere in the project (`.kehikot/paper/thesis -> thesis/`) makes every file
 * in that folder Paper's too.
 */

/** The folder names under `.kehikot/` with an owner worth naming in words. */
const NAMES: Record<string, string> = {
  paper: 'Paper',
  notes: 'Notes',
  journeys: 'Journeys',
  slides: 'Slides',
  checklist: 'Checklist',
  learning: 'Learning',
  citations: 'Citations',
  host: 'the Kehikot app',
  kehikko: 'the Kehikot app',
}

/** The sentence for one owner. Never markup: a folder name goes in as text. */
export function ownedSentence(folder: string): string {
  if (folder === 'paper') {
    return 'This is Paper’s LaTeX source. Paper edits it through its proposals, so a change is shown for review there; '
      + 'it is read-only here. Change it in Paper.'
  }
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

/**
 * Why the file at `real` (an absolute real path inside `realRoot`) is read-only
 * because somebody else owns it, or null. `written` is the path as the request
 * named it.
 */
export function ownedBy(realRoot: string, real: string, written: string): string | null {
  const asResolved = ownerFolder(relative(realRoot, real))
  if (asResolved !== null) return ownedSentence(asResolved)
  const asWritten = ownerFolder(written.startsWith('/') ? relative(realRoot, written) : written)
  if (asWritten !== null) return ownedSentence(asWritten)
  for (const paperDir of paperFolders(realRoot)) {
    if (contains(paperDir, real)) return ownedSentence('paper')
  }
  return null
}

/**
 * The real folders of the project's papers: each `.kehikot/paper/<epic>/` that
 * holds a `main.tex`, resolved. One directory read; nothing is cached, because a
 * paper started a second ago is Paper's a second ago.
 */
function paperFolders(realRoot: string): string[] {
  const papers = join(realRoot, KEHIKOT_DIR, 'paper')
  let entries: string[]
  try {
    entries = readdirSync(papers)
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.slice(0, 256)) {
    try {
      const at = realpathSync(join(papers, entry))
      if (!existsSync(join(at, 'main.tex'))) continue
      /* A paper folder that leads outside the project owns nothing here to protect. */
      if (contains(realRoot, at) && at !== realRoot) out.push(at.endsWith(sep) ? at.slice(0, -1) : at)
    } catch {
      /* Unresolvable: not a paper this app can see. */
    }
  }
  return out
}
