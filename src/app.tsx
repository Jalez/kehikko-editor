import { useEffect, useMemo, useState } from 'react'

import { headerItemsSchema, type HeaderItem, type PressValue } from 'kehikot-module-protocol'
import { Cover, coverFor, useServerStanding } from 'kehikot-module-protocol/client/react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderMenus } from '@/components/header-menus'
import { Input } from '@/components/ui/input'
import { Switcher, type Item } from '@/switcher'
import { api as realApi, type Api } from '@/wire/api'
import { useKehikot, type Host } from '@/wire/use-kehikot'

/**
 * What this module puts in its container's menus: one toggle, as the example. Add a `switch` for
 * views, a `go` for places to jump to and a `run` for acts; the host draws them (View, Go, Run)
 * and reports a press. The module owns the state: every change is declared again, whole.
 */
export function headerItems(details: boolean): HeaderItem[] {
  return headerItemsSchema.parse([{ kind: 'toggle', id: 'details', label: 'What the host said', checked: details }])
}

type Press = { item: string; value?: PressValue }

export function App() {
  const [details, setDetails] = useState(true)
  /* One handler for a press from the host's menus and for one from this page's own copy of them. */
  const press = ({ item, value }: Press) => {
    if (item !== 'details' || typeof value !== 'boolean') return `Editor has nothing called "${item}" to press.`
    setDetails(value)
  }
  const host = useKehikot({ onPress: press })
  const items = useMemo(() => headerItems(details), [details])
  /* Declared at mount and again whenever anything in it changes; replayed by the client on every greeting. */
  const { header } = host
  useEffect(() => header(items), [header, items])
  return <Screen host={host} items={items} onPress={press} />
}

/**
 * The placeholder screen: a header strip, and a body saying what the host told
 * this module and keeping one value in the project. Rendered from a plain
 * `Host`, so a test can draw it with a fake context (see test/render.test.tsx).
 */
export function Screen({
  host,
  api = realApi,
  items = headerItems(true),
  onPress = () => {},
}: {
  host: Host
  api?: Api
  items?: HeaderItem[]
  onPress?: (press: Press) => void
}) {
  const details = items.some((item) => item.kind === 'toggle' && item.id === 'details' && item.checked)
  /* What this page's own server last did, learned by every `ask()`: it stopped, or it restarted under this page. */
  const server = useServerStanding()
  const [again, setAgain] = useState(0)
  /* The one screen for every not-ready moment, in the order that is true: waiting before anything else. */
  const cover = server === 'stale' ? 'stale' : (coverFor(host, { project: true }) ?? (server === 'down' ? 'down' : null))

  return (
    <div className="flex h-screen flex-col text-sm">
      <Header host={host} menus={items} onPress={onPress} />
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-3">
        {cover ? <Cover state={cover} name="Editor" onRetry={() => setAgain((n) => n + 1)} /> : details ? <Context host={host} /> : null}
        {host.projectPath && server !== 'stale' ? (
          <Stored key={again} hidden={cover !== null} projectPath={host.projectPath} api={api} />
        ) : null}
      </main>
    </div>
  )
}

function Header({ host, menus, onPress }: { host: Host; menus: HeaderItem[]; onPress(press: Press): void }) {
  const [items, setItems] = useState<Item[]>([
    { id: 'first', name: 'First' },
    { id: 'second', name: 'Second' },
  ])
  const [current, setCurrent] = useState<string | null>('first')

  return (
    <header className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-1">
      <span className="text-xs font-medium">Editor</span>
      <Switcher
        noun="item"
        items={items}
        current={current}
        onPick={setCurrent}
        onRename={(id, name) => {
          setItems((was) => was.map((one) => (one.id === id ? { ...one, name } : one)))
          return true
        }}
        onRemove={(id) => {
          setItems((was) => was.filter((one) => one.id !== id))
          if (current === id) setCurrent(null)
        }}
        onCreate={(name) => {
          const id = `${Date.now()}`
          setItems((was) => [...was, { id, name }])
          setCurrent(id)
          return true
        }}
      />
      {/* Hosted, the host draws these in the container's own header. Alone, the page does. */}
      {host.where === 'unhosted' ? <HeaderMenus items={menus} onPress={onPress} /> : null}
      <Badge variant="outline" className="ml-auto" data-testid="where">
        {host.where}
      </Badge>
    </header>
  )
}

function Context({ host }: { host: Host }) {
  const rows: [string, string | null][] = [
    ['project', host.project],
    ['epic', host.epic],
    /* Said even when nothing is picked: "the whole epic" is an answer, and a
       blank here would read as a host that did not say. */
    ['parts', host.epic ? (host.focus.length ? host.focus.join(', ') : 'the whole epic') : null],
    ['theme', host.theme],
  ]
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd data-testid={label}>{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

/** One JSON value, kept at <project>/.kehikot/editor/value.json through /api. */
function Stored({ projectPath, api, hidden }: { projectPath: string; api: Api; hidden: boolean }) {
  const [draft, setDraft] = useState('')
  const [said, setSaid] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    api
      .read(projectPath)
      .then((value) => {
        if (live) setDraft(typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value))
      })
      .catch((error: unknown) => live && setSaid(error instanceof Error ? error.message : String(error)))
    return () => {
      live = false
    }
  }, [projectPath, api])

  /* Still mounted under a cover, so "Try again" is this component reading again. */
  if (hidden) return null

  return (
    <form
      className="flex max-w-md flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        api
          .write(projectPath, draft)
          .then(() => setSaid('saved'))
          .catch((error: unknown) => setSaid(error instanceof Error ? error.message : String(error)))
      }}
    >
      <label className="text-muted-foreground text-xs" htmlFor="value">
        a value kept in this project
      </label>
      <div className="flex gap-2">
        <Input id="value" value={draft} onChange={(event) => setDraft(event.target.value)} />
        <Button type="submit" size="sm">
          Save
        </Button>
      </div>
      {said ? <p className="text-muted-foreground text-xs" data-testid="said">{said}</p> : null}
    </form>
  )
}
