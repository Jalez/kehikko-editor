import { useMemo, useState, type ComponentType } from 'react'

import { Button } from '@/components/ui/button'
import defaults from '@/commands/keybindings.default.json'
import { COMMANDS } from '@/commands/list'
import { RESERVED, WHEN_KEYS, keymap, sayKey, type Keymap } from '@/commands/keys'
import type { CodeEditorProps } from '@/view/code-editor'

/**
 * Keyboard shortcuts: every command with the keys that run it now, searchable, read-only — and the
 * person's own list as JSON (VS Code's keybindings.json shape), checked as it is typed. A bad entry
 * is said in words with its line and skipped; the rest still work. Saved as a setting of this
 * computer (never in a project) through the module's settings door, the same one the app's Settings
 * shows.
 */

export const EXAMPLE = `[
  // Your own keys, over the defaults. "-command" takes a default away.
  // { "key": "cmd+e", "command": "quickOpen.file" },
  // { "key": "cmd+k cmd+o", "command": "editor.goToDefinition", "when": "editorTextFocus" },
  // { "command": "-tabs.closeOthers" }
]
`

export function KeybindingsView({
  map,
  mac,
  mode,
  text,
  saving,
  said,
  onMode,
  onText,
  onSave,
  onRun,
  onClose,
  Code,
}: {
  map: Keymap
  mac: boolean
  mode: 'list' | 'json'
  /** The person's text as being edited. */
  text: string
  saving: boolean
  said: string | null
  onMode(mode: 'list' | 'json'): void
  onText(text: string): void
  onSave(): void
  onRun(command: string): void
  onClose(): void
  Code: ComponentType<CodeEditorProps>
}) {
  const [filter, setFilter] = useState('')
  const checked = useMemo(() => keymap(defaults, text, mac), [text, mac])
  const shown = useMemo(() => {
    const words = filter.trim().toLowerCase()
    return COMMANDS.map((one) => ({
      ...one,
      bindings: map.bindings.filter((binding) => binding.command === one.id),
    })).filter((one) => {
      if (!words) return true
      const keys = one.bindings.map((binding) => `${binding.parts.join(' ')} ${sayKey(binding.parts, mac)}`).join(' ')
      return `${one.title} ${one.id} ${one.category} ${keys}`.toLowerCase().includes(words)
    })
  }, [filter, map, mac])
  const userProblems = checked.problems

  return (
    <section aria-label="Keyboard shortcuts" data-testid="keybindings" className="bg-background absolute inset-0 z-30 flex min-h-0 flex-col text-xs">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <span className="font-medium">Keyboard shortcuts</span>
        <div role="tablist" aria-label="Show" className="flex gap-0.5">
          <button role="tab" type="button" aria-selected={mode === 'list'} onClick={() => onMode('list')} className={`rounded-sm px-2 py-0.5 ${mode === 'list' ? 'bg-accent' : 'hover:bg-accent/60'}`}>
            All commands
          </button>
          <button role="tab" type="button" aria-selected={mode === 'json'} onClick={() => onMode('json')} className={`rounded-sm px-2 py-0.5 ${mode === 'json' ? 'bg-accent' : 'hover:bg-accent/60'}`}>
            Your keys (JSON)
          </button>
        </div>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={onClose}>
          Close
        </Button>
      </div>
      {mode === 'list' ? (
        <>
          <div className="border-b p-2">
            <input
              type="search"
              aria-label="Search commands and keys"
              placeholder="Search commands and keys"
              value={filter}
              autoFocus
              onChange={(event) => setFilter(event.target.value)}
              className="bg-background h-6 w-full rounded-sm border px-1.5 outline-none"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-collapse" data-testid="keybindings-list">
              <thead className="text-muted-foreground bg-card sticky top-0 text-left text-[0.65rem]">
                <tr>
                  <th className="px-2 py-1 font-medium">Command</th>
                  <th className="px-2 py-1 font-medium">Keys</th>
                  <th className="px-2 py-1 font-medium">When</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((one) => (
                  <tr key={one.id} className="hover:bg-accent/50 border-t">
                    <td className="px-2 py-1">
                      <button type="button" className="text-left hover:underline" title={`Run: ${one.id}`} onClick={() => onRun(one.id)}>
                        {one.title}
                      </button>
                      <div className="text-muted-foreground font-mono text-[0.6rem]">{one.id}</div>
                    </td>
                    <td className="px-2 py-1 font-mono text-[0.7rem]">
                      {one.bindings.length
                        ? one.bindings.map((binding, i) => (
                            <span key={i} className="mr-2 whitespace-nowrap">
                              {sayKey(binding.parts, mac)}
                              {binding.source === 'user' ? <span className="text-muted-foreground"> (yours)</span> : null}
                            </span>
                          ))
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="text-muted-foreground px-2 py-1 font-mono text-[0.65rem]">{[...new Set(one.bindings.map((binding) => binding.whenText).filter(Boolean))].join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-muted-foreground p-2 text-[0.65rem]">
              Kept by the app and never taken here: {RESERVED.map((one) => sayKey([one], mac)).join(', ')}. In the desktop app ⌘W, ⌘Q, ⌘H and ⌘M belong to the window, so Close tab also has ⌃W.
            </p>
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1">
            <Code text={text || EXAMPLE} generation={1} eol={"\n"} language="json" readOnly={false} wrap={false} onChange={onText} onSave={onSave} tab="keybindings" />
          </div>
          <div className="flex max-h-40 shrink-0 flex-col gap-1 overflow-auto border-t p-2">
            {userProblems.length ? (
              <ul role="alert" data-testid="keybindings-problems" className="text-destructive flex flex-col gap-0.5">
                {userProblems.map((one, i) => (
                  <li key={i}>
                    Line {one.line}: {one.said}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground">No problems. Contexts for “when”: {Object.keys(WHEN_KEYS).join(', ')}.</p>
            )}
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground min-w-0 flex-1 truncate" role="status">
                {said ?? 'Kept on this computer, never in a project.'}
              </span>
              <Button size="sm" className="h-6 px-2 text-xs" disabled={saving} onClick={onSave} data-testid="keybindings-save">
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </>
      )}
    </section>
  )
}
