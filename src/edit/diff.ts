/**
 * A line comparison between what is on disk and what is in the editor, for the
 * moment a save was refused because the file changed underneath.
 *
 * The common head and tail are set aside first (the usual case is a change in
 * one place), and the middle is compared line by line with a longest common
 * subsequence — bounded, because a refused save of a large file must not hang
 * the page. Past the bound the middle is shown as one block removed and one
 * added, which is true, if coarse, and says so.
 */

export type Line = { kind: 'same' | 'disk' | 'mine'; text: string }

export interface Compared {
  lines: Line[]
  /** True when the middle was too large to compare line by line. */
  coarse: boolean
  /** How many lines differ, each side. */
  disk: number
  mine: number
}

/** The most cells the line-by-line table may have. */
const MAX_CELLS = 4_000_000

export function compare(diskText: string, mineText: string): Compared {
  const a = diskText.split('\n')
  const b = mineText.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1

  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const lines: Line[] = a.slice(0, head).map((text) => ({ kind: 'same' as const, text }))
  let coarse = false

  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
    coarse = true
    for (const text of midA) lines.push({ kind: 'disk', text })
    for (const text of midB) lines.push({ kind: 'mine', text })
  } else {
    const n = midA.length
    const m = midB.length
    /* Lengths of the longest common subsequence of the suffixes, one row at a time from the end. */
    const table = new Uint32Array((n + 1) * (m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i * (m + 1) + j] =
          midA[i] === midB[j] ? table[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(table[(i + 1) * (m + 1) + j]!, table[i * (m + 1) + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        lines.push({ kind: 'same', text: midA[i]! })
        i += 1
        j += 1
      } else if (table[(i + 1) * (m + 1) + j]! >= table[i * (m + 1) + j + 1]!) {
        lines.push({ kind: 'disk', text: midA[i]! })
        i += 1
      } else {
        lines.push({ kind: 'mine', text: midB[j]! })
        j += 1
      }
    }
    while (i < n) lines.push({ kind: 'disk', text: midA[i++]! })
    while (j < m) lines.push({ kind: 'mine', text: midB[j++]! })
  }

  for (const text of a.slice(a.length - tail)) lines.push({ kind: 'same', text })
  return {
    lines,
    coarse,
    disk: lines.filter((line) => line.kind === 'disk').length,
    mine: lines.filter((line) => line.kind === 'mine').length,
  }
}

/**
 * The lines worth drawing: every changed line with `context` unchanged lines
 * around it, and a gap marker (null) where unchanged lines were folded away.
 */
export function hunks(lines: Line[], context = 3): (Line | null)[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((line, index) => {
    if (line.kind === 'same') return
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k += 1) keep[k] = true
  })
  const out: (Line | null)[] = []
  let gap = false
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line)
      gap = false
    } else if (!gap) {
      out.push(null)
      gap = true
    }
  })
  return out
}
