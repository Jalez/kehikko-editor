import { describe, expect, test } from 'bun:test'

import { fuzzy, rankFiles } from '../file/quick.ts'

const order = (files: string[], query: string) => rankFiles(files, query).map((one) => one.relative)

describe('quick open ranking', () => {
  test('a run in the file name beats a run in a folder, which beats scattered word starts', () => {
    expect(order(['test/a-p-p.ts', 'src/apples/x.ts', 'src/app.tsx', 'README.md'], 'app')).toEqual(['src/app.tsx', 'src/apples/x.ts', 'test/a-p-p.ts'])
  })

  test('word starts across the path match', () => {
    const ranked = rankFiles(['src/build/tool.ts', 'docs/readme.md'], 'sbt')
    expect(ranked.map((one) => one.relative)).toEqual(['src/build/tool.ts'])
    expect(ranked[0]!.hits).toEqual([0, 4, 10])
  })

  test('characters must be there in order, case ignored', () => {
    expect(fuzzy('src/App.tsx', 'APP')).not.toBeNull()
    expect(fuzzy('src/app.tsx', 'ppa')).toBeNull()
  })

  test('camelCase humps count as word starts', () => {
    expect(order(['src/components/AppHeader.tsx', 'src/aphid/ear.ts'], 'ah')[0]).toBe('src/components/AppHeader.tsx')
  })

  test('a slash in the query matches across the path', () => {
    expect(order(['src/view/editor.ts', 'view/src/editor.ts', 'lib/editor.ts'], 'src/edi')).toEqual(['view/src/editor.ts', 'src/view/editor.ts'])
  })

  test('a shorter path wins a tie', () => {
    expect(order(['a/b/c/index.ts', 'a/index.ts'], 'index')).toEqual(['a/index.ts', 'a/b/c/index.ts'])
  })

  test('hits point at the matched characters', () => {
    const [first] = rankFiles(['src/app.tsx'], 'app')
    expect(first!.hits.map((i) => 'src/app.tsx'[i]).join('')).toBe('app')
  })

  test('an empty query ranks nothing; the limit holds', () => {
    expect(rankFiles(['a.ts'], '  ')).toEqual([])
    expect(rankFiles(['a1.ts', 'a2.ts', 'a3.ts'], 'a', 2).length).toBe(2)
  })
})
