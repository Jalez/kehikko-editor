import { EMPTY, dirty, reduce, type Action, type Draft, type EditorState, type OpenedFile } from './state.ts'

/**
 * The open tabs, as a pure reducer over many `EditorState`s: one per file, each with every
 * protection the single file had (the changed-on-disk check, read-only owners, the size fence, an
 * explicit save), and the rules of a tab strip the way VS Code has them.
 *
 *  - **Preview.** A file opened by a single click from the canvas, from a search result or by a drag
 *    opens as a preview (drawn in italics). The next preview takes its place. Editing it, or
 *    double-clicking its tab, keeps it (`pin`).
 *  - **Never an edit discarded.** Only a preview tab is ever replaced, and a tab with unsaved changes
 *    is never a preview: the first edit keeps it.
 *  - **Where a new tab goes.** To the right of the active one, unless a position is given (a drop
 *    on the strip).
 *  - **Which tab becomes active on close.** The one used most recently before it.
 *  - **An agent's tabs** carry `agent: true` until the person does anything with them, and open in
 *    the background unless asked to take focus while the active tab is unedited (decided by the
 *    caller, which passes `focus`).
 */

export interface Reveal {
  line: number
  column?: number
  endLine?: number
  endColumn?: number
}

/** Where a tab was left: the selection and the scroll, kept per tab. */
export interface TabView {
  anchor: number
  head: number
  top: number
}

export interface Tab {
  /** Stable for the tab's life; never shown. */
  id: string
  /** The path it was asked for by: absolute, as the canvas, a drop or an agent spelled it. */
  path: string
  /** Project-relative once the server opened it; null while opening, or when it could not be. */
  relative: string | null
  preview: boolean
  /** Opened by an agent and not yet touched by the person. */
  agent: boolean
  state: EditorState
  /** Bumped when the editor must show new text (opened, reloaded, reverted). */
  generation: number
  view: TabView | null
  /** A place to scroll to and select once the text is in, then forgotten. */
  reveal: Reveal | null
}

export interface TabsState {
  tabs: Tab[]
  active: string | null
  /** Most recently used first, by id. */
  used: string[]
}

export const NO_TABS: TabsState = { tabs: [], active: null, used: [] }

/** At most this many tabs: past it the oldest saved tab that is not active closes. */
export const MAX_TABS = 40

export type TabsAction =
  | {
      type: 'open'
      id: string
      path: string
      relative?: string | null
      preview: boolean
      agent?: boolean
      focus: boolean
      reveal?: Reveal | null
      /** An index in the strip (a drop); else right of the active tab. */
      at?: number | null
      view?: TabView | null
    }
  | { type: 'opened'; id: string; file: OpenedFile; draft?: Draft | null; said?: string | null }
  /** Something for one tab's own reducer (an edit, a save, the watch). */
  | { type: 'file'; id: string; action: Action }
  | { type: 'activate'; id: string; by: 'person' | 'agent' }
  | { type: 'pin'; id: string }
  | { type: 'touched'; id: string }
  | { type: 'close'; ids: string[] }
  | { type: 'move'; id: string; to: number }
  | { type: 'view'; id: string; view: TabView }
  | { type: 'revealed'; id: string }
  | { type: 'reset' }

const samePath = (tab: Tab, path: string, relative?: string | null) =>
  tab.path === path || (relative !== undefined && relative !== null && tab.relative === relative) || (tab.relative !== null && tab.relative === path)

/** The tab showing a file, by the path asked or its project-relative path. */
export function tabFor(state: TabsState, path: string, relative?: string | null): Tab | null {
  return state.tabs.find((tab) => samePath(tab, path, relative)) ?? null
}

export function activeTab(state: TabsState): Tab | null {
  return state.tabs.find((tab) => tab.id === state.active) ?? null
}

export const tabDirty = (tab: Tab): boolean => dirty(tab.state)

const used = (list: string[], id: string) => [id, ...list.filter((one) => one !== id)]

function update(state: TabsState, id: string, change: (tab: Tab) => Tab): TabsState {
  let hit = false
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab
    hit = true
    return change(tab)
  })
  return hit ? { ...state, tabs } : state
}

/** Close the oldest saved, inactive tabs while there are too many. */
function bound(state: TabsState): TabsState {
  if (state.tabs.length <= MAX_TABS) return state
  const order = [...state.used].reverse()
  const closing = new Set<string>()
  let count = state.tabs.length
  for (const id of order) {
    if (count <= MAX_TABS) break
    const tab = state.tabs.find((one) => one.id === id)
    if (!tab || tab.id === state.active || tabDirty(tab)) continue
    closing.add(id)
    count -= 1
  }
  return closing.size ? closeTabs(state, [...closing]) : state
}

function closeTabs(state: TabsState, ids: readonly string[]): TabsState {
  const gone = new Set(ids)
  const tabs = state.tabs.filter((tab) => !gone.has(tab.id))
  const usedNow = state.used.filter((id) => !gone.has(id))
  let active = state.active
  if (active !== null && gone.has(active)) {
    active = usedNow.find((id) => tabs.some((tab) => tab.id === id)) ?? null
    if (active === null && tabs.length) {
      /* No history: the neighbour on the right, else the left, as a strip does. */
      const index = state.tabs.findIndex((tab) => tab.id === state.active)
      const right = state.tabs.slice(index + 1).find((tab) => !gone.has(tab.id))
      const left = [...state.tabs.slice(0, index)].reverse().find((tab) => !gone.has(tab.id))
      active = (right ?? left)?.id ?? null
    }
  }
  return { tabs, active, used: active ? used(usedNow, active) : usedNow }
}

export function reduceTabs(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open': {
      const existing = tabFor(state, action.path, action.relative)
      if (existing) {
        const tab: Tab = {
          ...existing,
          preview: existing.preview && action.preview,
          agent: existing.agent && Boolean(action.agent),
          reveal: action.reveal ?? existing.reveal,
        }
        const tabs = state.tabs.map((one) => (one.id === existing.id ? tab : one))
        const moved = action.at === undefined || action.at === null ? tabs : moveIn(tabs, existing.id, action.at)
        return action.focus ? { tabs: moved, active: existing.id, used: used(state.used, existing.id) } : { ...state, tabs: moved }
      }
      const tab: Tab = {
        id: action.id,
        path: action.path,
        relative: action.relative ?? null,
        preview: action.preview,
        agent: Boolean(action.agent),
        state: EMPTY,
        generation: 0,
        view: action.view ?? null,
        reveal: action.reveal ?? null,
      }
      /* A preview takes the place of the one preview there is, which never has unsaved changes. */
      const previewAt = action.preview ? state.tabs.findIndex((one) => one.preview && !tabDirty(one)) : -1
      let tabs: Tab[]
      let usedNow = state.used
      if (previewAt >= 0) {
        const replaced = state.tabs[previewAt]!
        tabs = state.tabs.map((one, index) => (index === previewAt ? tab : one))
        usedNow = usedNow.filter((id) => id !== replaced.id)
        if (action.at !== undefined && action.at !== null) tabs = moveIn(tabs, tab.id, action.at)
        const active = action.focus || state.active === replaced.id ? tab.id : state.active
        return bound({ tabs, active, used: active === tab.id ? used(usedNow, tab.id) : [...usedNow, tab.id] })
      }
      const activeIndex = state.tabs.findIndex((one) => one.id === state.active)
      const index = action.at !== undefined && action.at !== null ? Math.max(0, Math.min(action.at, state.tabs.length)) : activeIndex >= 0 ? activeIndex + 1 : state.tabs.length
      tabs = [...state.tabs.slice(0, index), tab, ...state.tabs.slice(index)]
      const active = action.focus || state.active === null ? tab.id : state.active
      return bound({ tabs, active, used: active === tab.id ? used(usedNow, tab.id) : [...usedNow, tab.id] })
    }
    case 'opened': {
      const next = update(state, action.id, (tab) => ({
        ...tab,
        relative: action.file.relative,
        state: reduce(tab.state, { type: 'opened', file: action.file, draft: action.draft ?? null, said: action.said ?? null }),
        generation: tab.generation + 1,
      }))
      /* The same file asked by two spellings (a link, `/var` and `/private/var`): one tab. */
      const twin = next.tabs.find((tab) => tab.id !== action.id && tab.relative === action.file.relative)
      if (!twin) return next
      const asked = next.tabs.find((tab) => tab.id === action.id)!
      const closed = closeTabs(next, [action.id])
      const active = next.active === action.id ? twin.id : closed.active
      return {
        tabs: closed.tabs.map((tab) => (tab.id === twin.id ? { ...tab, reveal: asked.reveal ?? tab.reveal } : tab)),
        active,
        used: active ? used(closed.used, active) : closed.used,
      }
    }
    case 'file': {
      return update(state, action.id, (tab) => {
        const state2 = reduce(tab.state, action.action)
        const fresh = action.action.type === 'revert' || (action.action.type === 'trouble')
        const editedAway = action.action.type === 'edited' && dirty(state2)
        return {
          ...tab,
          state: state2,
          /* The first edit keeps a preview, and is the person touching an agent's tab. */
          preview: editedAway ? false : tab.preview,
          agent: action.action.type === 'edited' ? false : tab.agent,
          generation: fresh ? tab.generation + 1 : tab.generation,
        }
      })
    }
    case 'activate': {
      if (!state.tabs.some((tab) => tab.id === action.id)) return state
      const next = { ...state, active: action.id, used: used(state.used, action.id) }
      return action.by === 'person' ? update(next, action.id, (tab) => (tab.agent ? { ...tab, agent: false } : tab)) : next
    }
    case 'pin':
      return update(state, action.id, (tab) => (tab.preview || tab.agent ? { ...tab, preview: false, agent: false } : tab))
    case 'touched':
      return update(state, action.id, (tab) => (tab.agent ? { ...tab, agent: false } : tab))
    case 'close':
      return closeTabs(state, action.ids)
    case 'move':
      return { ...state, tabs: moveIn(state.tabs, action.id, action.to) }
    case 'view':
      return update(state, action.id, (tab) => ({ ...tab, view: action.view }))
    case 'revealed':
      return update(state, action.id, (tab) => (tab.reveal ? { ...tab, reveal: null } : tab))
    case 'reset':
      return NO_TABS
  }
}

/** Move a tab to an index (counted in the strip as it is before the move). */
function moveIn(tabs: Tab[], id: string, to: number): Tab[] {
  const from = tabs.findIndex((tab) => tab.id === id)
  if (from < 0) return tabs
  const target = Math.max(0, Math.min(to, tabs.length))
  const without = tabs.filter((tab) => tab.id !== id)
  const at = target > from ? target - 1 : target
  return [...without.slice(0, at), tabs[from]!, ...without.slice(at)]
}

/* ---- What a tab is called --------------------------------------------- */

/**
 * The words on each tab: the file's name, and — when two tabs share a name — the shortest part of
 * the parent folders that tells them apart, as VS Code does (`index.ts · src`, `index.ts · test`).
 */
export function tabLabels(paths: readonly string[]): { name: string; folder: string | null }[] {
  const parts = paths.map((path) => path.split('/').filter(Boolean))
  return parts.map((mine, index) => {
    const name = mine[mine.length - 1] ?? paths[index] ?? ''
    const twins = parts.filter((other, j) => j !== index && other[other.length - 1] === name)
    if (!twins.length) return { name, folder: null }
    const folders = mine.slice(0, -1)
    for (let depth = 1; depth <= folders.length; depth += 1) {
      const tail = folders.slice(-depth).join('/')
      const clash = twins.some((other) => other.slice(0, -1).slice(-depth).join('/') === tail)
      if (!clash) return { name, folder: depth < folders.length ? `…/${tail}` : tail }
    }
    return { name, folder: folders.length ? folders.join('/') : null }
  })
}

/* ---- What is kept for the container ----------------------------------- */

/** One tab as kept by the host for this container: the file, how it is open, and where it was left. */
export interface KeptTab {
  path: string
  preview?: boolean
  view?: TabView | null
}

export interface KeptTabs {
  tabs: KeptTab[]
  active: string | null
}

/** The host keeps at most this many characters of a module's state (`LIMITS.MODULE_STATE`, 4 KiB); the tabs take at most this. */
export const KEPT_TABS_CHARS = 3000

/** What to keep: relative paths, the active one, each tab's view, cut to fit the host's bound. */
export function keptOf(state: TabsState): KeptTabs {
  const tabs: KeptTab[] = state.tabs
    .filter((tab) => tab.relative !== null)
    .map((tab) => ({ path: tab.relative!, ...(tab.preview ? { preview: true } : {}), ...(tab.view ? { view: tab.view } : {}) }))
  const active = activeTab(state)?.relative ?? null
  const kept: KeptTabs = { tabs, active }
  /* Views first, then the tabs furthest from the active one, until it fits. */
  if (JSON.stringify(kept).length > KEPT_TABS_CHARS) for (const one of kept.tabs) delete one.view
  while (JSON.stringify(kept).length > KEPT_TABS_CHARS && kept.tabs.length > 1) {
    const index = kept.tabs.findIndex((one) => one.path === active)
    kept.tabs.splice(index > kept.tabs.length / 2 ? 0 : kept.tabs.length - 1, 1)
  }
  return kept
}

/** A kept value read back, every field checked; anything else is no tabs. */
export function readKept(value: unknown): KeptTabs {
  if (!value || typeof value !== 'object') return { tabs: [], active: null }
  const raw = value as { tabs?: unknown; active?: unknown }
  const tabs: KeptTab[] = []
  if (Array.isArray(raw.tabs)) {
    for (const one of raw.tabs.slice(0, MAX_TABS)) {
      if (!one || typeof one !== 'object') continue
      const path = (one as { path?: unknown }).path
      if (typeof path !== 'string' || !path || path.length > 4096 || path.startsWith('/') || path.split('/').includes('..')) continue
      const view = (one as { view?: unknown }).view as Partial<TabView> | undefined
      const goodView =
        view && [view.anchor, view.head, view.top].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
          ? { anchor: view.anchor!, head: view.head!, top: view.top! }
          : null
      tabs.push({ path, ...((one as { preview?: unknown }).preview === true ? { preview: true } : {}), ...(goodView ? { view: goodView } : {}) })
    }
  }
  const active = typeof raw.active === 'string' && tabs.some((one) => one.path === raw.active) ? raw.active : null
  return { tabs, active }
}
