import { expect, test } from 'bun:test'

import { LANGUAGES, tongue } from '../file/shape.ts'
import { LOADABLE, loadLanguage } from '../src/view/languages.ts'

test('every language the server can name, the page can load', () => {
  for (const name of LANGUAGES) expect([name, LOADABLE.includes(name)]).toEqual([name, true])
})

test('a few names, and an unknown one draws plain', async () => {
  expect(tongue('/p/src/app.tsx')).toBe('tsx')
  expect(tongue('/p/.env.local')).toBe('properties')
  expect(tongue('/p/notes.unknown')).toBeNull()
  expect(await loadLanguage(null)).toBeNull()
  expect(await loadLanguage('typescript')).not.toBeNull()
  expect(await loadLanguage('yaml')).not.toBeNull()
})
