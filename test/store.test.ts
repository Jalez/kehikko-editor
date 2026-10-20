import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readValue, writeValue } from '../store.ts'

const home = mkdtempSync(join(tmpdir(), 'kehikko-editor-store-'))
afterAll(() => rmSync(home, { recursive: true, force: true }))

function project(name: string): string {
  const dir = join(home, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('the store', () => {
  test('a value written is the value read, kept inside the project', () => {
    const dir = project('round-trip')
    expect(readValue(dir)).toEqual({ ok: true, value: null })
    expect(writeValue(dir, { n: 1 }).ok).toBe(true)
    expect(readValue(dir)).toEqual({ ok: true, value: { n: 1 } })
    expect(existsSync(join(dir, '.kehikot', 'editor', 'value.json'))).toBe(true)
  })

  test('with no project there is nowhere to read or write', () => {
    expect(readValue(null).ok).toBe(false)
    expect(writeValue(null, 'x').ok).toBe(false)
    expect(writeValue('relative/path', 'x').ok).toBe(false)
  })

  test('a .kehikot that points out of the project is refused', () => {
    const dir = project('escaping')
    const elsewhere = project('elsewhere')
    symlinkSync(elsewhere, join(dir, '.kehikot'))
    expect(writeValue(dir, 'x').ok).toBe(false)
    expect(existsSync(join(elsewhere, 'editor'))).toBe(false)
  })
})
