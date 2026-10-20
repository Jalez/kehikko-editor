import { createHash } from 'node:crypto'
import { accessSync, closeSync, constants, fstatSync, openSync, readSync, type Stats } from 'node:fs'
import { relative } from 'node:path'

import { inside } from './confine.ts'
import { ownedBy } from './owned.ts'
import { MAX_BYTES, SNIFF_BYTES, binary, bytes, tongue, versionToken, type Reading } from './shape.ts'
import { WITHHELD, WITHHELD_PAGE, withheld, withheldFrom, type Asker } from './withheld.ts'

/**
 * Opening one file for editing: the fence, the owner, the bound, and the version.
 *
 * The file is read WHOLE or not at all — an editor that saved a window would cut
 * the rest of the file off — through a descriptor, into a buffer this module
 * sized, never more than `MAX_BYTES + 1` bytes. The size and the modification
 * time come from `fstat` on the same descriptor the bytes come from, so the
 * version describes exactly the bytes that were read.
 */

/**
 * The one refusal for "outside the project", "does not exist" and "cannot be
 * read" — one sentence, because three would be an oracle. See `confine.ts`.
 */
export const REFUSED = 'That file is not somewhere this app can look.'

/** Where a file is, once it has passed the fence and the name rule. */
export interface Located {
  ok: true
  /** The real path, inside the real root. The only path anything here reads or writes. */
  real: string
  /** Relative to the root, forward slashes. */
  relative: string
  hidden: boolean
}

/** Run the fence and the name rule over a path a request named. */
export function locate(root: string, at: string, who: Asker): Located | { ok: false; error: string } {
  const sentence = who === 'page' ? WITHHELD_PAGE : WITHHELD
  /* As written, before the disk is touched; then as resolved. */
  if (withheldFrom(at, who)) return { ok: false, error: sentence }
  const real = inside(root, at)
  if (real === null) return { ok: false, error: REFUSED }
  const inner = relative(root, real)
  if (!inner || withheldFrom(inner, who)) return { ok: false, error: inner ? sentence : REFUSED }
  return { ok: true, real, relative: inner.split('\\').join('/'), hidden: who === 'page' && (withheld(inner) || withheld(at)) }
}

/** The bytes of a file and the stat they were read under, or a refusal. */
export type Bytes = { ok: true; bytes: Buffer; stat: Stats } | { ok: false; error: string }

/** Read a regular file whole, bounded. The descriptor is opened `'r'`, spelled out. */
export function readWhole(real: string): Bytes {
  let fd: number
  try {
    fd = openSync(real, 'r')
  } catch {
    return { ok: false, error: REFUSED }
  }
  try {
    const stat = fstatSync(fd)
    if (stat.isDirectory()) return { ok: false, error: 'That is a folder. The Editor opens one file at a time.' }
    /* A socket, a fifo, a device: reading one could block this server forever. */
    if (!stat.isFile()) return { ok: false, error: REFUSED }
    if (stat.size > MAX_BYTES) return { ok: false, error: tooBig(stat.size) }
    /* One byte more than the bound, so a file that grew since `fstat` is caught rather than cut. */
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_BYTES) + 1)
    let got = 0
    while (got < buffer.length) {
      const n = readSync(fd, buffer, got, buffer.length - got, got)
      if (n <= 0) break
      got += n
    }
    if (got > MAX_BYTES) return { ok: false, error: tooBig(got) }
    return { ok: true, bytes: buffer.subarray(0, got), stat }
  } catch {
    return { ok: false, error: REFUSED }
  } finally {
    closeSync(fd)
  }
}

export function tooBig(size: number): string {
  return `That file is ${bytes(size)}. The Editor opens files up to ${bytes(MAX_BYTES)}, whole; open this one in your own editor.`
}

export const NOT_TEXT = 'That file is not text, so there is nothing here to edit. Open it with a program made for it.'

/** sha256, hex. */
export function hashOf(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The version of bytes read under a stat. */
export function tokenOf(data: Uint8Array, stat: Stats): string {
  return versionToken({ size: data.length, mtimeMs: stat.mtimeMs, hash: hashOf(data) })
}

/** The line ending a text uses, or null when it mixes them (or has a lone carriage return). */
export function eolOf(text: string): '\n' | '\r\n' | null {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i)
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf += 1
        i += 1
      } else cr += 1
    } else if (c === 10) lf += 1
  }
  if (cr > 0 || (crlf > 0 && lf > 0)) return null
  return crlf > 0 ? '\r\n' : '\n'
}

export const MIXED_EOL =
  'This file mixes line endings, and the editor would even them out when saving — a change to every line you did not touch. '
  + 'It is read-only here.'
export const NOT_UTF8 =
  'This file is not valid UTF-8, so saving it from here would change bytes you did not edit. It is read-only here.'
export const READ_ONLY_ON_DISK = 'This file is marked read-only on disk, so the Editor will not save it.'

/** Whether this process may write the file, by its mode and by the system's own answer. */
function writable(real: string, stat: Stats): boolean {
  if ((stat.mode & 0o222) === 0) return false
  try {
    accessSync(real, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Open a file for editing. `who` is `'page'` for the person's own ticketed page
 * and `'agent'` for anything else (the MCP door).
 */
export function open(root: string, at: string, who: Asker = 'agent'): Reading {
  const where = locate(root, at, who)
  if (!where.ok) return { kind: 'refused', error: where.error }
  const read = readWhole(where.real)
  if (!read.ok) return { kind: 'refused', error: read.error }
  if (binary(read.bytes.subarray(0, SNIFF_BYTES))) return { kind: 'refused', error: NOT_TEXT }

  const text = read.bytes.toString('utf8')
  const roundTrips = Buffer.from(text, 'utf8').equals(read.bytes)
  const eol = eolOf(text)
  const readOnly =
    ownedBy(root, where.real, at)
    ?? (writable(where.real, read.stat) ? null : READ_ONLY_ON_DISK)
    ?? (roundTrips ? null : NOT_UTF8)
    ?? (eol === null ? MIXED_EOL : null)

  return {
    kind: 'text',
    path: where.real,
    relative: where.relative,
    text,
    version: tokenOf(read.bytes, read.stat),
    eol: eol ?? '\n',
    language: tongue(where.real),
    readOnly,
    hidden: where.hidden,
  }
}

/**
 * The version on disk now, for the watch: cheap when nothing moved. The hash is
 * remembered by (path, size, mtime), so a file that has not changed is a `stat`
 * and no read.
 */
export type Stamp = { ok: true; version: string } | { ok: false; error: string }

const remembered = new Map<string, string>()

export function stampOf(root: string, at: string): Stamp {
  const where = locate(root, at, 'page')
  if (!where.ok) return where
  let fd: number
  try {
    fd = openSync(where.real, 'r')
  } catch {
    return { ok: false, error: REFUSED }
  }
  let stat: Stats
  try {
    stat = fstatSync(fd)
  } catch {
    return { ok: false, error: REFUSED }
  } finally {
    closeSync(fd)
  }
  const key = `${where.real}\0${stat.size}\0${stat.mtimeMs}`
  const known = remembered.get(key)
  if (known) return { ok: true, version: known }
  const read = readWhole(where.real)
  if (!read.ok) return read
  const token = tokenOf(read.bytes, read.stat)
  if (remembered.size > 256) remembered.clear()
  remembered.set(`${where.real}\0${read.stat.size}\0${read.stat.mtimeMs}`, token)
  return { ok: true, version: token }
}
