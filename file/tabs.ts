import { createHash, randomUUID } from 'node:crypto'

import { publish, watching } from 'kehikot-module-protocol/serve'

import { withheld } from './withheld.ts'
import { MAX_PATH } from './shape.ts'

/**
 * The tabs the person has open, as the Editor's pages last said them, and the orders an agent gives
 * them through the MCP door: open files as tabs, focus one, close saved ones.
 *
 * In memory, for as long as this process lives, like `editing.ts`: a report of pages that are open
 * now. An order goes to the pages over their own stream (`ORDERS_PATH`, published here); a page that
 * carried it out says what it did (`done`). With no page open on the project, an order to open
 * files is held here and handed to the next page that opens there — as long as this process runs.
 *
 * Nothing here writes a file, and no order can discard an edit: the page closes only saved tabs and
 * says which it kept.
 */

export const ORDERS_PATH = '/api/orders/events'

/** How long the door waits for a page to say what it did, in ms. */
export const ORDER_WAIT_MS = 2500

/** At most this many orders are held per project while no page is open. */
export const HELD_ORDERS = 16

/** At most this many files in one order. */
export const ORDER_FILES = 20

export interface TabReport {
  relative: string
  dirty: boolean
  active: boolean
  preview: boolean
  agent: boolean
  readOnly: boolean
  hidden: boolean
}

export interface PageReport {
  /** A page's own id, minted when it loads. */
  page: string
  /** The kehikko the page is on, as the host told it: its key and name. */
  kehikko: { key: string | null; name: string | null } | null
  tabs: TabReport[]
  at: number
}

export interface OpenFile {
  relative: string
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  preview?: boolean
}

export type Order =
  | { id: string; kind: 'open'; files: OpenFile[]; focus: string | null; kehikko: string | null }
  | { id: string; kind: 'focus'; relative: string; kehikko: string | null }
  | { id: string; kind: 'close'; paths: string[]; kehikko: string | null }

/** What a page says it did with an order. */
export interface OrderDone {
  opened?: string[]
  background?: boolean
  focused?: string | null
  closed?: string[]
  kept?: { relative: string; why: string }[]
  refused?: { relative: string; why: string }[]
}

const pages = new Map<string, Map<string, PageReport>>()
const held = new Map<string, Order[]>()
const waiting = new Map<string, (done: OrderDone) => void>()

/**
 * The topic a page hears orders on: the project as the PAGE spells it (its stream is opened before
 * the host has been asked which project that is). Hashed, as a topic is at most 512 characters.
 */
export const ordersTopic = (projectPath: string): string => `orders:${createHash('sha256').update(projectPath).digest('hex')}`

/** Each project's spellings as its pages named it, learnt from their reports (which pass the host and the fence). */
const spellings = new Map<string, Set<string>>()

export function notePage(root: string, projectPath: string): void {
  if (!projectPath || projectPath.length > MAX_PATH) return
  let set = spellings.get(root)
  if (!set) spellings.set(root, (set = new Set()))
  set.add(projectPath)
  while (set.size > 8) set.delete(set.values().next().value as string)
}

const topicsOf = (root: string): string[] => [...(spellings.get(root) ?? [])].map(ordersTopic)

/** Pages forgotten after this long without a report (a page reports whenever its tabs change). */
const STALE_MS = 6 * 60 * 60 * 1000

const bool = (value: unknown) => value === true
const text = (value: unknown, most: number) => (typeof value === 'string' && value.length > 0 && value.length <= most ? value : null)

/** Keep what a page said of its tabs, bounded. A refusal sentence, or null. */
export function reportTabs(root: string, body: Record<string, unknown>): string | null {
  const page = text(body.page, 64)
  if (!page) return null
  const raw = Array.isArray(body.tabs) ? body.tabs.slice(0, 60) : []
  const tabs: TabReport[] = []
  for (const one of raw) {
    if (!one || typeof one !== 'object') continue
    const tab = one as Record<string, unknown>
    const relative = text(tab.relative, MAX_PATH)
    if (!relative) continue
    tabs.push({ relative, dirty: bool(tab.dirty), active: bool(tab.active), preview: bool(tab.preview), agent: bool(tab.agent), readOnly: bool(tab.readOnly), hidden: bool(tab.hidden) })
  }
  const kehikkoRaw = body.kehikko as { key?: unknown; name?: unknown } | null | undefined
  const kehikko = kehikkoRaw && typeof kehikkoRaw === 'object' ? { key: text(kehikkoRaw.key, 128), name: text(kehikkoRaw.name, 128) } : null
  let here = pages.get(root)
  if (!here) pages.set(root, (here = new Map()))
  if (body.closing === true) here.delete(page)
  else here.set(page, { page, kehikko, tabs, at: Date.now() })
  while (here.size > 8) here.delete(here.keys().next().value as string)
  return null
}

/** The pages open on a project, freshest first, stale ones forgotten. */
export function pagesIn(root: string): PageReport[] {
  const here = pages.get(root)
  if (!here) return []
  const now = Date.now()
  for (const [id, one] of here) if (now - one.at > STALE_MS) here.delete(id)
  return [...here.values()].sort((a, b) => b.at - a.at)
}

/** For tests. */
export function forgetTabs(): void {
  pages.clear()
  held.clear()
  spellings.clear()
  for (const resolve of waiting.values()) resolve({})
  waiting.clear()
}

/** Whether a page is listening for orders on this project now. */
export const pageOpen = (root: string): boolean => topicsOf(root).some((topic) => watching(topic) > 0)

/** The orders held for a project, handed to a page as its stream opens, and forgotten. */
export function takeHeld(root: string): Order[] {
  const list = held.get(root) ?? []
  held.delete(root)
  return list
}

export const heldFor = (root: string): Order[] => held.get(root) ?? []

/** A page said what it did with an order. */
export function done(id: string, body: OrderDone): void {
  const resolve = waiting.get(id)
  if (!resolve) return
  waiting.delete(id)
  resolve(body)
}

export type Delivered = { kind: 'done'; done: OrderDone } | { kind: 'sent' } | { kind: 'held' } | { kind: 'no-page' }

/**
 * Give an order to the project's pages. A page carries it out and says so; without an answer in
 * `ORDER_WAIT_MS` it is `sent`. With no page open, an order to open files is held for the next page
 * (`held`); another order is `no-page`.
 */
export async function give(root: string, order: Order, waitMs: number = ORDER_WAIT_MS): Promise<Delivered> {
  if (!pageOpen(root)) {
    if (order.kind !== 'open') return { kind: 'no-page' }
    const list = held.get(root) ?? []
    list.push(order)
    while (list.length > HELD_ORDERS) list.shift()
    held.set(root, list)
    return { kind: 'held' }
  }
  const answer = new Promise<Delivered>((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(order.id)
      resolve({ kind: 'sent' })
    }, waitMs)
    waiting.set(order.id, (body) => {
      clearTimeout(timer)
      resolve({ kind: 'done', done: body })
    })
  })
  for (const topic of topicsOf(root)) publish(topic, { orders: [order] })
  return answer
}

export const orderId = (): string => randomUUID()

/* ---- What an agent is told -------------------------------------------- */

const said = (relative: string) => (withheld(relative) ? 'a file agents may not read' : relative)

/** The open tabs, in words, for the `tabs` tool. */
export function describeTabs(root: string, kehikko: string | null): string {
  const all = pagesIn(root)
  const shown = kehikko ? all.filter((one) => one.kehikko?.key === kehikko || one.kehikko?.name === kehikko) : all
  if (!all.length) return 'No Editor page is open on this project, so no tabs are open. open_files opens files as tabs; they are held until the Editor is next opened.'
  if (!shown.length) return `No Editor page on that kehikko has reported its tabs. Editor pages are open on: ${all.map((one) => one.kehikko?.name ?? 'an unnamed kehikko').join(', ')}.`
  const lines: string[] = []
  for (const one of shown) {
    if (shown.length > 1) lines.push(`On ${one.kehikko?.name ? `the kehikko “${one.kehikko.name}”` : 'a kehikko'}:`)
    if (!one.tabs.length) {
      lines.push('No tabs are open.')
      continue
    }
    for (const tab of one.tabs) {
      const marks = [
        tab.active ? 'active' : null,
        tab.dirty ? 'UNSAVED' : null,
        tab.preview ? 'preview' : null,
        tab.agent ? 'opened by an agent' : null,
        tab.readOnly ? 'read-only' : null,
      ].filter(Boolean)
      lines.push(`- ${tab.hidden ? 'a file agents may not read' : said(tab.relative)}${marks.length ? ` (${marks.join(', ')})` : ''}`)
    }
  }
  const unsaved = shown.flatMap((one) => one.tabs).filter((tab) => tab.dirty).length
  if (unsaved) lines.push('', `${unsaved === 1 ? 'One tab has' : `${unsaved} tabs have`} unsaved changes: what is on disk is not what the person sees there.`)
  return lines.join('\n')
}
