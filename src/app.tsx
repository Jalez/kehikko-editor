import type { HeaderItem, PressValue } from 'kehikot-module-protocol'
import type { HostEvents } from 'kehikot-module-protocol/client'
import { Cover, coverFor, useHost, useServerStanding, type Host as ProtocolHost } from 'kehikot-module-protocol/client/react'
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType } from 'react'

import { ID } from '../manifest.ts'

import { HeaderMenus } from '@/components/header-menus'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { compare, hunks } from '@/edit/diff'
import { headerItems, recentPressed } from '@/edit/header'
import { keepDraft, keyOf, noteRecent, readDraftFor, readRecent } from '@/edit/kept'
import { EMPTY, dirty, reduce, saveRefusal, type EditorState } from '@/edit/state'
import { CodeEditor, type CodeEditorProps } from '@/view/code-editor'
import { api as realApi, type Api } from '@/wire/api'

type Press = { item: string; value?: PressValue }
type PressAnswer = string | true | void
type GotoHandler = NonNullable<HostEvents['onGoto']>

/** What the screen needs from the host. A plain object, so a test can draw the screen without one. */
export type Host = Pick<ProtocolHost, 'where' | 'project' | 'projectPath' | 'projectId' | 'passage' | 'header'>

/**
 * The page.
 *
 * `App` connects to the host; `Screen` is everything else, drawn from a plain
 * `Host` and an `Api` so the tests can drive it with a fake of each and a
 * textarea standing in for CodeMirror.
 */
export function App() {
  const press = useRef<(press: Press) => PressAnswer>(() => 'The Editor is not ready yet.')
  const onGoto = useCallback<GotoHandler>((_message, answer) => {
    answer(false, 'The Editor edits the file the canvas points at; there is nothing here to walk to by reference.')
  }, [])
  const host = useHost(ID, { onPress: (one) => press.current(one), onGoto })
  return <Screen host={host} press={press} />
}

export function Screen({
  host,
  api = realApi,
  Code = CodeEditor,
  press,
}: {
  host: Host
  api?: Api
  Code?: ComponentType<CodeEditorProps>
  /** Where the screen puts its press handler, for the host's presses to reach. */
  press?: { current: (press: Press) => PressAnswer }
}) {
  const { where, projectPath, projectId, passage } = host
  const key = keyOf({ projectId, projectPath })
  const server = useServerStanding()

  const [state, dispatch] = useReducer(reduce, EMPTY)
  /* The latest state, for handlers that run outside a render (a press, a timer). */
  const now = useRef<EditorState>(state)
  now.current = state
  const [generation, setGeneration] = useState(0)
  const [recent, setRecent] = useState<string[]>(() => readRecent(key))
  const [wrap, setWrap] = useState(false)
  /** The file the canvas points at, held back because there are unsaved changes here. */
  const [pending, setPending] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  /** The path this file was asked for by, as the canvas spelled it. */
  const askedAs = useRef<string | null>(null)
  const opening = useRef<AbortController | null>(null)

  useEffect(() => setRecent(readRecent(key)), [key])

  /* ---- Opening ---------------------------------------------------- */

  const openFile = useCallback(
    async (path: string, options: { draft?: boolean; said?: string | null } = {}) => {
      if (!projectPath) return
      opening.current?.abort()
      const control = new AbortController()
      opening.current = control
      const asked = await api.open(projectPath, path, control.signal)
      if (control.signal.aborted) return
      if (!asked.ok) {
        if (asked.kind === 'down' || asked.kind === 'cancelled' || asked.kind === 'stale') return
        askedAs.current = path
        dispatch({ type: 'trouble', said: asked.error })
        return
      }
      const file = asked.body
      if (options.draft === false) keepDraft(key, file.relative, null)
      const draft = options.draft === false ? null : readDraftFor(key, file.relative)
      askedAs.current = path
      dispatch({ type: 'opened', file, draft, said: options.said ?? null })
      setGeneration((n) => n + 1)
      setComparing(false)
      setPending(null)
      setRecent(noteRecent(key, file.relative))
    },
    [api, key, projectPath],
  )

  /* A new project: nothing from the old one stays open. Before the follow below, which then opens afresh. */
  useEffect(() => {
    askedAs.current = null
    dispatch({ type: 'closed' })
    setPending(null)
    setComparing(false)
  }, [projectPath])

  /* Follow the canvas: open what the passage names, unless that would leave unsaved changes behind. */
  const wanted = passage?.path ?? null
  useEffect(() => {
    if (!projectPath || !wanted) return
    const current = now.current
    if (askedAs.current === wanted || current.file?.path === wanted) {
      setPending(null)
      return
    }
    if (dirty(current)) {
      setPending(wanted)
      return
    }
    void openFile(wanted)
  }, [projectPath, wanted, openFile])

  /* ---- Drafts, the watch, and what agents are told ---------------- */

  const unsaved = dirty(state)
  const relative = state.file?.relative ?? null

  /* The draft follows the text: kept while it differs from the disk, forgotten when it does not. */
  useEffect(() => {
    if (!relative) return
    const timer = setTimeout(() => {
      const current = now.current
      if (current.file?.relative !== relative) return
      keepDraft(key, relative, dirty(current) && current.base ? { version: current.base, text: current.text } : null)
    }, 250)
    return () => clearTimeout(timer)
  }, [key, relative, state.text, state.base])

  /*
   * The watch: the file's version on disk, asked when the server says the file was written (its own
   * stream, `api.changes`, whose first event is also the first ask), and when the window is focused
   * again. Nothing asks on a clock, and the stream is closed while the page is hidden.
   */
  const filePath = state.file?.path ?? null
  useEffect(() => {
    if (!projectPath || !filePath) return
    let live = true
    const look = async () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const stamp = await api.stamp(projectPath, filePath)
      if (!live || !stamp || now.current.file?.path !== filePath) return
      dispatch(stamp.version === null ? { type: 'stamp', version: null, gone: stamp.gone ?? 'The file is no longer there.' } : { type: 'stamp', version: stamp.version })
    }
    const stop = api.changes(projectPath, filePath, () => void look())
    const onFocus = () => void look()
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      stop()
      window.removeEventListener('focus', onFocus)
    }
  }, [api, projectPath, filePath])

  /* Changed on disk with nothing unsaved here: take the new text, and say so. */
  useEffect(() => {
    if (state.disk.state === 'changed' && !unsaved && !state.saving && filePath) {
      void openFile(askedAs.current ?? filePath, { said: 'Reloaded: the file changed on disk.' })
    }
  }, [state.disk, unsaved, state.saving, filePath, openFile])

  /* What the agent door may say: which file, whether unsaved, and the unsaved text. */
  useEffect(() => {
    if (!projectPath) return
    const timer = setTimeout(() => {
      const current = now.current
      void api.editing(projectPath, {
        relative: current.file?.relative ?? null,
        dirty: dirty(current),
        version: current.base,
        readOnly: current.file?.readOnly ?? null,
        hidden: current.file?.hidden ?? false,
        text: dirty(current) ? current.text : null,
      })
    }, unsaved ? 1000 : 0)
    return () => clearTimeout(timer)
  }, [api, projectPath, relative, unsaved, state.base, state.text, state.file?.readOnly, state.file?.hidden])

  /* Leaving the page with unsaved changes asks first (and the draft is kept either way). */
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsaved])

  /* ---- Acts ------------------------------------------------------- */

  const save = useCallback(
    async (over?: string) => {
      const current = now.current
      const refusal = saveRefusal(current)
      if (refusal && !(over && current.file && !current.file.readOnly && !current.saving)) return refusal
      if (!projectPath || !current.file) return 'No file is open.'
      const sent = current.text
      dispatch({ type: 'saving' })
      const answer = await api.save(projectPath, current.file.path, sent, over ?? current.base ?? '')
      if (answer.kind === 'saved') {
        dispatch({ type: 'saved', text: sent, version: answer.version, unchanged: answer.unchanged })
        if (now.current.text === sent) keepDraft(key, current.file.relative, null)
        setComparing(false)
      } else if (answer.kind === 'conflict') {
        dispatch({ type: 'conflict', version: answer.version, text: answer.text, said: answer.said })
      } else {
        dispatch({ type: 'refused', said: answer.said })
      }
      return true
    },
    [api, key, projectPath],
  )

  const reload = useCallback(() => {
    const current = now.current
    if (!current.file) return 'No file is open.'
    void openFile(askedAs.current ?? current.file.path, { draft: false, said: 'Reloaded from disk.' })
    return true
  }, [openFile])

  const revert = useCallback(() => {
    const current = now.current
    if (!dirty(current) || !current.file) return 'There are no unsaved changes to revert.'
    keepDraft(key, current.file.relative, null)
    dispatch({ type: 'revert' })
    setGeneration((n) => n + 1)
    setComparing(false)
    return true
  }, [key])

  const openRecent = useCallback(
    (relativePath: string) => {
      if (!projectPath) return
      const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`
      void openFile(`${root}${relativePath}`)
    },
    [openFile, projectPath],
  )

  /* The comparison needs what is on disk now: a refused save brought it, or it is read here. */
  const toggleCompare = useCallback(async () => {
    const current = now.current
    if (comparing) return setComparing(false)
    if (!current.conflict && current.file && projectPath) {
      const asked = await api.open(projectPath, current.file.path)
      if (!asked.ok) return dispatch({ type: 'refused', said: asked.error })
      dispatch({ type: 'conflict', version: asked.body.version, text: asked.body.text, said: null })
    }
    setComparing(true)
  }, [api, comparing, projectPath])

  const onPress = useCallback(
    ({ item, value }: Press): PressAnswer => {
      if (item === 'save') {
        const refusal = saveRefusal(now.current)
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
      if (item === 'recent') {
        const file = recentPressed(recent, value)
        if (!file) return 'That file is no longer in the recent list.'
        openRecent(file)
        return true
      }
      return `The Editor has nothing called "${item}" to press.`
    },
    [save, reload, revert, recent, openRecent],
  )
  if (press) press.current = onPress

  /* ---- The header ------------------------------------------------- */

  const items = useMemo(() => headerItems(state, recent, wrap), [state, recent, wrap])
  const { header } = host
  useEffect(() => header(items), [header, items])

  /* ---- Drawing ---------------------------------------------------- */

  const cover = server === 'stale' ? 'stale' : (coverFor(host, { project: true }) ?? (server === 'down' && !state.file ? 'down' : null))
  if (cover) return <Cover state={cover} name="Editor" onRetry={() => wanted && void openFile(wanted)} />

  return (
    <div className="flex h-full min-w-0 flex-col text-sm">
      <Bar state={state} items={items} where={where} onPress={onPress} onSave={() => void save()} />
      <Notices
        state={state}
        pending={pending}
        comparing={comparing}
        onOpenPending={() => pending && void openFile(pending)}
        onReload={reload}
        onCompare={() => void toggleCompare()}
      />
      <main className="min-h-0 min-w-0 flex-1">
        {state.file ? (
          comparing && state.conflict ? (
            <Comparison diskText={state.conflict.text} mine={state.text} onSaveOver={() => void save(state.conflict!.version)} onReload={reload} />
          ) : (
            <Code
              text={state.text}
              generation={generation}
              eol={state.file.eol}
              language={state.file.language}
              readOnly={state.file.readOnly !== null}
              wrap={wrap}
              onChange={(text) => dispatch({ type: 'edited', text })}
              onSave={() => void save()}
            />
          )
        ) : (
          <Nothing pointed={Boolean(wanted)} recent={recent} onOpen={openRecent} />
        )}
      </main>
    </div>
  )
}

/* ---- Pieces ------------------------------------------------------- */

function Bar({
  state,
  items,
  where,
  onPress,
  onSave,
}: {
  state: EditorState
  items: HeaderItem[]
  where: Host['where']
  onPress(press: Press): void
  onSave(): void
}) {
  const file = state.file
  const unsaved = dirty(state)
  const refusal = saveRefusal(state)
  return (
    <header className="flex min-h-8 shrink-0 items-center gap-2 border-b px-2 py-1">
      <span data-testid="name" title={file?.path ?? ''} className="min-w-0 flex-1 truncate text-xs font-medium">
        {file ? file.relative : 'No file open'}
      </span>
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
  pending,
  comparing,
  onOpenPending,
  onReload,
  onCompare,
}: {
  state: EditorState
  pending: string | null
  comparing: boolean
  onOpenPending(): void
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
      {pending ? (
        <div className={line} data-testid="pending">
          <span className="min-w-0 flex-1 truncate" title={pending}>
            The canvas points at {pending.slice(pending.lastIndexOf('/') + 1)}. Your unsaved changes here are kept if you open it.
          </span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onOpenPending}>
            Open it
          </Button>
        </div>
      ) : null}
      {state.file?.readOnly ? <p className={`${line} text-muted-foreground`} data-testid="why-read-only">{state.file.readOnly}</p> : null}
      {state.trouble && !(state.disk.state === 'changed' && unsaved) ? (
        <p role="alert" className={`${line} text-destructive`} data-testid="trouble">
          {state.trouble}
        </p>
      ) : null}
      {state.said ? (
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

function Nothing({ pointed, recent, onOpen }: { pointed: boolean; recent: string[]; onOpen(relative: string): void }) {
  return (
    <div className="flex flex-col gap-2 p-3 text-xs text-muted-foreground" data-testid="nothing">
      <p>{pointed ? 'Opening…' : 'Nothing on the canvas points at a file. Press one in Explorer or Source to edit it here.'}</p>
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

