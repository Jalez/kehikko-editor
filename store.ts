import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'

import { kehikotDir, moduleDir, moduleFile, within } from 'kehikot-module-protocol'

import { ID } from './manifest.ts'

/**
 * This module's material, kept inside the project it is about:
 * `<projectPath>/.kehikot/editor/value.json`.
 *
 * The folder and the join are the protocol's (`moduleFile`), so every module
 * agrees on where data lives. There is no default project: with no projectPath
 * every read is empty and every write is refused, because a guessed folder is
 * one where work is written and never seen again.
 *
 * Both sides are realpath'd before the containment check, so a `.kehikot` that
 * is a symlink out of the project is refused rather than followed.
 */
export const FILE = 'value'

export type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const NO_PROJECT =
  'Nothing has said which project this is, so there is nowhere to keep anything. Open a project in the host, '
  + 'or send projectPath.'

/** The stored value for one project, or null when nothing is stored yet. */
export function readValue(projectPath: string | null | undefined): Result<unknown> {
  const file = fileFor(projectPath, false)
  if (!file.ok) return file
  if (!existsSync(file.value)) return { ok: true, value: null }
  try {
    const parsed = JSON.parse(readFileSync(file.value, 'utf8')) as { value?: unknown }
    return { ok: true, value: parsed.value ?? null }
  } catch {
    return { ok: false, error: `${file.value} is not readable JSON. Nothing was changed; fix or remove the file.` }
  }
}

/** Replace the stored value. Written to a temporary file and renamed, so a crash never leaves half a file. */
export function writeValue(projectPath: string | null | undefined, value: unknown): Result<null> {
  const file = fileFor(projectPath, true)
  if (!file.ok) return file
  const temporary = `${file.value}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ value, at: new Date().toISOString() }, null, 2)}\n`)
  renameSync(temporary, file.value)
  return { ok: true, value: null }
}

/** The data file's path, checked to resolve inside the project. `make` creates the folder first. */
function fileFor(projectPath: string | null | undefined, make: boolean): Result<string> {
  const root = projectRoot(projectPath)
  if (!root.ok) return root

  const dir = moduleDir(root.value, ID)!
  const levels = [kehikotDir(root.value)!, dir]
  /* Checked before making anything, so a folder that escapes is never written
     into, and again after, for what mkdir just made. */
  const escaped = escapesAny(root.value, levels)
  if (escaped) return { ok: false, error: escaped }
  if (make) {
    mkdirSync(dir, { recursive: true })
    const after = escapesAny(root.value, levels)
    if (after) return { ok: false, error: after }
  }
  const file = moduleFile(root.value, ID, FILE)!
  if (existsSync(file)) {
    const escaped = escapes(root.value, file)
    if (escaped) return { ok: false, error: escaped }
  }
  return { ok: true, value: file }
}

function projectRoot(projectPath: string | null | undefined): Result<string> {
  const raw = typeof projectPath === 'string' ? projectPath.trim() : ''
  if (!raw) return { ok: false, error: NO_PROJECT }
  if (!isAbsolute(raw)) return { ok: false, error: `"${raw}" is not an absolute path.` }
  try {
    const real = realpathSync(raw)
    if (!statSync(real).isDirectory()) return { ok: false, error: `"${raw}" is not a folder.` }
    return { ok: true, value: real }
  } catch {
    return { ok: false, error: `there is no folder at "${raw}" on this machine.` }
  }
}

function escapesAny(root: string, paths: string[]): string | null {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const escaped = escapes(root, path)
    if (escaped) return escaped
  }
  return null
}

function escapes(root: string, child: string): string | null {
  let real: string
  try {
    real = realpathSync(child)
  } catch {
    return `${child} could not be resolved, so nothing is read or written through it.`
  }
  return within(root, real) ? null : `${child} resolves to ${real}, outside the project. Refused rather than followed.`
}
