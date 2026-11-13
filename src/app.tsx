import { fileDrag, type FileDrag, type HeaderItem, type PagePoint, type PressValue } from 'kehikot-module-protocol'
import type { HostEvents } from 'kehikot-module-protocol/client'
import { Cover, coverFor, useHost, useKept, useServerStanding, type Host as ProtocolHost } from 'kehikot-module-protocol/client/react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType, type DragEvent as ReactDragEvent } from 'react'

import { ID } from '../manifest.ts'

import defaults from '@/commands/keybindings.default.json'
import { COMMANDS, commandInfo } from '@/commands/list'
import { hear, keymap, keysFor, pressOf, sayKey, type WhenContext } from '@/commands/keys'
import { HeaderMenus } from '@/components/header-menus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { compare, hunks } from '@/edit/diff'
import { footerItems } from '@/edit/footer'
import { headerItems, recentPressed } from '@/edit/header'
import { keepDraft, keyOf, noteRecent, readDraftFor, readRecent } from '@/edit/kept'
import { dirty, saveRefusal, type EditorState } from '@/edit/state'
import { NO_TABS, activeTab, keptOf, readKept, reduceTabs, tabDirty, tabFor, type Reveal, type Tab, type TabsState } from '@/edit/tabs'
import { ClosePrompt } from '@/view/close-prompt'
import { CodeEditor, type CodeEditorProps, type EditorHandle } from '@/view/code-editor'
import { KeybindingsView } from '@/view/keybindings-view'
import { ContextMenu, type MenuItem } from '@/view/menu'
import { Picker, PREFIX, type PickItem, type PickList, type PickMode } from '@/view/picker'
import { NO_SEARCH, SearchView, type SearchState } from '@/view/search-view'
import { TabStrip } from '@/view/tab-strip'
import { api as realApi, type Api, type Order, type OrderDone, type SearchQuery, type Target } from '@/wire/api'
import { useKeeps } from '@/wire/keeps'

type Press = { item: string; value?: PressValue }
type PressAnswer = string | true | void
type GotoHandler = NonNullable<HostEvents['onGoto']>
type Drop = { file: FileDrag; at: PagePoint }

/** What the screen needs from the host. A plain object, so a test can draw the screen without one. */
export type Host = Pick<ProtocolHost, 'where' | 'project' | 'projectPath' | 'projectId' | 'passage' | 'header'> &
  Partial<Pick<ProtocolHost, 'footer' | 'drawsFooter' | 'kept' | 'read' | 'remember' | 'ready' | 'kehikko'>>

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(`${(navigator as { platform?: string }).platform ?? ''} ${navigator.userAgent ?? ''}`)

/** Each page's own id, for the agent door to tell several Editor containers apart. */
const PAGE = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`

let nextTab = 0
const newId = () => `tab${++nextTab}`

/** The project's folder with one trailing slash. */
const rootOf = (projectPath: string) => (projectPath.endsWith('/') ? projectPath : `${projectPath}/`)

/** A query's characters in order, case-insensitive: the indices matched, or null. */
function subsequence(text: string, query: string): number[] | null {
  if (!query) return []
  const lower = text.toLowerCase()
  const hits: number[] = []
  let from = 0
  for (const char of query.toLowerCase()) {
    if (char === ' ') continue
    const at = lower.indexOf(char, from)
    if (at < 0) return null
    hits.push(at)
    from = at + 1
  }
  return hits
}

/**
 * The page.
 *
 * `App` connects to the host; `Screen` is everything else, drawn from a plain `Host` and an `Api`
 * so the tests can drive it with a fake of each and a textarea standing in for CodeMirror.
 */
export function App() {
  const press = useRef<(press: Press) => PressAnswer>(() => 'The Editor is not ready yet.')
  const drop = useRef<(drop: Drop) => void>(() => {})
  const onGoto = useCallback<GotoHandler>((_message, answer) => {
    answer(false, 'The Editor edits the files the canvas points at; there is nothing here to walk to by reference.')
  }, [])
  const host = useHost(ID, { onPress: (one) => press.current(one), onGoto, onDrop: (one) => drop.current(one) })
  return <Screen host={host} press={press} drop={drop} />
}

export function Screen({
  host,
  api = realApi,
  Code = CodeEditor,
  press,
  drop,
  mac = MAC,
}: {
  host: Host
  api?: Api
  Code?: ComponentType<CodeEditorProps>
  /** Where the screen puts its press handler, for the host's presses to reach. */
  press?: { current: (press: Press) => PressAnswer }
  /** Where the screen puts its handler for a file the host hands on from another module's drag. */
  drop?: { current: (drop: Drop) => void }
  mac?: boolean
}) {
  const { where, projectPath, projectId, passage } = host
  const key = keyOf({ projectId, projectPath })
  const server = useServerStanding()

  const [tabs, dispatch] = useReducer(reduceTabs, NO_TABS)
  /* The latest tabs, for handlers that run outside a render (a press, a key, a timer). */
  const now = useRef<TabsState>(tabs)
  now.current = tabs
  const active = activeTab(tabs)
  const state: EditorState | null = active?.state ?? null

  const keeps = useKeeps(host)
  /* Wrap lines and the open tabs are kept by the host for this container (this module on this
     kehikko) and back after a restart (2.51.0). Never browser storage. */
  const [wrap, setWrap] = useKept(keeps, 'wrap', false)
  const [keptTabs, setKeptTabs] = useKept<unknown>(keeps, 'tabs', null, () => true)
  const [recent, setRecent] = useState<string[]>(() => readRecent(key))
  const [comparing, setComparing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ initial: string; fixed?: PickMode | null; choices?: Target[] } | null>(null)
  const [menu, setMenu] = useState<{ kind: 'tab'; id: string; x: number; y: number } | { kind: 'text'; offset: number; x: number; y: number } | null>(null)
  const [prompt, setPrompt] = useState<{ ids: string[] } | null>(null)
  const [searchShown, setSearchShown] = useState(false)
  const [searchState, setSearchState] = useState<SearchState>(NO_SEARCH)
  const [searchFocus, setSearchFocus] = useState(0)
  const [keysView, setKeysView] = useState<{ mode: 'list' | 'json' } | null>(null)
  const [userKeys, setUserKeys] = useState('')
  const [keysDraft, setKeysDraft] = useState<string | null>(null)
  const [keysSaving, setKeysSaving] = useState(false)
  const [keysSaid, setKeysSaid] = useState<string | null>(null)
  const [chord, setChord] = useState<string | null>(null)
  const chordRef = useRef<string | null>(null)
  chordRef.current = chord
  const handle = useRef<EditorHandle | null>(null)
  const focus = useRef({ text: false, tab: false, search: false })
  const loading = useRef(new Set<string>())
  const closed = useRef<string[]>([])
  const restored = useRef<string | null>(null)
  const panelId = 'editor-panel'

  const map = useMemo(() => keymap(defaults, userKeys, mac), [userKeys, mac])
  const keyOfCommand = useCallback((command: string) => {
    const keys = keysFor(map, command)
    const parts = keys.find((one) => !one.includes('click')) ?? keys[0]
    return parts ? sayKey(parts.split(' '), mac) : null
  }, [map, mac])

  useEffect(() => setRecent(readRecent(key)), [key])
  useEffect(() => {
    let live = true
    void api.keybindings?.().then((got) => {
      if (!live || !got) return
      setUserKeys(got.text)
      if (got.problem) setKeysSaid(got.problem)
    })
    return () => {
      live = false
    }
  }, [api])

  /* ---- Opening ---------------------------------------------------- */

  const absolute = useCallback((relative: string) => (projectPath ? `${rootOf(projectPath)}${relative}` : relative), [projectPath])

  /** Open a file as a tab, or focus the tab it has. The text is read when its tab is first shown. */
  const openPath = useCallback(
    (path: string, options: { preview: boolean; focus: boolean; reveal?: Reveal | null; at?: number | null; agent?: boolean; relative?: string | null; view?: Tab['view'] }) => {
      const id = newId()
      dispatch({ type: 'open', id, path, relative: options.relative ?? null, preview: options.preview, focus: options.focus, reveal: options.reveal ?? null, at: options.at ?? null, agent: options.agent ?? false, view: options.view ?? null })
      return id
    },
    [],
  )

  const load = useCallback(
    async (tab: Tab, options: { draft?: boolean; said?: string | null } = {}) => {
      if (!projectPath || loading.current.has(tab.id)) return
      loading.current.add(tab.id)
      try {
        const asked = await api.open(projectPath, tab.path)
        if (!now.current.tabs.some((one) => one.id === tab.id)) return
        if (!asked.ok) {
          if (asked.kind === 'down' || asked.kind === 'cancelled' || asked.kind === 'stale') return
          dispatch({ type: 'file', id: tab.id, action: { type: 'trouble', said: asked.error } })
          return
        }
        const file = asked.body
        if (options.draft === false) keepDraft(key, file.relative, null)
        const draft = options.draft === false ? null : readDraftFor(key, file.relative)
        dispatch({ type: 'opened', id: tab.id, file, draft, said: options.said ?? null })
        setRecent(noteRecent(key, file.relative))
      } finally {
        loading.current.delete(tab.id)
      }
    },
    [api, key, projectPath],
  )

  /* The active tab's text is read once it is shown. */
  useEffect(() => {
    if (!active || active.state.file || active.state.trouble) return
    void load(active)
  }, [active, load])

  /* A new project: nothing from the old one stays open. */
  useEffect(() => {
    dispatch({ type: 'reset' })
    setComparing(false)
    restored.current = null
  }, [projectPath])

  /* The tabs kept for this container come back once, for this project. */
  useEffect(() => {
    if (!projectPath || restored.current === projectPath) return
    if (where !== 'hosted' && where !== 'unhosted') return
    restored.current = projectPath
    const kept = readKept(keptTabs)
    for (const one of kept.tabs) {
      openPath(absolute(one.path), { preview: Boolean(one.preview), focus: one.path === kept.active, relative: one.path, view: one.view ?? null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per project
  }, [projectPath, where])

  /* What is kept follows the tabs: their files, the active one, and where each was left. */
  const keptNow = useMemo(() => JSON.stringify(keptOf(tabs)), [tabs])
  useEffect(() => {
    if (restored.current !== projectPath) return
    if (JSON.stringify(readKept(keptTabs)) === keptNow) return
    setKeptTabs(JSON.parse(keptNow))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- written when the tabs change
  }, [keptNow])

  /* Follow the canvas: a file it points at opens in the preview tab, or its tab is focused. Never an edit lost. */
  const wanted = passage?.path ?? null
  useEffect(() => {
    if (!projectPath || !wanted) return
    openPath(wanted, { preview: true, focus: true })
  }, [projectPath, wanted, openPath])

  /* ---- Drafts, the watch, and what agents are told ---------------- */

  const unsaved = state ? dirty(state) : false
  const relative = state?.file?.relative ?? null
  const activeId = active?.id ?? null

  /* The draft follows the text: kept while it differs from the disk, forgotten when it does not. */
  useEffect(() => {
    if (!relative || !activeId) return
    const timer = setTimeout(() => {
      const tab = now.current.tabs.find((one) => one.id === activeId)
      if (!tab || tab.state.file?.relative !== relative) return
      keepDraft(key, relative, dirty(tab.state) && tab.state.base ? { version: tab.state.base, text: tab.state.text } : null)
    }, 250)
    return () => clearTimeout(timer)
  }, [key, relative, activeId, state?.text, state?.base])

  /*
   * The watch, on the active tab: its version on disk, asked when the server says the file was written
   * (its own stream, whose first event is also the first ask), and when the window is focused again.
   * A tab shown again is asked again as its stream opens, so a change while it was behind is seen.
   */
  const filePath = state?.file?.path ?? null
  useEffect(() => {
    if (!projectPath || !filePath || !activeId) return
    let live = true
    const look = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const stamp = await api.stamp(projectPath, filePath)
      const tab = now.current.tabs.find((one) => one.id === activeId)
      if (!live || !stamp || tab?.state.file?.path !== filePath) return
      dispatch({ type: 'file', id: activeId, action: stamp.version === null ? { type: 'stamp', version: null, gone: stamp.gone ?? 'The file is no longer there.' } : { type: 'stamp', version: stamp.version } })
    }
    const stop = api.changes(projectPath, filePath, () => void look())
    const onFocus = () => void look()
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      stop()
      window.removeEventListener('focus', onFocus)
    }
  }, [api, projectPath, filePath, activeId])

  /* Changed on disk with nothing unsaved here: take the new text, and say so. */
  useEffect(() => {
    if (active && active.state.disk.state === 'changed' && !unsaved && !active.state.saving && filePath) {
      void load(active, { said: 'Reloaded: the file changed on disk.' })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on the disk's news
  }, [state?.disk, unsaved, state?.saving, filePath])

  /* What the agent door may say: the active file, whether unsaved, its unsaved text, and every tab. */
  const tabsReport = useMemo(
    () =>
      JSON.stringify(
        tabs.tabs
          .filter((tab) => tab.relative)
          .map((tab) => ({ relative: tab.relative, dirty: tabDirty(tab), active: tab.id === tabs.active, preview: tab.preview, agent: tab.agent, readOnly: Boolean(tab.state.file?.readOnly), hidden: Boolean(tab.state.file?.hidden) })),
      ),
    [tabs],
  )
  const kehikko = host.kehikko ? { key: host.kehikko.key ?? null, name: host.kehikko.name ?? null } : null
  const kehikkoSaid = JSON.stringify(kehikko)
  useEffect(() => {
    if (!projectPath) return
    const timer = setTimeout(() => {
      const tab = activeTab(now.current)
      const current = tab?.state ?? null
      void api.editing(projectPath, {
        relative: current?.file?.relative ?? null,
        dirty: current ? dirty(current) : false,
        version: current?.base ?? null,
        readOnly: current?.file?.readOnly ?? null,
        hidden: current?.file?.hidden ?? false,
        text: current && dirty(current) ? current.text : null,
        page: PAGE,
        kehikko: JSON.parse(kehikkoSaid),
        tabs: JSON.parse(tabsReport),
      })
    }, unsaved ? 1000 : 0)
    return () => clearTimeout(timer)
  }, [api, projectPath, relative, unsaved, state?.base, state?.text, state?.file?.readOnly, state?.file?.hidden, tabsReport, kehikkoSaid])

  /* Leaving the page with unsaved changes in any tab asks first (and the drafts are kept either way). */
  const anyUnsaved = tabs.tabs.some(tabDirty)
  useEffect(() => {
    if (!anyUnsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [anyUnsaved])

  /* ---- Acts on a tab ---------------------------------------------- */

  const saveTab = useCallback(
    async (id: string, over?: string): Promise<string | true> => {
      const tab = now.current.tabs.find((one) => one.id === id)
      if (!tab) return 'That tab is closed.'
      const current = tab.state
      const refusal = saveRefusal(current)
      if (refusal && !(over && current.file && !current.file.readOnly && !current.saving)) return refusal
      if (!projectPath || !current.file) return 'No file is open.'
      const sent = current.text
      dispatch({ type: 'file', id, action: { type: 'saving' } })
      const answer = await api.save(projectPath, current.file.path, sent, over ?? current.base ?? '')
      if (answer.kind === 'saved') {
        dispatch({ type: 'file', id, action: { type: 'saved', text: sent, version: answer.version, unchanged: answer.unchanged } })
        const after = now.current.tabs.find((one) => one.id === id)
        if (!after || after.state.text === sent) keepDraft(key, current.file.relative, null)
        if (id === now.current.active) setComparing(false)
        return true
      }
      if (answer.kind === 'conflict') {
        dispatch({ type: 'file', id, action: { type: 'conflict', version: answer.version, text: answer.text, said: answer.said } })
        return answer.said
      }
      dispatch({ type: 'file', id, action: { type: 'refused', said: answer.said } })
      return answer.said
    },
    [api, key, projectPath],
  )

  const save = useCallback(
    (over?: string) => {
      const id = now.current.active
      if (!id) return 'No file is open.'
      const tab = activeTab(now.current)!
      const refusal = saveRefusal(tab.state)
      if (refusal && !over) return refusal
      void saveTab(id, over)
      return true as const
    },
    [saveTab],
  )

  const reload = useCallback(() => {
    const tab = activeTab(now.current)
    if (!tab?.state.file) return 'No file is open.'
    void load(tab, { draft: false, said: 'Reloaded from disk.' })
    return true as const
  }, [load])

  const revert = useCallback(() => {
    const tab = activeTab(now.current)
    if (!tab || !dirty(tab.state) || !tab.state.file) return 'There are no unsaved changes to revert.'
    keepDraft(key, tab.state.file.relative, null)
    dispatch({ type: 'file', id: tab.id, action: { type: 'revert' } })
    setComparing(false)
    return true as const
  }, [key])

  const openRecent = useCallback((relativePath: string) => openPath(absolute(relativePath), { preview: false, focus: true, relative: relativePath }), [absolute, openPath])

  /* The comparison needs what is on disk now: a refused save brought it, or it is read here. */
  const toggleCompare = useCallback(async () => {
    const tab = activeTab(now.current)
    if (comparing) return setComparing(false)
    if (!tab) return
    if (!tab.state.conflict && tab.state.file && projectPath) {
      const asked = await api.open(projectPath, tab.state.file.path)
      if (!asked.ok) return dispatch({ type: 'file', id: tab.id, action: { type: 'refused', said: asked.error } })
      dispatch({ type: 'file', id: tab.id, action: { type: 'conflict', version: asked.body.version, text: asked.body.text, said: null } })
    }
    setComparing(true)
  }, [api, comparing, projectPath])

  const activate = useCallback((id: string) => {
    dispatch({ type: 'activate', id, by: 'person' })
    setComparing(false)
  }, [])

  /* ---- Closing ---------------------------------------------------- */

  const closeNow = useCallback((ids: string[]) => {
    for (const id of ids) {
      const tab = now.current.tabs.find((one) => one.id === id)
      if (tab?.relative) closed.current = [tab.relative, ...closed.current.filter((one) => one !== tab.relative)].slice(0, 20)
    }
    dispatch({ type: 'close', ids })
    setComparing(false)
  }, [])

  /** Close tabs; any with unsaved changes asks Save / Don't save / Cancel first. */
  const requestClose = useCallback(
    (ids: string[]) => {
      const list = ids.filter((id) => now.current.tabs.some((tab) => tab.id === id))
      if (!list.length) return 'There is no tab to close.'
      const unsavedOnes = list.filter((id) => tabDirty(now.current.tabs.find((tab) => tab.id === id)!))
      if (!unsavedOnes.length) {
        closeNow(list)
        return true as const
      }
      setPrompt({ ids: list })
      return true as const
    },
    [closeNow],
  )

  const promptAnswer = useCallback(
    async (answer: 'save' | 'discard' | 'cancel') => {
      const asked = prompt
      setPrompt(null)
      if (!asked || answer === 'cancel') return
      const tabsNow = now.current.tabs.filter((tab) => asked.ids.includes(tab.id))
      if (answer === 'discard') {
        for (const tab of tabsNow) if (tab.state.file && tabDirty(tab)) keepDraft(key, tab.state.file.relative, null)
        closeNow(tabsNow.map((tab) => tab.id))
        return
      }
      const closing: string[] = []
      for (const tab of tabsNow) {
        if (!tabDirty(tab)) {
          closing.push(tab.id)
          continue
        }
        const saved = await saveTab(tab.id)
        if (saved === true) closing.push(tab.id)
        else setNotice(`${tab.relative ?? tab.path} was not closed: ${saved}`)
      }
      closeNow(closing)
    },
    [prompt, key, closeNow, saveTab],
  )

  /* ---- Go to definition, symbols, quick open ------------------------ */

  const openTarget = useCallback(
    (target: Target, preview = false) => {
      const reveal = { line: target.line, column: target.column + 1 }
      const here = activeTab(now.current)
      if (here?.relative === target.relative) {
        handle.current?.goTo(reveal.line, reveal.column)
        return
      }
      openPath(absolute(target.relative), { preview, focus: true, reveal, relative: target.relative })
    },
    [absolute, openPath],
  )

  const goToDefinition = useCallback(
    async (offset?: number) => {
      const tab = activeTab(now.current)
      if (!tab?.state.file || !projectPath || !api.definition) return 'No file is open.'
      const at = offset ?? handle.current?.offset() ?? 0
      const word = handle.current?.wordAt(at) ?? ''
      setNotice(word ? `Looking for the definition of “${word}”…` : 'Looking for the definition…')
      const answer = await api.definition(projectPath, tab.state.file.path, at, dirty(tab.state) ? tab.state.text : null)
      if ('error' in answer) {
        setNotice(answer.error)
        return answer.error
      }
      if (!answer.targets.length) {
        const said = answer.said ?? (word ? `No definition found for “${word}”.` : 'No definition found.')
        setNotice(said)
        return said
      }
      setNotice(null)
      if (answer.targets.length === 1) openTarget(answer.targets[0]!)
      else setPicker({ initial: '', fixed: 'choose', choices: answer.targets })
      return true
    },
    [api, projectPath, openTarget],
  )

  const provide = useCallback(
    async (mode: PickMode, query: string): Promise<PickList> => {
      const tab = activeTab(now.current)
      if (mode === 'choose') {
        const choices = picker?.choices ?? []
        return {
          said: `${choices.length} definitions. Pick one.`,
          items: choices.map((one, i) => ({ id: `d${i}`, label: one.relative.split('/').pop() ?? one.relative, description: `${one.relative}:${one.line}`, detail: one.preview?.trim().slice(0, 80) ?? null })),
        }
      }
      if (mode === 'commands') {
        const items: PickItem[] = []
        for (const one of COMMANDS) {
          if (one.id === 'palette.show') continue
          const hits = subsequence(one.title, query)
          if (hits === null && !one.id.toLowerCase().includes(query.toLowerCase())) continue
          items.push({ id: one.id, label: one.title, hits: hits ?? [], description: one.category, shortcut: keyOfCommand(one.id) })
        }
        return { items, said: items.length ? null : 'No matching commands.' }
      }
      if (mode === 'line') {
        const lines = handle.current?.lineCount() ?? 0
        if (!tab?.state.file) return { items: [], said: 'Open a file to go to a line in it.' }
        const [line, column] = query.split(/[:,]/).map((one) => Number(one))
        if (!query) return { items: [], said: `Type a line number between 1 and ${lines}, then Enter. A column after a colon: 12:5.` }
        if (!Number.isInteger(line) || line! < 1 || line! > lines) return { items: [], said: `There is no line ${query} in this file: it has ${lines}.` }
        return { items: [{ id: `l${line}:${column ?? 1}`, label: `Go to line ${line}${column ? `, column ${column}` : ''}` }] }
      }
      if (mode === 'symbols') {
        if (!tab?.state.file || !projectPath || !api.outline) return { items: [], said: 'Open a file to go to a symbol in it.' }
        const symbols = await api.outline(projectPath, tab.state.file.path, dirty(tab.state) ? tab.state.text : null)
        if (!symbols) return { items: [], said: 'The symbols of this file could not be read.' }
        const items = symbols
          .map((one, i) => ({ one, i, hits: subsequence(one.name, query) }))
          .filter((x) => x.hits !== null)
          .map(({ one, i, hits }) => ({ id: `s${i}:${one.line}:${one.column}`, label: `${'  '.repeat(Math.min(one.depth ?? 0, 6))}${one.name}`, hits: (hits ?? []).map((h) => h + 2 * Math.min(one.depth ?? 0, 6)), description: one.kind, detail: `${one.line}` }))
        return { items, said: items.length ? null : symbols.length ? 'No matching symbols.' : 'This file has no symbols the Editor can find.' }
      }
      if (mode === 'projectSymbols') {
        if (!projectPath || !api.symbols) return { items: [], said: 'No project is open.' }
        if (!query) return { items: [], said: 'Type the name of a function, class or other symbol.' }
        const symbols = await api.symbols(projectPath, query)
        if (!symbols) return { items: [], said: 'The project’s symbols could not be read.' }
        const items = symbols.map((one, i) => ({ id: `p${i}`, label: one.name, hits: (one as { hits?: number[] }).hits ?? [], description: one.relative ?? '', detail: one.kind }))
        return { items, said: items.length ? null : 'No matching symbols.' }
      }
      /* files */
      if (!query) {
        const open = now.current.tabs.filter((one) => one.relative).map((one) => one.relative!)
        const seen = new Set<string>()
        const items: PickItem[] = []
        for (const [group, list] of [['open tabs', open], ['recently opened', recent]] as const) {
          for (const one of list) {
            if (seen.has(one)) continue
            seen.add(one)
            items.push({ id: `f:${one}`, label: one.split('/').pop() ?? one, description: one.split('/').slice(0, -1).join('/'), group })
          }
        }
        return { items, said: items.length ? null : 'Type part of a file’s name. > for commands, @ for symbols in the file, # for symbols in the project, : for a line.' }
      }
      if (!projectPath || !api.files) return { items: [], said: 'No project is open.' }
      const found = await api.files(projectPath, query)
      if (!found) return { items: [], said: 'The project’s files could not be listed.' }
      const items = found.files.map((one) => {
        const name = one.relative.split('/').pop() ?? one.relative
        const nameStart = one.relative.length - name.length
        return { id: `f:${one.relative}`, label: name, hits: one.hits.filter((h) => h >= nameStart).map((h) => h - nameStart), description: one.relative.slice(0, Math.max(0, nameStart - 1)) }
      })
      return { items, said: items.length ? (found.truncated ? 'Only part of a very large project was listed.' : null) : 'No matching files.' }
    },
    [api, projectPath, recent, picker, keyOfCommand],
  )

  /* ---- Commands --------------------------------------------------- */

  const run = useRef<(command: string, arg?: number) => PressAnswer | Promise<PressAnswer> | Promise<string | true>>(() => undefined)

  const onPick = useCallback(
    (mode: PickMode, item: PickItem) => {
      setPicker(null)
      if (mode === 'commands') {
        void run.current(item.id)
        return
      }
      if (mode === 'choose') {
        const target = picker?.choices?.[Number(item.id.slice(1))]
        if (target) openTarget(target)
        return
      }
      if (mode === 'line' || mode === 'symbols') {
        const [line, column] = item.id.slice(1).split(':').slice(mode === 'symbols' ? 1 : 0).map(Number)
        if (line) requestAnimationFrame?.(() => handle.current?.goTo(line, (column ?? (mode === 'symbols' ? 0 : 1)) + (mode === 'symbols' ? 1 : 0)))
        return
      }
      if (mode === 'projectSymbols') {
        void provide('projectSymbols', '').then(() => undefined)
        return
      }
      if (item.id.startsWith('f:')) {
        const rel = item.id.slice(2)
        openPath(absolute(rel), { preview: false, focus: true, relative: rel })
      }
    },
    [picker, openTarget, provide, openPath, absolute],
  )

  /* Project symbols carry where they are; the picker hands back the item, so they are kept by id. */
  const projectSymbolsSeen = useRef(new Map<string, { relative: string; line: number; column: number }>())
  const provideWithSymbols = useCallback(
    async (mode: PickMode, query: string): Promise<PickList> => {
      if (mode !== 'projectSymbols' || !projectPath || !api.symbols || !query) return provide(mode, query)
      const symbols = await api.symbols(projectPath, query)
      if (!symbols) return { items: [], said: 'The project’s symbols could not be read.' }
      projectSymbolsSeen.current.clear()
      const items = symbols.map((one, i) => {
        projectSymbolsSeen.current.set(`p${i}`, { relative: one.relative ?? '', line: one.line, column: one.column })
        return { id: `p${i}`, label: one.name, hits: (one as { hits?: number[] }).hits ?? [], description: one.relative ?? '', detail: one.kind }
      })
      return { items, said: items.length ? null : 'No matching symbols.' }
    },
    [api, projectPath, provide],
  )
  const onPickAll = useCallback(
    (mode: PickMode, item: PickItem, query: string) => {
      if (mode === 'projectSymbols') {
        setPicker(null)
        const at = projectSymbolsSeen.current.get(item.id)
        if (at?.relative) openTarget({ relative: at.relative, line: at.line, column: at.column })
        return
      }
      if (mode === 'line' && item.id === 'line') {
        setPicker(null)
        const [line, column] = query.split(/[:,]/).map(Number)
        if (line) handle.current?.goTo(line, column || 1)
        return
      }
      onPick(mode, item)
    },
    [onPick, openTarget],
  )

  const copy = useCallback((text: string) => {
    try {
      void navigator.clipboard?.writeText(text)
      setNotice('Copied.')
    } catch {
      setNotice('The clipboard is not available here.')
    }
  }, [])

  const tabsAround = useCallback((id: string | null, which: 'others' | 'right' | 'saved' | 'all') => {
    const list = now.current.tabs
    const index = list.findIndex((tab) => tab.id === id)
    if (which === 'others') return list.filter((tab) => tab.id !== id).map((tab) => tab.id)
    if (which === 'right') return index < 0 ? [] : list.slice(index + 1).map((tab) => tab.id)
    if (which === 'saved') return list.filter((tab) => !tabDirty(tab)).map((tab) => tab.id)
    return list.map((tab) => tab.id)
  }, [])

  const step = useCallback((by: number, strip: boolean) => {
    const list = now.current
    if (list.tabs.length < 2) return
    if (strip) {
      const index = list.tabs.findIndex((tab) => tab.id === list.active)
      const next = list.tabs[(index + by + list.tabs.length) % list.tabs.length]!
      activate(next.id)
      return
    }
    /* Most recently used: Ctrl+Tab goes to the one before, again to the one before that. */
    const order = list.used.filter((id) => list.tabs.some((tab) => tab.id === id))
    const next = order[(by > 0 ? 1 : order.length - 1) % order.length]
    if (next) activate(next)
  }, [activate])

  const commands = useCallback(
    (command: string, arg?: number, target?: string | null): PressAnswer | Promise<PressAnswer> | Promise<string | true> => {
      const tabId = target ?? now.current.active
      const tab = now.current.tabs.find((one) => one.id === tabId) ?? null
      switch (command) {
        case 'palette.show':
          setPicker({ initial: PREFIX.commands })
          return true
        case 'quickOpen.file':
          setPicker({ initial: '' })
          return true
        case 'editor.goToSymbol':
          setPicker({ initial: PREFIX.symbols })
          return true
        case 'workspace.goToSymbol':
          setPicker({ initial: PREFIX.projectSymbols })
          return true
        case 'editor.goToLine':
          setPicker({ initial: PREFIX.line })
          return true
        case 'editor.goToDefinition':
        case 'editor.openImport':
          return goToDefinition(arg)
        case 'editor.save':
          return save()
        case 'editor.saveAll': {
          const list = now.current.tabs.filter((one) => tabDirty(one) && !one.state.file?.readOnly)
          if (!list.length) return 'Nothing to save: no tab has unsaved changes.'
          for (const one of list) void saveTab(one.id)
          return true
        }
        case 'editor.reload':
          return reload()
        case 'editor.revert':
          return revert()
        case 'editor.compare':
          void toggleCompare()
          return true
        case 'editor.find':
          if (!handle.current || !tab) return 'No file is open.'
          handle.current.openFind()
          return true
        case 'editor.replace':
          if (!handle.current || !tab) return 'No file is open.'
          handle.current.openReplace()
          return true
        case 'editor.findNext':
          handle.current?.findNext()
          return true
        case 'editor.findPrevious':
          handle.current?.findPrevious()
          return true
        case 'search.showProject':
          setSearchShown(true)
          setSearchFocus((n) => n + 1)
          return true
        case 'editor.toggleWrap':
          setWrap((was) => !was)
          return true
        case 'tabs.close':
          return tab ? requestClose([tab.id]) : 'There is no tab to close.'
        case 'tabs.closeOthers':
          return requestClose(tabsAround(tabId, 'others'))
        case 'tabs.closeToRight':
          return requestClose(tabsAround(tabId, 'right'))
        case 'tabs.closeSaved':
          return requestClose(tabsAround(tabId, 'saved'))
        case 'tabs.closeAll':
          return requestClose(tabsAround(tabId, 'all'))
        case 'tabs.reopenClosed': {
          const last = closed.current.shift()
          if (!last) return 'No tab was closed.'
          openPath(absolute(last), { preview: false, focus: true, relative: last })
          return true
        }
        case 'tabs.next':
          step(1, false)
          return true
        case 'tabs.previous':
          step(-1, false)
          return true
        case 'tabs.nextInStrip':
          step(1, true)
          return true
        case 'tabs.previousInStrip':
          step(-1, true)
          return true
        case 'tabs.moveLeft':
        case 'tabs.moveRight': {
          if (!tab) return 'There is no tab to move.'
          const index = now.current.tabs.findIndex((one) => one.id === tab.id)
          dispatch({ type: 'move', id: tab.id, to: command === 'tabs.moveLeft' ? Math.max(0, index - 1) : index + 2 })
          return true
        }
        case 'tabs.pin':
          if (!tab) return 'There is no tab.'
          dispatch({ type: 'pin', id: tab.id })
          return true
        case 'tabs.copyPath':
          if (!tab) return 'There is no tab.'
          copy(tab.state.file?.path ?? tab.path)
          return true
        case 'tabs.copyRelativePath':
          if (!tab?.relative) return 'There is no tab.'
          copy(tab.relative)
          return true
        case 'tabs.focusStrip':
          ;(document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? document.querySelector<HTMLElement>('[role="tab"]'))?.focus()
          return true
        case 'keybindings.open':
          setKeysView({ mode: 'list' })
          return true
        case 'keybindings.openJson':
          setKeysDraft(userKeys)
          setKeysView({ mode: 'json' })
          return true
      }
      return `The Editor has no command "${command}".`
    },
    [goToDefinition, save, saveTab, reload, revert, toggleCompare, setWrap, requestClose, tabsAround, openPath, absolute, step, copy, userKeys],
  )
  run.current = commands

  /* ---- The keyboard ----------------------------------------------- */

  const context = useCallback((): WhenContext => {
    const tab = activeTab(now.current)
    const target = typeof document !== 'undefined' ? document.activeElement : null
    const inField = target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') && !target.closest('[data-testid="code"]')
    return {
      editorTextFocus: focus.current.text || Boolean(target instanceof HTMLElement && target.closest('[data-testid="code"]')),
      editorFocus: !inField,
      inputFocus: inField,
      tabFocus: focus.current.tab,
      hasTabs: now.current.tabs.length > 0,
      hasUnsaved: tab ? tabDirty(tab) : false,
      pickerOpen: Boolean(document.querySelector('[data-testid="picker"]')),
      searchViewFocus: focus.current.search,
      searchViewVisible: Boolean(document.querySelector('[data-testid="search-view"]')),
      findWidgetVisible: Boolean(document.querySelector('.kfind')),
      readOnly: Boolean(tab?.state.file?.readOnly),
      isMac: mac,
    }
  }, [mac])

  /*
   * Every key the page has, heard on the window before CodeMirror or any field: a binding that
   * matches runs its command and the key goes no further; a chord's first half waits for the second.
   * Keys a dialog, a menu or a picker uses for itself (Escape, Enter, the arrows, Tab) are left to it.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const pressed = pressOf(event)
      if (!pressed) return
      const overlay = document.querySelector('[role="alertdialog"], [role="menu"], [data-testid="picker"]')
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey
      if (overlay && (plain || /^(shift\+)?(escape|enter|up|down|left|right|tab|home|end|pageup|pagedown)$/.test(pressed))) return
      const ctx = context()
      /* Typing in a field of the page's own (the find box, a picker, the search box) keeps its plain keys. */
      if (ctx.inputFocus && plain && !/^(shift\+)?f\d+$/.test(pressed)) return
      const heard = hear(map, pressed, chordRef.current, ctx)
      if (heard.kind === 'none') {
        if (heard.afterChord) {
          event.preventDefault()
          event.stopPropagation()
          setNotice(`(${sayKey([chordRef.current!, pressed], mac)}) is not a command.`)
          setChord(null)
        }
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (heard.kind === 'chord') {
        setChord(heard.first)
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => setChord(null), 3000)
        return
      }
      setChord(null)
      const said = run.current(heard.command)
      if (typeof said === 'string') setNotice(said)
      else if (said instanceof Promise) void said.then((one) => typeof one === 'string' && setNotice(one))
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (timer) clearTimeout(timer)
    }
  }, [map, context, mac])

  /* ⌘-click in the text, by the same bindings (`cmd+click`). */
  const onClickWith = useCallback(
    (mods: { cmd: boolean; ctrl: boolean; alt: boolean; shift: boolean }, offset: number) => {
      const pressed = [mods.ctrl && 'ctrl', mods.shift && 'shift', mods.alt && 'alt', mods.cmd && 'cmd', 'click'].filter(Boolean).join('+')
      const heard = hear(map, pressed, null, { ...context(), editorTextFocus: true })
      if (heard.kind !== 'run') return false
      const said = run.current(heard.command, offset)
      if (said instanceof Promise) void said.then((one) => typeof one === 'string' && setNotice(one))
      return true
    },
    [map, context],
  )

  /* ---- Drops ------------------------------------------------------ */

  /** Where in the strip a drop at this point lands, or null when it is not over the strip. */
  const stripIndexAt = (x: number, y: number): number | null => {
    const strip = document.querySelector('[role="tablist"][data-testid="tabs"]')
    const box = strip?.getBoundingClientRect()
    if (!strip || !box || y < box.top || y > box.bottom) return null
    const all = [...strip.querySelectorAll<HTMLElement>('[role="tab"]')]
    for (const [index, element] of all.entries()) {
      const one = element.getBoundingClientRect()
      if (x < one.left + one.width / 2) return index
    }
    return all.length
  }

  const openDropped = useCallback(
    (file: FileDrag | null, at: number | null) => {
      if (!file) {
        setNotice('That is not a file of this project, so it was not opened.')
        return
      }
      if (file.kind === 'folder') {
        setNotice('That is a folder. Drop a file to open it.')
        return
      }
      openPath(absolute(file.path), { preview: true, focus: true, relative: file.path, at })
    },
    [openPath, absolute],
  )

  const onPageDragOver = (event: ReactDragEvent) => {
    if (!projectPath || !fileDrag.offered(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }
  const onPageDrop = (event: ReactDragEvent) => {
    if (!projectPath) return
    const file = fileDrag.read(event.dataTransfer, { project: projectPath })
    if (!file && !fileDrag.offered(event.dataTransfer)) return
    event.preventDefault()
    openDropped(file, null)
  }
  if (drop) {
    drop.current = ({ file, at }) => {
      if (!projectPath) return
      /* The host hands on what another module's page put on the drag; this project's or nothing. */
      const mine = file.project.replace(/\/+$/, '') === projectPath.replace(/\/+$/, '') ? file : null
      openDropped(mine, stripIndexAt(at.x, at.y))
    }
  }

  /* ---- Agents' orders ---------------------------------------------- */

  const carryOut = useCallback(
    (order: Order): OrderDone | null => {
      const named = order.kehikko
      if (named && host.kehikko && host.kehikko.key !== named && host.kehikko.name !== named) return null
      const tabFrom = (relative: string) => now.current.tabs.find((tab) => tab.relative === relative || tab.path === absolute(relative)) ?? null
      const busy = () => {
        const tab = activeTab(now.current)
        return tab ? tabDirty(tab) : false
      }
      if (order.kind === 'open') {
        const opened: string[] = []
        const before = now.current.tabs.length
        const ids = new Map<string, string>()
        /* In the order given, to the right of the person's tab, as several files opened at once are. */
        let at = now.current.tabs.findIndex((tab) => tab.id === now.current.active) + 1
        for (const one of order.files) {
          const reveal = one.line ? { line: one.line, column: one.column ?? 1, ...(one.endLine ? { endLine: one.endLine, endColumn: one.endColumn ?? 1 } : {}) } : null
          const existing = tabFrom(one.relative)?.id
          const created = openPath(absolute(one.relative), { preview: Boolean(one.preview), focus: false, agent: true, reveal, relative: one.relative, ...(existing ? {} : { at: at++ }) })
          ids.set(one.relative, existing ?? created)
          opened.push(one.relative)
        }
        let focused: string | null = null
        const focusId = order.focus ? ids.get(order.focus) : undefined
        if (order.focus && focusId && !busy()) {
          dispatch({ type: 'activate', id: focusId, by: 'agent' })
          focused = order.focus
        } else if (before === 0 && order.files[0]) focused = order.files[0].relative
        return { opened, focused, background: focused === null && busy() }
      }
      if (order.kind === 'focus') {
        const tab = tabFrom(order.relative)
        if (!tab) return { focused: null, refused: [{ relative: order.relative, why: 'It is not open in a tab. open_files opens it.' }] }
        if (busy() && now.current.active !== tab.id) return { focused: null, refused: [{ relative: order.relative, why: 'The person has unsaved changes in the tab they are on, so it stays in front.' }] }
        dispatch({ type: 'activate', id: tab.id, by: 'agent' })
        return { focused: order.relative }
      }
      const closing: string[] = []
      const kept: { relative: string; why: string }[] = []
      for (const path of order.paths) {
        const tab = tabFrom(path)
        if (!tab) continue
        if (tabDirty(tab)) kept.push({ relative: path, why: 'it has unsaved changes' })
        else closing.push(tab.id)
      }
      const closedPaths = order.paths.filter((path) => {
        const tab = tabFrom(path)
        return tab !== null && closing.includes(tab.id)
      })
      closeNow(closing)
      return { closed: closedPaths, kept }
    },
    [absolute, openPath, closeNow, host.kehikko],
  )

  useEffect(() => {
    if (!projectPath || !api.orders) return
    const hearOrders = (orders: Order[]) => {
      for (const order of orders) {
        const done = carryOut(order)
        if (done) void api.ordersDone?.(order.id, done)
      }
    }
    const stop = api.orders(projectPath, hearOrders)
    void api.heldOrders?.(projectPath).then(hearOrders)
    return stop
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per project; carryOut reads the latest through refs
  }, [api, projectPath])

  /* ---- Host presses, the header and the footer ---------------------- */

  const onPress = useCallback(
    ({ item, value }: Press): PressAnswer => {
      if (item === 'save') {
        const tab = activeTab(now.current)
        const refusal = tab ? saveRefusal(tab.state) : 'No file is open.'
        if (refusal) return refusal
        void save()
        return true
      }
      if (item === 'reload') return reload()
      if (item === 'revert') return revert()
      if (item === 'wrap') {
        if (typeof value !== 'boolean') return '"wrap" is a toggle: say true or false.'
        setWrap(value)
        return true
      }
      if (item === 'search') {
        if (typeof value !== 'boolean') return '"search" is a toggle: say true or false.'
        setSearchShown(value)
        if (value) setSearchFocus((n) => n + 1)
        return true
      }
      if (item === 'recent') {
        const file = recentPressed(recent, value)
        if (!file) return 'That file is no longer in the recent list.'
        openRecent(file)
        return true
      }
      if (commandInfo(item)) {
        const said = commands(item)
        return typeof said === 'string' ? said : true
      }
      return `The Editor has nothing called "${item}" to press.`
    },
    [save, reload, revert, recent, openRecent, setWrap, commands],
  )
  if (press) press.current = onPress

  const shown = state ?? EMPTY_STATE
  const items = useMemo(() => headerItems(shown, recent, wrap, { search: searchShown, keyOf: keyOfCommand }), [shown, recent, wrap, searchShown, keyOfCommand])
  const { header } = host
  useEffect(() => header(items), [header, items])

  const footed = where === 'hosted' && host.drawsFooter === true
  const said = chord ? `(${sayKey([chord], mac)}) was pressed. Waiting for the second key of the chord…` : notice
  const footerSaid = footed ? JSON.stringify(footerItems({ ...shown, said: said ?? shown.said }, { tabs: tabs.tabs.length, unsaved: tabs.tabs.filter(tabDirty).length })) : null
  const { footer } = host
  useEffect(() => {
    if (footerSaid) footer?.(JSON.parse(footerSaid))
  }, [footer, footerSaid])

  /* A notice fades once something else happens. */
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  /* ---- Menus ------------------------------------------------------ */

  const menuItems = (ids: { command: string; label?: string; disabled?: string | null; separated?: boolean }[]): MenuItem[] =>
    ids.map((one) => ({ command: one.command, label: one.label ?? commandInfo(one.command)?.title ?? one.command, shortcut: keyOfCommand(one.command), disabled: one.disabled ?? null, separated: one.separated }))

  const tabMenu = (id: string): MenuItem[] => {
    const list = now.current.tabs
    const index = list.findIndex((tab) => tab.id === id)
    const tab = list[index]
    return menuItems([
      { command: 'tabs.close', label: 'Close' },
      { command: 'tabs.closeOthers', label: 'Close others', disabled: list.length < 2 ? 'There are no other tabs.' : null },
      { command: 'tabs.closeToRight', label: 'Close to the right', disabled: index === list.length - 1 ? 'There are no tabs to the right.' : null },
      { command: 'tabs.closeSaved', label: 'Close saved' },
      { command: 'tabs.copyPath', label: 'Copy path', separated: true },
      { command: 'tabs.copyRelativePath', label: 'Copy relative path', disabled: tab?.relative ? null : 'It has not opened yet.' },
      { command: 'tabs.pin', label: 'Keep open', disabled: tab?.preview ? null : 'It is not a preview.', separated: true },
    ])
  }

  const textMenu = (): MenuItem[] =>
    menuItems([
      { command: 'editor.goToDefinition' },
      { command: 'editor.openImport' },
      { command: 'editor.goToSymbol', separated: true },
      { command: 'editor.find', separated: true },
      { command: 'editor.replace', disabled: state?.file?.readOnly ? 'This file is read-only.' : null },
      { command: 'search.showProject' },
      { command: 'palette.show', label: 'Command palette', separated: true },
    ])

  const runFromMenu = (command: string) => {
    const target = menu?.kind === 'tab' ? menu.id : null
    const offset = menu?.kind === 'text' ? menu.offset : undefined
    const said = commands(command, offset, target)
    if (typeof said === 'string') setNotice(said)
    else if (said instanceof Promise) void said.then((one) => typeof one === 'string' && setNotice(one))
  }

  const searchProject = useCallback(
    async (query: SearchQuery) => {
      if (!projectPath || !api.search) return { files: [], total: 0, truncated: false, timedOut: false, error: 'No project is open.' }
      const answer = await api.search(projectPath, PAGE, query)
      if ('cancelled' in answer && answer.cancelled) return null
      if (!('files' in answer)) return { files: [], total: 0, truncated: false, timedOut: false, error: answer.error }
      return answer
    },
    [api, projectPath],
  )

  /* ---- Drawing ---------------------------------------------------- */

  const cover = server === 'stale' ? 'stale' : (coverFor(host, { project: true }) ?? (server === 'down' && !state?.file ? 'down' : null))
  /* The host's cover is held until the page is drawn (protocol 2.70.0). */
  const drawn = cover !== null ? cover !== 'waiting' : Boolean(state?.file) || !active || Boolean(state?.trouble)
  const { ready } = host
  useEffect(() => {
    if (drawn) ready?.()
  }, [drawn, ready])
  if (cover) return <Cover state={cover} name="Editor" onRetry={() => active && void load(active)} />

  return (
    <div data-kehikot-page className="relative flex h-full min-w-0 flex-col text-sm" onDragOver={onPageDragOver} onDrop={onPageDrop}>
      {footed ? null : <Bar state={shown} items={items} where={where} onPress={onPress} onSave={() => void save()} notice={said} />}
      <div className="flex min-h-0 min-w-0 flex-1">
        {searchShown ? (
          <div className="h-full w-[min(20rem,45%)] min-w-48 shrink-0">
            <SearchView
              state={searchState}
              onState={setSearchState}
              search={searchProject}
              focusSignal={searchFocus}
              onFocusChange={(on) => (focus.current.search = on)}
              onClose={() => {
                setSearchShown(false)
                handle.current?.focus()
              }}
              onOpen={(rel, line, column, length, keep) => openPath(absolute(rel), { preview: !keep, focus: true, relative: rel, reveal: { line, column: column + 1, endLine: line, endColumn: column + 1 + length } })}
            />
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <TabStrip
            tabs={tabs.tabs}
            active={tabs.active}
            projectPath={projectPath}
            panel={panelId}
            onActivate={activate}
            onClose={(id) => {
              const said2 = requestClose([id])
              if (typeof said2 === 'string') setNotice(said2)
            }}
            onPin={(id) => dispatch({ type: 'pin', id })}
            onMove={(id, to) => dispatch({ type: 'move', id, to })}
            onMenu={(id, x, y) => setMenu({ kind: 'tab', id, x, y })}
            onDropFile={(file, at) => openDropped(file, at)}
            onFocusChange={(on) => (focus.current.tab = on)}
          />
          {state ? (
            <Notices state={state} footed={footed} comparing={comparing} onReload={reload} onCompare={() => void toggleCompare()} />
          ) : null}
          <main id={panelId} role={tabs.tabs.length ? 'tabpanel' : undefined} aria-label={relative ?? undefined} className="relative min-h-0 min-w-0 flex-1">
            {active && state?.file ? (
              comparing && state.conflict ? (
                <Comparison diskText={state.conflict.text} mine={state.text} onSaveOver={() => void save(state.conflict!.version)} onReload={reload} />
              ) : (
                <Code
                  tab={active.id}
                  alive={tabs.tabs.map((tab) => tab.id)}
                  text={state.text}
                  generation={active.generation}
                  eol={state.file.eol}
                  language={state.file.language}
                  readOnly={state.file.readOnly !== null}
                  wrap={wrap}
                  view={active.view}
                  reveal={active.reveal}
                  onRevealed={() => dispatch({ type: 'revealed', id: active.id })}
                  onView={(view) => dispatch({ type: 'view', id: active.id, view })}
                  onChange={(text) => dispatch({ type: 'file', id: active.id, action: { type: 'edited', text } })}
                  onSave={() => void save()}
                  onHandle={(one) => (handle.current = one)}
                  onClickWith={onClickWith}
                  onMenu={(offset, x, y) => setMenu({ kind: 'text', offset, x, y })}
                  onFocusChange={(on) => {
                    focus.current.text = on
                    if (on && active.agent) dispatch({ type: 'touched', id: active.id })
                  }}
                />
              )
            ) : active && state?.trouble ? null : active ? (
              <p className="text-muted-foreground p-3 text-xs">Opening…</p>
            ) : (
              <Nothing pointed={Boolean(wanted)} recent={recent} onOpen={openRecent} keyOf={keyOfCommand} />
            )}
          </main>
        </div>
      </div>
      {picker ? (
        <Picker
          initial={picker.initial}
          fixed={picker.fixed ?? null}
          placeholder={picker.fixed === 'choose' ? 'Pick a definition' : 'Type a file name; > commands, @ symbols, # project symbols, : line'}
          provide={provideWithSymbols}
          onPick={onPickAll}
          onClose={() => setPicker(null)}
        />
      ) : null}
      {menu ? (
        <ContextMenu
          items={menu.kind === 'tab' ? tabMenu(menu.id) : textMenu()}
          x={menu.x}
          y={menu.y}
          label={menu.kind === 'tab' ? 'Tab' : 'Text'}
          onRun={runFromMenu}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {prompt ? (
        <ClosePrompt
          names={prompt.ids.map((id) => now.current.tabs.find((tab) => tab.id === id)).filter((tab): tab is Tab => Boolean(tab && tabDirty(tab))).map((tab) => (tab.relative ?? tab.path).split('/').pop()!)}
          canSave={prompt.ids.every((id) => !now.current.tabs.find((tab) => tab.id === id)?.state.file?.readOnly)}
          onSave={() => void promptAnswer('save')}
          onDiscard={() => void promptAnswer('discard')}
          onCancel={() => void promptAnswer('cancel')}
        />
      ) : null}
      {keysView ? (
        <KeybindingsView
          map={map}
          mac={mac}
          mode={keysView.mode}
          text={keysDraft ?? userKeys}
          saving={keysSaving}
          said={keysSaid}
          Code={Code}
          onMode={(mode) => {
            if (mode === 'json' && keysDraft === null) setKeysDraft(userKeys)
            setKeysView({ mode })
          }}
          onText={setKeysDraft}
          onRun={(command) => {
            setKeysView(null)
            void commands(command)
          }}
          onClose={() => setKeysView(null)}
          onSave={() => {
            const text = keysDraft ?? userKeys
            if (!api.saveKeybindings) return
            setKeysSaving(true)
            void api.saveKeybindings(text).then((answer) => {
              setKeysSaving(false)
              if (answer === true) {
                setUserKeys(text)
                const problems = keymap(defaults, text, mac).problems.length
                setKeysSaid(problems ? `Saved. ${problems} ${problems === 1 ? 'entry is' : 'entries are'} skipped until fixed.` : 'Saved. Your keys are in use.')
              } else setKeysSaid(answer)
            })
          }}
        />
      ) : null}
    </div>
  )
}

const EMPTY_STATE: EditorState = { file: null, base: null, saved: '', text: '', disk: { state: 'same' }, conflict: null, saving: false, said: null, trouble: null }

/* ---- Pieces ------------------------------------------------------- */

function Bar({
  state,
  items,
  where,
  onPress,
  onSave,
  notice,
}: {
  state: EditorState
  items: HeaderItem[]
  where: Host['where']
  onPress(press: Press): void
  onSave(): void
  notice: string | null
}) {
  const file = state.file
  const unsaved = dirty(state)
  const refusal = saveRefusal(state)
  return (
    <header className="flex min-h-8 shrink-0 items-center gap-2 border-b px-2 py-1">
      <span data-testid="name" title={file?.path ?? ''} className="min-w-0 flex-1 truncate text-xs font-medium">
        {file ? file.relative : 'No file open'}
      </span>
      {notice ? (
        <span role="status" data-testid="notice" className="text-muted-foreground min-w-0 truncate text-[0.7rem]">
          {notice}
        </span>
      ) : null}
      {unsaved ? (
        <span data-testid="unsaved" title="This file has changes that are not saved." className="flex shrink-0 items-center gap-1 text-[0.7rem] text-[var(--unsaved)]">
          <span aria-hidden className="size-1.5 rounded-full bg-[var(--unsaved)]" />
          unsaved
        </span>
      ) : null}
      {file?.hidden ? (
        <Badge variant="outline" data-testid="private" title="Agents cannot read this file." className="shrink-0 text-[0.65rem]">
          private
        </Badge>
      ) : null}
      {file?.readOnly ? (
        <Badge variant="outline" data-testid="read-only" title={file.readOnly} className="shrink-0 text-[0.65rem]">
          read-only
        </Badge>
      ) : null}
      {/* Alone on its own port, the page draws its own header menus; framed, the host does. */}
      {where === 'unhosted' ? <HeaderMenus items={items} onPress={onPress} /> : null}
      {file && !file.readOnly ? (
        <Button
          size="sm"
          variant={unsaved ? 'default' : 'ghost'}
          className="h-6 shrink-0 px-2 text-xs"
          disabled={refusal !== null}
          title={refusal ?? 'Save (⌘S)'}
          onClick={onSave}
          data-testid="save"
        >
          {state.saving ? 'Saving…' : 'Save'}
        </Button>
      ) : null}
    </header>
  )
}

function Notices({
  state,
  footed = false,
  comparing,
  onReload,
  onCompare,
}: {
  state: EditorState
  /** The footer says why it is read-only, what went wrong and what just happened: those lines are not drawn here too. */
  footed?: boolean
  comparing: boolean
  onReload(): void
  onCompare(): void
}) {
  const unsaved = dirty(state)
  const line = 'flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1 text-xs'
  return (
    <>
      {state.disk.state === 'changed' && unsaved ? (
        <div role="alert" data-testid="changed" className={`${line} bg-[color-mix(in_oklch,var(--unsaved)_14%,transparent)]`}>
          <span className="min-w-0 flex-1">
            {state.trouble ?? 'This file changed on disk since you started editing it. Saving is refused until you choose.'}
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onCompare} data-testid="compare">
            {comparing ? 'Back to editing' : 'Compare'}
          </Button>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onReload} data-testid="reload">
            Reload (discard mine)
          </Button>
        </div>
      ) : null}
      {state.disk.state === 'gone' ? (
        <div role="alert" className={line}>
          {state.disk.said} {unsaved ? 'Your unsaved changes are still here and kept as a draft.' : ''}
        </div>
      ) : null}
      {state.file?.readOnly && !footed ? <p className={`${line} text-muted-foreground`} data-testid="why-read-only">{state.file.readOnly}</p> : null}
      {state.trouble && (!footed || !state.file) && !(state.disk.state === 'changed' && unsaved) ? (
        <p role="alert" className={`${line} text-destructive`} data-testid="trouble">
          {state.trouble}
        </p>
      ) : null}
      {state.said && !footed ? (
        <p className={`${line} text-muted-foreground`} data-testid="said">
          {state.said}
        </p>
      ) : null}
    </>
  )
}

function Comparison({ diskText, mine, onSaveOver, onReload }: { diskText: string | null; mine: string; onSaveOver(): void; onReload(): void }) {
  const compared = useMemo(() => (diskText === null ? null : compare(diskText, mine)), [diskText, mine])
  if (!compared) return <p className="p-3 text-xs">What is on disk now cannot be shown here.</p>
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="comparison">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="min-w-0 flex-1">
          <span className="text-destructive">−{compared.disk} on disk</span> · <span className="text-[var(--cm-string)]">+{compared.mine} yours</span>
          {compared.coarse ? ' (too large to compare line by line)' : ''}
        </span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onReload}>
          Take the disk’s
        </Button>
        <Button size="sm" className="h-6 px-2 text-xs" onClick={onSaveOver} data-testid="save-over">
          Save mine over it
        </Button>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[11px] leading-5">
        {hunks(compared.lines).map((line, index) =>
          line === null ? (
            <div key={index} className="text-muted-foreground">⋯</div>
          ) : (
            <div
              key={index}
              className={line.kind === 'disk' ? 'bg-[color-mix(in_oklch,var(--destructive)_16%,transparent)]' : line.kind === 'mine' ? 'bg-[color-mix(in_oklch,var(--cm-string)_18%,transparent)]' : ''}
            >
              {line.kind === 'disk' ? '− ' : line.kind === 'mine' ? '+ ' : '  '}
              {line.text}
            </div>
          ),
        )}
      </pre>
    </div>
  )
}

function Nothing({ pointed, recent, onOpen, keyOf }: { pointed: boolean; recent: string[]; onOpen(relative: string): void; keyOf(command: string): string | null }) {
  return (
    <div className="flex flex-col gap-2 p-3 text-xs text-muted-foreground" data-testid="nothing">
      <p>{pointed ? 'Opening…' : 'No file is open. Point at one from another module on the canvas, drop one here, or go to a file.'}</p>
      {!pointed ? (
        <ul className="flex flex-col gap-0.5">
          {(['quickOpen.file', 'palette.show', 'search.showProject', 'workspace.goToSymbol'] as const).map((id) => (
            <li key={id}>
              {commandInfo(id)?.title} <span className="font-mono">{keyOf(id) ?? ''}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {!pointed && recent.length ? (
        <div className="flex flex-col items-start gap-1">
          <span>Recent files</span>
          {recent.map((one) => (
            <Button key={one} size="sm" variant="ghost" className="h-6 max-w-full justify-start truncate px-2 text-xs" onClick={() => onOpen(one)}>
              {one}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* Exported for the tests. */
export { tabFor }
