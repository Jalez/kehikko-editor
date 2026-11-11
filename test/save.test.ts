import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MIXED_EOL, NOT_TEXT, NOT_UTF8, READ_ONLY_ON_DISK, REFUSED, open } from '../file/open.ts'
import { setKnownDocument } from '../file/document.ts'
import { setKnownFolders } from '../file/folders.ts'
import { documentSentence, ownedSentence } from '../file/owned.ts'
import { CONFLICT, NO_BASE, save } from '../file/save.ts'
import { MAX_BYTES } from '../file/shape.ts'
import { WITHHELD_PAGE } from '../file/withheld.ts'

/**
 * The one write in this program, tried from every side: where it may write, what
 * it refuses to overwrite, and how it writes.
 */

const scratch = mkdtempSync(join(tmpdir(), 'editor-save-'))
const root = realpathSync(scratch)
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'editor-save-outside-')))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

function opened(at: string) {
  const seen = open(root, at, 'page')
  if (seen.kind !== 'text') throw new Error(`expected text for ${at}, got ${JSON.stringify(seen)}`)
  return seen
}

/** Nothing but the files a test made: no temporary file is ever left behind. */
function leftovers(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.kehikot-editor-'))
}

describe('where a save may write', () => {
  writeFileSync(join(outside, 'target.txt'), 'OUTSIDE\n')
  symlinkSync(join(outside, 'target.txt'), join(root, 'escape.txt'))
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  writeFileSync(join(root, 'id_ed25519'), 'KEY\n')
  writeFileSync(join(root, 'cert.pem'), 'PEM\n')
  const base = '0:0:' + '0'.repeat(64)

  test('nowhere outside the project: traversal, an absolute path, a link out', () => {
    for (const at of ['../x.txt', '../../etc/hosts', join(outside, 'target.txt'), '/etc/hosts', 'escape.txt']) {
      expect([at, save(root, at, 'pwned', base)]).toEqual([at, { kind: 'refused', error: REFUSED }])
    }
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('OUTSIDE\n')
  })

  test('never inside .git, .ssh, .aws or .gnupg, and never a private key', () => {
    for (const at of ['.git/config', 'id_ed25519', 'cert.pem', '.ssh/config']) {
      expect([at, save(root, at, 'pwned', base)]).toEqual([at, { kind: 'refused', error: WITHHELD_PAGE }])
    }
    expect(readFileSync(join(root, '.git', 'config'), 'utf8')).toBe('[core]\n')
  })

  test('a file that does not exist is not created', () => {
    expect(save(root, 'new.txt', 'hello', base)).toEqual({ kind: 'refused', error: REFUSED })
    expect(() => statSync(join(root, 'new.txt'))).toThrow()
  })
})

describe('files other modules own are read-only, with a sentence naming the owner', () => {
  /* The document provider as the host would answer it: any name, any folder, never spelled in the code. */
  const MANUSCRIPT = { name: 'Manuscript', folder: '.kehikot/manuscript', main: 'main.tex' }
  afterEach(() => {
    setKnownDocument(null, Number.POSITIVE_INFINITY)
    setKnownFolders({}, Number.POSITIVE_INFINITY)
  })
  mkdirSync(join(root, '.kehikot', 'manuscript', 'thesis'), { recursive: true })
  mkdirSync(join(root, '.kehikot', 'notes'), { recursive: true })
  mkdirSync(join(root, 'elsewhere'), { recursive: true })
  writeFileSync(join(root, '.kehikot', 'manuscript', 'thesis', 'main.tex'), '\\section{Intro}\n')
  writeFileSync(join(root, '.kehikot', 'notes', 'notes.json'), '{}\n')
  writeFileSync(join(root, '.kehikot', 'project.json'), '{"id":"x"}\n')
  writeFileSync(join(root, 'elsewhere', 'main.tex'), '\\section{Linked}\n')
  writeFileSync(join(root, 'elsewhere', 'chapter.tex'), 'chapter\n')
  symlinkSync(join(root, 'elsewhere'), join(root, '.kehikot', 'manuscript', 'linked'))
  symlinkSync(join(root, '.kehikot', 'notes', 'notes.json'), join(root, 'plain-notes.json'))

  test('the document provider’s source, in its own name', () => {
    setKnownDocument(MANUSCRIPT)
    const seen = opened('.kehikot/manuscript/thesis/main.tex')
    expect(seen.readOnly).toBe(documentSentence('Manuscript'))
    expect(seen.readOnly).toContain('Manuscript keeps this file')
    expect(save(root, '.kehikot/manuscript/thesis/main.tex', 'changed', seen.version)).toEqual({ kind: 'refused', error: documentSentence('Manuscript') })
    expect(readFileSync(join(root, '.kehikot', 'manuscript', 'thesis', 'main.tex'), 'utf8')).toBe('\\section{Intro}\n')
  })

  test('a document folder that is a link elsewhere in the project makes those files the provider’s too', () => {
    setKnownDocument(MANUSCRIPT)
    const seen = opened('elsewhere/chapter.tex')
    expect(seen.readOnly).toBe(documentSentence('Manuscript'))
    expect(save(root, 'elsewhere/chapter.tex', 'x', seen.version).kind).toBe('refused')
  })

  test('with no provider, its folder under .kehikot/ is still read-only, in generic words', () => {
    const seen = opened('.kehikot/manuscript/thesis/main.tex')
    expect(seen.readOnly).toBe(ownedSentence('manuscript'))
    expect(save(root, '.kehikot/manuscript/thesis/main.tex', 'changed', seen.version).kind).toBe('refused')
    /* A link elsewhere is followed only when a provider says which folder is a document. */
    expect(opened('elsewhere/chapter.tex').readOnly).toBeNull()
  })

  test('a declared folder’s store names its owner, also through a link with a plain name', () => {
    /* As the host would answer `module.folders`: any name, never spelled in the code. */
    setKnownFolders({ notes: { name: 'Jottings', says: 'The project’s jottings.' } }, Number.POSITIVE_INFINITY)
    for (const at of ['.kehikot/notes/notes.json', 'plain-notes.json']) {
      const seen = opened(at)
      expect(seen.readOnly).toContain('belongs to Jottings')
      expect(seen.readOnly).toContain('The project’s jottings')
      expect(save(root, at, '{"x":1}\n', seen.version)).toEqual({ kind: 'refused', error: seen.readOnly! })
    }
    expect(readFileSync(join(root, '.kehikot', 'notes', 'notes.json'), 'utf8')).toBe('{}\n')
  })

  test('the host’s project.json, and any other module’s folder', () => {
    expect(opened('.kehikot/project.json').readOnly).toContain('Kehikot app')
    mkdirSync(join(root, '.kehikot', 'someone'), { recursive: true })
    writeFileSync(join(root, '.kehikot', 'someone', 'data.json'), '[]\n')
    expect(opened('.kehikot/someone/data.json').readOnly).toContain('the someone module')
    /* A folder nobody in use declares is said generically; the app's own folders stay the app's. */
    expect(opened('.kehikot/notes/notes.json').readOnly).toContain('belongs to the notes module')
    expect(ownedSentence('kehikko', new Map([['kehikko', { name: 'Impostor', says: 'x' }]]))).toContain('belongs to the Kehikot app')
  })
})

describe('the base-version check', () => {
  test('a save that started from the version on disk is written', () => {
    writeFileSync(join(root, 'plain.txt'), 'one\n')
    const seen = opened('plain.txt')
    const saved = save(root, 'plain.txt', 'two\n', seen.version)
    expect(saved.kind).toBe('saved')
    expect(readFileSync(join(root, 'plain.txt'), 'utf8')).toBe('two\n')
    expect(saved.kind === 'saved' && saved.version).toBe(opened('plain.txt').version)
  })

  test('a file changed on disk since the edit began is refused, and the answer carries what is there now', () => {
    writeFileSync(join(root, 'raced.txt'), 'start\n')
    const seen = opened('raced.txt')
    writeFileSync(join(root, 'raced.txt'), 'someone else\n')
    const saved = save(root, 'raced.txt', 'mine\n', seen.version)
    expect(saved).toEqual({ kind: 'conflict', version: opened('raced.txt').version, text: 'someone else\n', error: CONFLICT })
    expect(readFileSync(join(root, 'raced.txt'), 'utf8')).toBe('someone else\n')
  })

  test('the same size and the same modification time do not hide a change: the hash does', () => {
    writeFileSync(join(root, 'sly.txt'), 'aaaa\n')
    const before = statSync(join(root, 'sly.txt'))
    const seen = opened('sly.txt')
    writeFileSync(join(root, 'sly.txt'), 'bbbb\n')
    utimesSync(join(root, 'sly.txt'), before.atime, before.mtime)
    expect(save(root, 'sly.txt', 'mine\n', seen.version).kind).toBe('conflict')
    expect(readFileSync(join(root, 'sly.txt'), 'utf8')).toBe('bbbb\n')
  })

  test('saving over a changed file takes a new save from the version the person was shown', () => {
    writeFileSync(join(root, 'over.txt'), 'start\n')
    const seen = opened('over.txt')
    writeFileSync(join(root, 'over.txt'), 'theirs\n')
    const conflict = save(root, 'over.txt', 'mine\n', seen.version)
    expect(conflict.kind).toBe('conflict')
    const again = save(root, 'over.txt', 'mine\n', conflict.kind === 'conflict' ? conflict.version : '')
    expect(again.kind).toBe('saved')
    expect(readFileSync(join(root, 'over.txt'), 'utf8')).toBe('mine\n')
  })

  test('a save that names no base, or a malformed one, writes nothing', () => {
    writeFileSync(join(root, 'nobase.txt'), 'x\n')
    for (const base of [undefined, '', 'yes', 42, '1:2:abc']) {
      expect(save(root, 'nobase.txt', 'y\n', base)).toEqual({ kind: 'refused', error: NO_BASE })
    }
    expect(readFileSync(join(root, 'nobase.txt'), 'utf8')).toBe('x\n')
  })

  test('an unchanged text is not written at all', () => {
    writeFileSync(join(root, 'same.txt'), 'same\n')
    const seen = opened('same.txt')
    const inode = statSync(join(root, 'same.txt')).ino
    expect(save(root, 'same.txt', 'same\n', seen.version)).toEqual({ kind: 'saved', version: seen.version, unchanged: true })
    expect(statSync(join(root, 'same.txt')).ino).toBe(inode)
  })
})

describe('how it writes', () => {
  test('atomically: a new file renamed over the old one, with nothing left beside it', () => {
    writeFileSync(join(root, 'atomic.txt'), 'old\n')
    const inode = statSync(join(root, 'atomic.txt')).ino
    const seen = opened('atomic.txt')
    expect(save(root, 'atomic.txt', 'new\n', seen.version).kind).toBe('saved')
    expect(statSync(join(root, 'atomic.txt')).ino).not.toBe(inode)
    expect(readFileSync(join(root, 'atomic.txt'), 'utf8')).toBe('new\n')
    expect(leftovers(root)).toEqual([])
  })

  test('keeping the file’s mode', () => {
    writeFileSync(join(root, 'run.sh'), '#!/bin/sh\necho hi\n')
    chmodSync(join(root, 'run.sh'), 0o750)
    const seen = opened('run.sh')
    expect(save(root, 'run.sh', '#!/bin/sh\necho bye\n', seen.version).kind).toBe('saved')
    expect(statSync(join(root, 'run.sh')).mode & 0o7777).toBe(0o750)
  })

  test('through a link inside the project, to the file it leads to, and the link stays a link', () => {
    mkdirSync(join(root, 'docs'), { recursive: true })
    writeFileSync(join(root, 'docs', 'real.md'), '# Real\n')
    symlinkSync(join(root, 'docs', 'real.md'), join(root, 'alias.md'))
    const seen = opened('alias.md')
    expect(seen.path).toBe(join(root, 'docs', 'real.md'))
    expect(save(root, 'alias.md', '# Changed\n', seen.version).kind).toBe('saved')
    expect(lstatSync(join(root, 'alias.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(root, 'docs', 'real.md'), 'utf8')).toBe('# Changed\n')
    expect(leftovers(join(root, 'docs'))).toEqual([])
  })

  test('keeping CRLF line endings', () => {
    writeFileSync(join(root, 'win.txt'), 'a\r\nb\r\n')
    const seen = opened('win.txt')
    expect(seen.eol).toBe('\r\n')
    expect(seen.readOnly).toBeNull()
    expect(save(root, 'win.txt', 'a\r\nB\r\n', seen.version).kind).toBe('saved')
    expect(readFileSync(join(root, 'win.txt'), 'utf8')).toBe('a\r\nB\r\n')
  })
})

describe('what is not opened for editing, or opened read-only', () => {
  test('a file over the bound is refused with a sentence', () => {
    writeFileSync(join(root, 'huge.log'), Buffer.alloc(MAX_BYTES + 1, 0x61))
    const seen = open(root, 'huge.log', 'page')
    expect(seen.kind).toBe('refused')
    expect(seen.kind === 'refused' && seen.error).toContain('up to 1.0 MB')
  })

  test('a save larger than the bound is refused', () => {
    writeFileSync(join(root, 'grow.txt'), 'small\n')
    const seen = opened('grow.txt')
    const saved = save(root, 'grow.txt', 'a'.repeat(MAX_BYTES + 1), seen.version)
    expect(saved.kind).toBe('refused')
    expect(readFileSync(join(root, 'grow.txt'), 'utf8')).toBe('small\n')
  })

  test('a binary file is refused with a sentence, and a save cannot make one', () => {
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]))
    expect(open(root, 'image.png', 'page')).toEqual({ kind: 'refused', error: NOT_TEXT })
    writeFileSync(join(root, 'text.txt'), 'text\n')
    const seen = opened('text.txt')
    expect(save(root, 'text.txt', 'a\u0000b', seen.version).kind).toBe('refused')
  })

  test('mixed line endings and bytes that are not UTF-8 are read-only, because a save would change them', () => {
    writeFileSync(join(root, 'mixed.txt'), 'a\r\nb\nc\r\n')
    expect(opened('mixed.txt').readOnly).toBe(MIXED_EOL)
    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    expect(opened('latin1.txt').readOnly).toBe(NOT_UTF8)
    expect(save(root, 'latin1.txt', 'café\n', opened('latin1.txt').version)).toEqual({ kind: 'refused', error: NOT_UTF8 })
  })

  test('a file marked read-only on disk is not saved', () => {
    writeFileSync(join(root, 'locked.txt'), 'locked\n')
    chmodSync(join(root, 'locked.txt'), 0o444)
    const seen = opened('locked.txt')
    expect(seen.readOnly).toBe(READ_ONLY_ON_DISK)
    expect(save(root, 'locked.txt', 'x\n', seen.version)).toEqual({ kind: 'refused', error: READ_ONLY_ON_DISK })
    chmodSync(join(root, 'locked.txt'), 0o644)
  })
})
