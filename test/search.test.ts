import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Searches, globMatcher, previewOf, searchProject } from '../file/search.ts'
import { forgetWalks } from '../file/walk.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-search-')))
const root = join(scratch, 'project')
const outside = join(scratch, 'outside')

function put(path: string, text: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

put(join(root, 'src', 'a.ts'), 'const needle = 1\nconst Needle = 2\nconst needles = 3\n')
put(join(root, 'src', 'b.ts'), '  // needle in b\n')
put(join(root, 'docs', 'c.md'), 'a needle\n')
put(join(root, 'ignored', 'd.ts'), 'needle\n')
put(join(root, 'node_modules', 'x', 'e.js'), 'needle\n')
put(join(root, 'big.txt'), `${'needle '.repeat(200_000)}\n`)
put(join(root, 'blob.bin'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 1, 2, 3]))
put(join(root, 'long.txt'), `${'x'.repeat(1000)}needle${'y'.repeat(1000)}\n`)
put(join(root, '.gitignore'), 'ignored/\n')
put(join(outside, 'secret.ts'), 'needle outside\n')
symlinkSync(join(outside, 'secret.ts'), join(root, 'escape.ts'))
for (let i = 0; i < 120; i += 1) put(join(root, 'many', `f${String(i).padStart(3, '0')}.txt`), 'needle\n')

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
beforeEach(() => forgetWalks())

const rel = (result: Awaited<ReturnType<typeof searchProject>>) => result.files.map((one) => one.relative)

describe('search in project', () => {
  test('the fence, .gitignore, node_modules, binaries and big files hold', async () => {
    const result = await searchProject(root, { query: 'needle' }, { maxFileBytes: 64 * 1024 })
    const files = rel(result)
    expect(files).toContain('src/a.ts')
    expect(files).not.toContain('escape.ts')
    expect(files).not.toContain('ignored/d.ts')
    expect(files.some((one) => one.startsWith('node_modules'))).toBe(false)
    expect(files).not.toContain('blob.bin')
    expect(files).not.toContain('big.txt')
    expect(result.error).toBeUndefined()
  })

  test('case, whole word and include', async () => {
    const insensitive = await searchProject(root, { query: 'needle', include: ['src/a.ts'] })
    expect(insensitive.total).toBe(3)
    const sensitive = await searchProject(root, { query: 'Needle', caseSensitive: true, include: ['src/a.ts'] })
    expect(sensitive.total).toBe(1)
    expect(sensitive.files[0]!.matches[0]).toMatchObject({ line: 2, column: 6, length: 6 })
    const whole = await searchProject(root, { query: 'needle', wholeWord: true, include: ['src/a.ts'] })
    expect(whole.total).toBe(2)
  })

  test('include and exclude globs; a bare name is a folder anywhere', async () => {
    const md = await searchProject(root, { query: 'needle', include: ['*.md'] })
    expect(rel(md)).toEqual(['docs/c.md'])
    const notMany = await searchProject(root, { query: 'needle', exclude: ['many', 'big.txt'] })
    expect(rel(notMany).some((one) => one.startsWith('many/'))).toBe(false)
    const src = await searchProject(root, { query: 'needle', include: ['src/**'] })
    expect(rel(src).sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('regular expressions, and a bad one said in words', async () => {
    const found = await searchProject(root, { query: '^const n\\w+', regex: true, caseSensitive: true, include: ['src/a.ts'] })
    expect(found.total).toBe(2)
    const broken = await searchProject(root, { query: '(unclosed', regex: true })
    expect(broken.error).toStartWith('That is not a valid regular expression: ')
    expect(broken.files).toEqual([])
  })

  test('maxResults truncates', async () => {
    const result = await searchProject(root, { query: 'needle' }, { maxResults: 5, maxFileBytes: 64 * 1024 })
    expect(result.total).toBe(5)
    expect(result.truncated).toBe(true)
  })

  test('a long line gets a window around the match', async () => {
    const result = await searchProject(root, { query: 'needle', include: ['long.txt'] })
    const match = result.files[0]!.matches[0]!
    expect(match.column).toBe(1000)
    expect(match.preview.length).toBeLessThanOrEqual(240)
    expect(match.preview.slice(match.column - match.previewStart, match.column - match.previewStart + 6)).toBe('needle')
    expect(previewOf('    indented needle', 13, 6)).toEqual({ preview: 'indented needle', previewStart: 4 })
  })

  test('a newer search under the same key cancels the older', async () => {
    const searches = new Searches()
    const older = searches.run('key', root, { query: 'needle' }, { maxFileBytes: 64 * 1024 })
    const newer = searches.run('key', root, { query: 'needle' }, { maxFileBytes: 64 * 1024 })
    const [a, b] = await Promise.all([older, newer])
    expect(a.cancelled).toBe(true)
    expect(b.cancelled).toBe(false)
    expect(b.total).toBeGreaterThan(100)
  })

  test('globs', () => {
    expect(globMatcher(['*.ts'])!('a/b/c.ts')).toBe(true)
    expect(globMatcher(['src'])!('x/src/y.ts')).toBe(true)
    expect(globMatcher(['src/*.ts'])!('x/src/y.ts')).toBe(false)
    expect(globMatcher(['*.ts, *.md'])!('a.md')).toBe(true)
    expect(globMatcher(['*.{ts,md}'])!('a.md')).toBe(true)
    expect(globMatcher([])).toBeNull()
  })
})
