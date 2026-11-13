import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { definition, forgetServices, markSlow, wordAt } from '../file/definition.ts'
import { forgetWorkspaces } from '../file/imports.ts'
import { forgetWalks } from '../file/walk.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-definition-')))
const root = join(scratch, 'project')
const outside = join(scratch, 'outside')

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

put(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'Preserve', moduleResolution: 'bundler', noEmit: true }, include: ['src'] }))
put(
  join(root, 'src', 'math.ts'),
  ['// helpers', '', 'export function add(a: number, b: number): number {', '  return a + b', '}', '', 'export class Counter {', '  count = 0', '  bump(by = 1): number {', '    this.count += by', '    return this.count', '  }', '}', ''].join('\n'),
)
const MAIN = ["import { add, Counter } from './math'", '', 'const total = add(1, 2)', 'const counter = new Counter()', 'counter.bump(total)', ''].join('\n')
put(join(root, 'src', 'main.ts'), MAIN)
put(join(root, 'tools', 'build.py'), ['import os', '', 'def make_thing(x):', '    return x', '', 'make_thing(1)', ''].join('\n'))
put(join(outside, 'elsewhere.ts'), 'export function add() {}\n')

afterAll(() => {
  forgetServices()
  rmSync(scratch, { recursive: true, force: true })
})
beforeEach(() => {
  forgetWalks()
  forgetWorkspaces()
})

describe('go to definition', () => {
  test('a function imported from another file resolves to its declaration', async () => {
    const found = await definition(root, 'src/main.ts', MAIN.indexOf('add(1') + 1)
    expect(found.via).toBe('typescript')
    expect(found.targets[0]).toMatchObject({ relative: 'src/math.ts', line: 3, kind: 'symbol' })
    expect(found.targets[0]!.preview).toContain('function add')
  })

  test('a class method', async () => {
    const found = await definition(root, 'src/main.ts', MAIN.indexOf('bump') + 1)
    expect(found.via).toBe('typescript')
    expect(found.targets[0]).toMatchObject({ relative: 'src/math.ts', line: 9, column: 2 })
  })

  test('the page’s unsaved text is what is read', async () => {
    const unsaved = `\n\n${MAIN}`
    const found = await definition(root, 'src/main.ts', unsaved.indexOf('Counter()') + 1, unsaved)
    expect(found.targets[0]).toMatchObject({ relative: 'src/math.ts', line: 7 })
  })

  test('an import specifier opens the file it names', async () => {
    const found = await definition(root, 'src/main.ts', MAIN.indexOf("'./math'") + 3)
    expect(found).toEqual({ targets: [{ relative: 'src/math.ts', line: 1, column: 0, preview: 'src/math.ts', kind: 'file' }], via: 'import', said: null })
  })

  test('another language falls back to declaration shapes', async () => {
    const text = 'import os\n\ndef make_thing(x):\n    return x\n\nmake_thing(1)\n'
    const found = await definition(root, 'tools/build.py', text.lastIndexOf('make_thing') + 2)
    expect(found.via).toBe('text')
    expect(found.targets[0]).toMatchObject({ relative: 'tools/build.py', line: 3, column: 4 })
  })

  test('a slow root gets the text search', async () => {
    markSlow(root)
    const found = await definition(root, 'src/main.ts', MAIN.indexOf('add(1') + 1)
    expect(found.via).toBe('text')
    expect(found.targets.map((one) => one.relative)).toEqual(['src/math.ts'])
    forgetServices()
  })

  test('nothing found says so, naming the word', async () => {
    const text = 'import os\n\nnowhere_defined()\n'
    put(join(root, 'tools', 'lonely.py'), text)
    forgetWalks()
    const found = await definition(root, 'tools/lonely.py', text.indexOf('nowhere') + 1)
    expect(found).toEqual({ targets: [], via: null, said: 'No definition found for “nowhere_defined”.' })
    const blank = await definition(root, 'tools/lonely.py', text.indexOf('\n\n') + 1)
    expect(blank.said).toBe('No definition found.')
  })

  test('the word at an offset', () => {
    expect(wordAt('foo.barBaz()', 6)).toBe('barBaz')
    expect(wordAt('  ', 1)).toBeNull()
  })
})
