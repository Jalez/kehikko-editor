import { describe, expect, test } from 'bun:test'

import { compare, hunks } from '../src/edit/diff.ts'

describe('the comparison', () => {
  test('one changed line among many', () => {
    const disk = ['a', 'b', 'c', 'd', 'e'].join('\n')
    const mine = ['a', 'b', 'C', 'd', 'e'].join('\n')
    const compared = compare(disk, mine)
    expect(compared.lines.filter((line) => line.kind !== 'same')).toEqual([
      { kind: 'disk', text: 'c' },
      { kind: 'mine', text: 'C' },
    ])
    expect([compared.disk, compared.mine, compared.coarse]).toEqual([1, 1, false])
  })

  test('insertions and deletions are lined up', () => {
    const compared = compare('a\nb\nc', 'a\nx\nb\nc\nd')
    expect(compared.lines.map((line) => `${line.kind}:${line.text}`)).toEqual(['same:a', 'mine:x', 'same:b', 'same:c', 'mine:d'])
  })

  test('far-off unchanged lines fold into a gap', () => {
    const disk = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    const mine = disk.replace('line 25', 'LINE 25')
    const shown = hunks(compare(disk, mine).lines, 2)
    expect(shown[0]).toBeNull()
    expect(shown.filter(Boolean).length).toBe(6)
  })
})
