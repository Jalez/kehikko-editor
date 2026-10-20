import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, fsyncSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { NOT_TEXT, open, readWhole, tokenOf, tooBig } from './open.ts'
import { MAX_BYTES, SNIFF_BYTES, binary, parseToken } from './shape.ts'

/**
 * Saving one file: the only write in this program.
 *
 * ## What a save has to get past, in order
 *
 *  1. The fence and the name rule (`open`, as the page): inside the project, not
 *     inside `.git`/`.ssh`/`.aws`/`.gnupg`, not a private key.
 *  2. The file must already exist. The Editor edits files; it does not create
 *     them, so a path that does not resolve is the one refusal it always was.
 *  3. Whatever made the file read-only when it was opened still holds: another
 *     module owns it (all of `.kehikot/`), it is read-only on disk, it is not
 *     valid UTF-8, or it mixes line endings.
 *  4. The text is bounded and is text.
 *  5. **The base.** A save carries the version its edit started from. If the
 *     file on disk is no longer that version, nothing is written and the answer
 *     is a conflict carrying what is on disk now, so the page can offer a reload
 *     or a comparison. There is no "force": overwriting a changed file is a new
 *     save whose base is the version the person was shown.
 *
 * ## How it writes
 *
 * A temporary file in the SAME folder (a rename across file systems is a copy,
 * and not atomic), created exclusively (`wx`) under a name nobody else picks,
 * with the file's own permission bits, written, flushed to disk, and renamed
 * over the file. Readers see the old file or the new one, never half of one.
 * Just before the rename the file is looked at once more, and a change in that
 * window is a conflict too. Any failure removes the temporary file.
 *
 * It writes to the REAL path `inside` answered, never to the path the request
 * named, so a link is followed only to where the fence already approved.
 */

export type Saved =
  | { kind: 'saved'; version: string; unchanged: boolean }
  /** The file changed on disk since the edit began. `text` is what is there now, when it can be shown. */
  | { kind: 'conflict'; version: string; text: string | null; error: string }
  | { kind: 'refused'; error: string }

export const CONFLICT =
  'The file changed on disk since you started editing it, so nothing was saved. Reload it, or compare and save yours over it.'
export const NO_BASE = 'That save did not say which version of the file it started from, so nothing was saved.'

export function save(root: string, at: string, text: unknown, base: unknown): Saved {
  const from = parseToken(base)
  if (from === null) return { kind: 'refused', error: NO_BASE }
  if (typeof text !== 'string') return { kind: 'refused', error: 'That save carried no text.' }

  const data = Buffer.from(text, 'utf8')
  if (data.length > MAX_BYTES) return { kind: 'refused', error: tooBig(data.length) }
  if (binary(data.subarray(0, SNIFF_BYTES))) return { kind: 'refused', error: `${NOT_TEXT} Nothing was saved.` }

  /* 1–3: the file as it is now, judged exactly as opening it is judged. */
  const now = open(root, at, 'page')
  if (now.kind === 'refused') return now
  if (now.readOnly) return { kind: 'refused', error: now.readOnly }

  /* 5: the base. */
  if (now.version !== from) return { kind: 'conflict', version: now.version, text: now.text, error: CONFLICT }
  if (Buffer.from(now.text, 'utf8').equals(data)) return { kind: 'saved', version: now.version, unchanged: true }

  const real = now.path
  const mode = statSync(real).mode & 0o7777
  const temporary = join(dirname(real), `.${basename(real)}.kehikot-editor-${process.pid}-${randomBytes(6).toString('hex')}.tmp`)
  let fd: number | null = null
  try {
    fd = openSync(temporary, 'wx', mode)
    let written = 0
    while (written < data.length) written += writeSync(fd, data, written, data.length - written)
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    /* The umask may have narrowed the mode `openSync` was given. */
    chmodSync(temporary, mode)

    /* The last look: a change between reading the base and here is a conflict, not an overwrite. */
    const last = readWhole(real)
    if (!last.ok || tokenOf(last.bytes, last.stat) !== from) {
      rmSync(temporary, { force: true })
      const again = open(root, at, 'page')
      return again.kind === 'text'
        ? { kind: 'conflict', version: again.version, text: again.text, error: CONFLICT }
        : { kind: 'refused', error: again.error }
    }

    renameSync(temporary, real)
  } catch (error) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* Already closed. */
      }
    }
    rmSync(temporary, { force: true })
    const code = (error as NodeJS.ErrnoException).code
    return {
      kind: 'refused',
      error: code === 'EACCES' || code === 'EPERM'
        ? 'The folder this file is in cannot be written to, so nothing was saved.'
        : 'The file could not be saved, and it was left as it was.',
    }
  }

  const after = readWhole(real)
  if (!after.ok) return { kind: 'refused', error: after.error }
  return { kind: 'saved', version: tokenOf(after.bytes, after.stat), unchanged: false }
}
