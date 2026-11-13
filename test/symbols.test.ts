import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { forgetOutlines, outline, outlineText, projectSymbols } from '../file/symbols.ts'
import { forgetWalks } from '../file/walk.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-symbols-')))
const root = join(scratch, 'project')

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

put(
  join(root, 'src', 'shapes.ts'),
  [
    'export interface Shape { area(): number }',
    'export type Id = string',
    'export enum Colour { Red, Blue }',
    'export class Circle implements Shape {',
    '  constructor(public r: number) {}',
    '  area(): number { return Math.PI * this.r ** 2 }',
    '}',
    'export function formatDistance(metres: number): string {',
    '  return `${metres} m`',
    '}',
    'export const ORIGIN = { x: 0, y: 0 }',
    '',
  ].join('\n'),
)
put(join(root, 'README.md'), ['# Title', '', 'Text.', '', '## Install', '', '```sh', '# not a heading', '```', '', '### Details', '', '## Use', ''].join('\n'))
put(join(root, 'tools', 'run.py'), ['class Runner:', '    def start(self):', '        pass', '', 'def main():', '    pass', ''].join('\n'))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
beforeEach(() => {
  forgetWalks()
  forgetOutlines()
})

describe('outline', () => {
  test('a TypeScript file', () => {
    const symbols = outline(root, 'src/shapes.ts')
    const brief = symbols.map(({ name, kind, depth }) => `${depth}:${kind}:${name}`)
    expect(brief).toContain('0:interface:Shape')
    expect(brief).toContain('0:type:Id')
    expect(brief).toContain('0:enum:Colour')
    expect(brief).toContain('0:class:Circle')
    expect(brief).toContain('1:method:area')
    expect(brief).toContain('0:function:formatDistance')
    expect(brief).toContain('0:variable:ORIGIN')
    const fn = symbols.find((one) => one.name === 'formatDistance')!
    expect(fn).toMatchObject({ line: 8, column: 16 })
    expect(symbols.find((one) => one.name === 'area' && one.kind === 'method')!.container).toBe('Circle')
  })

  test('the page’s unsaved text is outlined instead of the disk', () => {
    expect(outline(root, 'src/shapes.ts', 'function fresh() {}\n').map((one) => one.name)).toEqual(['fresh'])
  })

  test('a Markdown file’s headings, not what is in a code block', () => {
    const symbols = outline(root, 'README.md')
    expect(symbols.map(({ name, depth, line }) => `${depth}:${line}:${name}`)).toEqual(['0:1:Title', '1:5:Install', '2:11:Details', '1:13:Use'])
    expect(symbols.every((one) => one.kind === 'heading')).toBe(true)
    expect(symbols[2]!.container).toBe('Install')
  })

  test('declaration shapes for other languages', () => {
    const py = outline(root, 'tools/run.py').map(({ name, kind, depth }) => `${depth}:${kind}:${name}`)
    expect(py).toEqual(['0:class:Runner', '1:method:start', '0:function:main'])
    expect(outlineText('x.go', 'package x\n\nfunc (s *S) Do() {}\nfunc Make() {}\ntype S struct {}\n').map((one) => `${one.kind}:${one.name}`)).toEqual([
      'method:Do',
      'function:Make',
      'class:S',
    ])
    expect(outlineText('a.json', '{\n  "name": "x",\n  "nested": { "inner": 1 }\n}\n').map((one) => one.name)).toEqual(['name', 'nested'])
    expect(outlineText('a.yml', 'one: 1\ntwo:\n  three: 3\n# four: 4\n').map((one) => one.name)).toEqual(['one', 'two'])
    expect(outlineText('a.css', '.a { color: red }\n@media (x) {\n  .b { }\n}\n').map((one) => one.name)).toEqual(['.a', '@media (x)'])
  })
})

describe('project symbols', () => {
  test('a function by a fuzzy name', async () => {
    const found = await projectSymbols(root, 'fmtdist')
    expect(found[0]).toMatchObject({ name: 'formatDistance', kind: 'function', relative: 'src/shapes.ts', line: 8 })
    expect(found[0]!.hits.length).toBe(7)
  })

  test('across languages, and nothing for an empty query', async () => {
    expect((await projectSymbols(root, 'Runner')).map((one) => one.relative)).toContain('tools/run.py')
    expect(await projectSymbols(root, '')).toEqual([])
  })
})
