import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { forgetWorkspaces, resolveImport, specifierAt } from '../file/imports.ts'
import { forgetWalks } from '../file/walk.ts'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'editor-imports-')))
const root = join(scratch, 'project')
const outside = join(scratch, 'outside')

function put(path: string, text = '') {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

put(join(root, 'tsconfig.json'), `{
  // comments and trailing commas, as tsconfig files have them
  "extends": "./tsconfig.base.json",
  "compilerOptions": { "baseUrl": ".", },
}`)
put(join(root, 'tsconfig.base.json'), '{ "compilerOptions": { "paths": { "@/*": ["./src/*"], "~lib": ["./src/lib/index.ts"] } } }')
put(join(root, 'src', 'main.ts'))
put(join(root, 'src', 'util.ts'))
put(join(root, 'src', 'view.tsx'))
put(join(root, 'src', 'lib', 'index.ts'))
put(join(root, 'src', 'data.json'), '{}')
put(join(root, 'src', 'deep', 'thing.ts'))
put(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@acme/core', exports: { '.': { types: './dist/index.d.ts', import: './src/index.ts' }, './extra': './src/extra.ts' } }))
put(join(root, 'packages', 'core', 'src', 'index.ts'))
put(join(root, 'packages', 'core', 'src', 'extra.ts'))
put(join(root, 'node_modules', 'leftpad', 'package.json'), JSON.stringify({ name: 'leftpad', main: 'lib/main.js' }))
put(join(root, 'node_modules', 'leftpad', 'lib', 'main.js'))
put(join(outside, 'out.ts'))
put(join(outside, 'pkg', 'package.json'), JSON.stringify({ name: 'escaped', main: 'index.js' }))
put(join(outside, 'pkg', 'index.js'))
symlinkSync(join(outside, 'pkg'), join(root, 'node_modules', 'escaped'))
put(join(root, 'tricky', 'package.json'), JSON.stringify({ name: 'tricky', exports: '../../outside/out.ts' }))

afterAll(() => rmSync(scratch, { recursive: true, force: true }))
beforeEach(() => {
  forgetWalks()
  forgetWorkspaces()
})

describe('specifierAt', () => {
  const text = "import { a } from './util'\nconst b = require(\"./lib\")\nconst c = await import('./view')\nconst d = 'not an import'\n"
  test('inside the string, and anywhere on an import line', () => {
    expect(specifierAt(text, text.indexOf('util'))?.specifier).toBe('./util')
    expect(specifierAt(text, 2)?.specifier).toBe('./util')
    const s = specifierAt(text, text.indexOf('./lib') + 1)!
    expect(s.specifier).toBe('./lib')
    expect(text.slice(s.from, s.to)).toBe('./lib')
    expect(specifierAt(text, text.indexOf('./view'))?.specifier).toBe('./view')
    expect(specifierAt(text, text.indexOf('not an'))).toBeNull()
  })

  test('export … from, and a multi-line import’s last line', () => {
    const more = "export * from './a'\nimport {\n  x,\n} from './b'\n"
    expect(specifierAt(more, 3)?.specifier).toBe('./a')
    expect(specifierAt(more, more.indexOf('./b'))?.specifier).toBe('./b')
    expect(specifierAt(more, more.indexOf('x,'))).toBeNull()
  })
})

describe('resolveImport', () => {
  test('relative, with extensions probed, folders to index, .js read as .ts', () => {
    expect(resolveImport(root, 'src/main.ts', './util')).toBe('src/util.ts')
    expect(resolveImport(root, 'src/main.ts', './view')).toBe('src/view.tsx')
    expect(resolveImport(root, 'src/main.ts', './lib')).toBe('src/lib/index.ts')
    expect(resolveImport(root, 'src/main.ts', './util.js')).toBe('src/util.ts')
    expect(resolveImport(root, 'src/main.ts', './data.json')).toBe('src/data.json')
    expect(resolveImport(root, 'src/deep/thing.ts', '../util')).toBe('src/util.ts')
    expect(resolveImport(root, 'src/main.ts', './nope')).toBeNull()
  })

  test('tsconfig paths (through extends) and baseUrl', () => {
    expect(resolveImport(root, 'src/main.ts', '@/deep/thing')).toBe('src/deep/thing.ts')
    expect(resolveImport(root, 'src/main.ts', '~lib')).toBe('src/lib/index.ts')
    expect(resolveImport(root, 'src/main.ts', 'src/util')).toBe('src/util.ts')
  })

  test('a workspace package by its exports, and node_modules as the last resort', () => {
    expect(resolveImport(root, 'src/main.ts', '@acme/core')).toBe('packages/core/src/index.ts')
    expect(resolveImport(root, 'src/main.ts', '@acme/core/extra')).toBe('packages/core/src/extra.ts')
    expect(resolveImport(root, 'src/main.ts', 'leftpad')).toBe('node_modules/leftpad/lib/main.js')
  })

  test('never outside the root', () => {
    expect(resolveImport(root, 'src/main.ts', '../../outside/out')).toBeNull()
    expect(resolveImport(root, 'src/main.ts', '../../outside/out.ts')).toBeNull()
    expect(resolveImport(root, 'src/main.ts', 'escaped')).toBeNull()
    expect(resolveImport(root, 'src/main.ts', 'tricky')).toBeNull()
    expect(resolveImport(root, '../outside/x.ts', './out')).toBeNull()
  })
})
