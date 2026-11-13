/**
 * Quick open's ranking: a fuzzy match of what was typed against every path.
 *
 * The typed characters must appear in order, case ignored. Among the ways they
 * can, the best is chosen by a score in the manner of fzf: every matched
 * character earns the same, a run of adjacent characters keeps the bonus of its
 * start, a character at a word start (after `/ . - _` or a space, or a camelCase
 * hump) earns a bonus, the first typed character doubly so, a gap costs, a match
 * in the file name earns a little more than one in the folders, and a longer path
 * costs a little. Pure, no filesystem.
 */

export interface Ranked {
  relative: string
  score: number
  /** Indices in `relative` of the matched characters, for the page to highlight. */
  hits: number[]
}

const MATCH = 16
const GAP_START = 5
const GAP_EXTEND = 1
const BOUNDARY_SLASH = 9
const BOUNDARY = 8
const CAMEL = 7
const CONSECUTIVE = 4
const IN_NAME = 2
const LENGTH = 0.1

const MAX_QUERY = 256
const MAX_TEXT = 1024

export interface Scored {
  score: number
  hits: number[]
}

/** The best fuzzy match of `query` in `text`, or null when its characters are not all there in order. */
export function fuzzy(text: string, query: string, nameStart = text.lastIndexOf('/') + 1): Scored | null {
  const q = query.replace(/\s+/g, '').toLowerCase().slice(0, MAX_QUERY)
  if (!q || !text || text.length > MAX_TEXT) return null
  const lower = text.toLowerCase()
  const m = q.length
  const n = text.length
  if (m > n) return null

  /* A cheap first look: are the characters there in order at all? */
  let k = 0
  for (let j = 0; j < n && k < m; j += 1) if (lower[j] === q[k]) k += 1
  if (k < m) return null

  const bonus = new Float64Array(n)
  for (let j = 0; j < n; j += 1) bonus[j] = boundaryAt(text, j) + (j >= nameStart ? IN_NAME : 0)

  const NEG = -Infinity
  const H = new Float64Array(m * n).fill(NEG)
  /* The bonus a run started with, so a run keeps it. */
  const R = new Float64Array(m * n)
  const P = new Int32Array(m * n).fill(-1)

  for (let i = 0; i < m; i += 1) {
    let bestPrev = NEG
    let bestPrevAt = -1
    for (let j = i; j < n; j += 1) {
      /* Track max over k <= j-2 of H[i-1][k] + k, for a gap ending before j. */
      if (i > 0 && j - 2 >= 0) {
        const kk = j - 2
        const v = H[(i - 1) * n + kk]!
        if (v !== NEG && v + kk * GAP_EXTEND > bestPrev) {
          bestPrev = v + kk * GAP_EXTEND
          bestPrevAt = kk
        }
      }
      if (lower[j] !== q[i]) continue
      const b = bonus[j]!
      const at = i * n + j
      if (i === 0) {
        H[at] = MATCH + b * 2
        R[at] = b
        continue
      }
      let best = NEG
      let from = -1
      let run = b
      const prev = H[(i - 1) * n + j - 1]!
      if (prev !== NEG) {
        const started = R[(i - 1) * n + j - 1]!
        const runBonus = Math.max(b, started, CONSECUTIVE)
        best = prev + MATCH + runBonus
        from = j - 1
        run = Math.max(started, b)
      }
      if (bestPrev !== NEG) {
        /* Gap length g = j - k - 1 >= 1 costs GAP_START + (g - 1) * GAP_EXTEND; bestPrev holds H[k] + k * GAP_EXTEND. */
        const s = bestPrev - (j - 2) * GAP_EXTEND - GAP_START + MATCH + b
        if (s > best) {
          best = s
          from = bestPrevAt
          run = b
        }
      }
      if (best === NEG) continue
      H[at] = best
      R[at] = run
      P[at] = from
    }
  }

  let end = -1
  let top = NEG
  for (let j = m - 1; j < n; j += 1) {
    const v = H[(m - 1) * n + j]!
    if (v > top) {
      top = v
      end = j
    }
  }
  if (end < 0) return null
  const hits = new Array<number>(m)
  for (let i = m - 1, j = end; i >= 0; i -= 1) {
    hits[i] = j
    j = P[i * n + j]!
  }
  return { score: top - n * LENGTH, hits }
}

function boundaryAt(text: string, j: number): number {
  if (j === 0) return BOUNDARY_SLASH
  const before = text[j - 1]!
  if (before === '/' || before === '\\') return BOUNDARY_SLASH
  if (before === '.' || before === '-' || before === '_' || before === ' ') return BOUNDARY
  const c = text[j]!
  if (isUpper(c) && isLowerOrDigit(before)) return CAMEL
  if (isDigit(c) && !isDigit(before)) return CAMEL
  return 0
}

const isUpper = (c: string) => c >= 'A' && c <= 'Z'
const isDigit = (c: string) => c >= '0' && c <= '9'
const isLowerOrDigit = (c: string) => (c >= 'a' && c <= 'z') || isDigit(c)

/** Rank paths for quick open. An empty query ranks nothing: the page shows its recent files itself. */
export function rankFiles(files: string[], query: string, limit = 50): Ranked[] {
  const q = query.trim()
  if (!q) return []
  const out: Ranked[] = []
  for (const relative of files) {
    const scored = fuzzy(relative, q)
    if (scored) out.push({ relative, score: scored.score, hits: scored.hits })
  }
  out.sort((a, b) => b.score - a.score || a.relative.length - b.relative.length || (a.relative < b.relative ? -1 : 1))
  return out.slice(0, Math.max(0, limit))
}
