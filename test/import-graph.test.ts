import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/**
 * The page never pulls in server code: everything `src/main.tsx` reaches, through relative and `@/`
 * imports, is walked, and none of it may be the server's (`file/`, the doors, the stream, the host
 * asker), import a `node:` module, or the protocol's server half (`/serve`). A server file reached
 * from the page would ship file-system code to the browser, or break the build.
 */

const ROOT = join(import.meta.dir, '..')
/* `file/shape.ts` is shapes and numbers only, shared by both halves on purpose. */
const SERVER = [/^file\/(?!shape\.ts$)/, /^doors\.ts$/, /^live\.ts$/, /^host-ask\.ts$/, /^serve\.ts$/, /^register\.ts$/, /^store\.ts$/]
const EXTENSIONS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith('@/') ? join(ROOT, 'src', spec.slice(2)) : spec.startsWith('.') ? resolve(dirname(from), spec) : null
  if (!base) return null
  for (const ext of EXTENSIONS) if (existsSync(base + ext) && !base.endsWith('/') && (ext !== '' || /\.[a-z]+$/.test(base))) return base + ext
  return null
}

function walk(): { files: Set<string>; bad: string[] } {
  const files = new Set<string>()
  const bad: string[] = []
  const queue = [join(ROOT, 'src/main.tsx')]
  while (queue.length) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    const name = relative(ROOT, file)
    if (SERVER.some((rule) => rule.test(name))) bad.push(`${name} is server code`)
    if (!/\.(tsx?|mjs|js)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = match[1] ?? match[2]!
      if (/^import\s+type\b/.test(match[0]) || /^export\s+type\b/.test(match[0])) continue
      if (spec.startsWith('node:')) bad.push(`${name} imports ${spec}`)
      if (spec === 'kehikot-module-protocol/serve' || spec.startsWith('kehikot-module-protocol/serve/')) bad.push(`${name} imports ${spec}`)
      const next = resolveImport(file, spec)
      if (next) queue.push(next)
    }
  }
  return { files, bad }
}

describe('the page’s import graph', () => {
  test('reaches no server code', () => {
    const { files, bad } = walk()
    expect(files.size).toBeGreaterThan(10)
    expect(bad).toEqual([])
  })
})
