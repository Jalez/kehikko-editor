import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { forgetWalks, globToRegex, ignored, rulesFrom, walk } from '../file/walk.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-walk-')))
const root = join(scratch, 'project')
const outside = join(scratch, 'outside')

function put(path: string, text = 'x\n') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

put(join(root, 'src', 'app.ts'))
put(join(root, 'src', 'gen', 'out.ts'))
put(join(root, 'src', 'gen', 'keep.ts'))
put(join(root, 'build', 'bundle.js'))
put(join(root, 'notes.log'))
put(join(root, 'important.log'))
put(join(root, 'pkg', 'a', 'cache', 'x.txt'))
put(join(root, 'pkg', 'a', 'tmp.txt'))
put(join(root, 'pkg', 'a', 'kept.txt'))
put(join(root, 'pkg', 'b', 'tmp.txt'))
put(join(root, 'node_modules', 'dep', 'index.js'))
put(join(root, '.git', 'HEAD'))
put(join(root, '.kehikot', 'mod', 'data.json'))
put(join(root, '.env'))
put(join(root, 'keys', 'id_ed25519'))
put(join(root, 'server.pem'))
put(join(root, 'log', 'file.txt'))
put(join(outside, 'secret.txt'))
put(join(outside, 'dir', 'deep.txt'))
symlinkSync(join(outside, 'secret.txt'), join(root, 'escape.txt'))
symlinkSync(join(outside, 'dir'), join(root, 'escape-dir'))
symlinkSync(join(root, 'src', 'app.ts'), join(root, 'friendly.ts'))
symlinkSync(join(root, 'src'), join(root, 'loop'))
writeFileSync(join(root, '.gitignore'), ['# comment', '*.log', '!important.log', 'build/', '/src/gen/*', '!/src/gen/keep.ts', 'log'].join('\n'))
writeFileSync(join(root, 'pkg', 'a', '.gitignore'), 'cache/\ntmp.txt\n')

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
beforeEach(() => forgetWalks())

describe('the walk', () => {
  test('honours .gitignore: negation, folder-only, anchored, nested', () => {
    const { files, truncated } = walk(root, { git: false })
    expect(truncated).toBe(false)
    expect(files).toContain('src/app.ts')
    expect(files).toContain('important.log')
    expect(files).not.toContain('notes.log')
    expect(files).not.toContain('build/bundle.js')
    expect(files).not.toContain('src/gen/out.ts')
    expect(files).toContain('src/gen/keep.ts')
    expect(files).not.toContain('pkg/a/cache/x.txt')
    expect(files).not.toContain('pkg/a/tmp.txt')
    expect(files).toContain('pkg/a/kept.txt')
    /* The nested file's rules stay in their folder. */
    expect(files).toContain('pkg/b/tmp.txt')
    expect(files).not.toContain('log/file.txt')
  })

  test('never goes into .git or node_modules; lists .kehikot; withholds keys but not .env', () => {
    const { files } = walk(root, { git: false })
    expect(files.some((one) => one.startsWith('.git/'))).toBe(false)
    expect(files.some((one) => one.startsWith('node_modules/'))).toBe(false)
    expect(files).toContain('.kehikot/mod/data.json')
    expect(files).toContain('.env')
    expect(files).not.toContain('keys/id_ed25519')
    expect(files).not.toContain('server.pem')
  })

  test('a symlink out of the root is skipped; one inside it is followed, once', () => {
    const { files } = walk(root, { git: false })
    expect(files).not.toContain('escape.txt')
    expect(files.some((one) => one.startsWith('escape-dir'))).toBe(false)
    expect(files).toContain('friendly.ts')
    expect(files.filter((one) => one.endsWith('app.ts')).length).toBeLessThanOrEqual(3)
  })

  test('the bound cuts the list and says so', () => {
    const { files, truncated } = walk(root, { git: false, maxFiles: 3 })
    expect(files.length).toBe(3)
    expect(truncated).toBe(true)
  })

  test('git’s own list, when the root is a work tree, keeps the same rules', () => {
    const git = spawnSync('git', ['init', '-q'], { cwd: root })
    if (git.status !== 0) return
    const { files } = walk(root, { fresh: true })
    expect(files).toContain('src/app.ts')
    expect(files).toContain('src/gen/keep.ts')
    expect(files).not.toContain('notes.log')
    expect(files).not.toContain('escape.txt')
    expect(files).not.toContain('server.pem')
    expect(files.some((one) => one.startsWith('.git/'))).toBe(false)
    rmSync(join(root, '.git'), { recursive: true, force: true })
    put(join(root, '.git', 'HEAD'))
  })
})

describe('gitignore rules', () => {
  test('globs', () => {
    expect(new RegExp(`^${globToRegex('**/a/*.ts')}$`).test('x/y/a/b.ts')).toBe(true)
    expect(new RegExp(`^${globToRegex('**/a/*.ts')}$`).test('a/b.ts')).toBe(true)
    expect(new RegExp(`^${globToRegex('a/**')}$`).test('a/b/c')).toBe(true)
    expect(new RegExp(`^${globToRegex('a?c')}$`).test('a/c')).toBe(false)
    expect(new RegExp(`^${globToRegex('*.{ts,tsx}')}$`).test('x.tsx')).toBe(true)
  })

  test('the last matching rule wins', () => {
    const rules = rulesFrom('*.txt\n!keep.txt\n', '')
    expect(ignored(rules, 'a/b.txt', false)).toBe(true)
    expect(ignored(rules, 'a/keep.txt', false)).toBe(false)
  })
})
