/**
 * Every command the Editor has, by id: what the palette lists, what a key, a menu item and a header
 * item call. Nothing in the Editor is reachable only by the mouse: each act is one of these, and the
 * keyboard reaches all of them (through a key, or through the palette).
 *
 * Pure and shared: the page runs them, and the server lists them (with their keys) for agents.
 * The ids follow VS Code's shape (`area.verb`); the titles are what a person reads.
 */

export interface CommandInfo {
  id: string
  title: string
  /** The group the palette shows it under. */
  category: 'File' | 'Tabs' | 'Go' | 'Find' | 'View' | 'Preferences'
}

export const COMMANDS: readonly CommandInfo[] = [
  { id: 'palette.show', title: 'Show all commands', category: 'View' },
  { id: 'quickOpen.file', title: 'Go to file…', category: 'Go' },
  { id: 'editor.goToSymbol', title: 'Go to symbol in file…', category: 'Go' },
  { id: 'workspace.goToSymbol', title: 'Go to symbol in project…', category: 'Go' },
  { id: 'editor.goToLine', title: 'Go to line…', category: 'Go' },
  { id: 'editor.goToDefinition', title: 'Go to definition', category: 'Go' },
  { id: 'editor.openImport', title: 'Open the imported file', category: 'Go' },
  { id: 'editor.save', title: 'Save', category: 'File' },
  { id: 'editor.saveAll', title: 'Save all', category: 'File' },
  { id: 'editor.reload', title: 'Reload from disk', category: 'File' },
  { id: 'editor.revert', title: 'Revert unsaved changes', category: 'File' },
  { id: 'editor.compare', title: 'Compare with what is on disk', category: 'File' },
  { id: 'editor.find', title: 'Find', category: 'Find' },
  { id: 'editor.replace', title: 'Replace', category: 'Find' },
  { id: 'editor.findNext', title: 'Find next', category: 'Find' },
  { id: 'editor.findPrevious', title: 'Find previous', category: 'Find' },
  { id: 'search.showProject', title: 'Search in project', category: 'Find' },
  { id: 'editor.toggleWrap', title: 'Wrap lines', category: 'View' },
  { id: 'tabs.close', title: 'Close tab', category: 'Tabs' },
  { id: 'tabs.closeOthers', title: 'Close other tabs', category: 'Tabs' },
  { id: 'tabs.closeToRight', title: 'Close tabs to the right', category: 'Tabs' },
  { id: 'tabs.closeSaved', title: 'Close saved tabs', category: 'Tabs' },
  { id: 'tabs.closeAll', title: 'Close all tabs', category: 'Tabs' },
  { id: 'tabs.reopenClosed', title: 'Reopen closed tab', category: 'Tabs' },
  { id: 'tabs.next', title: 'Next tab (most recently used)', category: 'Tabs' },
  { id: 'tabs.previous', title: 'Previous tab (most recently used)', category: 'Tabs' },
  { id: 'tabs.nextInStrip', title: 'Next tab', category: 'Tabs' },
  { id: 'tabs.previousInStrip', title: 'Previous tab', category: 'Tabs' },
  { id: 'tabs.moveLeft', title: 'Move tab left', category: 'Tabs' },
  { id: 'tabs.moveRight', title: 'Move tab right', category: 'Tabs' },
  { id: 'tabs.pin', title: 'Keep tab open (not a preview)', category: 'Tabs' },
  { id: 'tabs.copyPath', title: 'Copy path', category: 'Tabs' },
  { id: 'tabs.copyRelativePath', title: 'Copy relative path', category: 'Tabs' },
  { id: 'tabs.focusStrip', title: 'Focus the tab strip', category: 'Tabs' },
  { id: 'keybindings.open', title: 'Keyboard shortcuts', category: 'Preferences' },
  { id: 'keybindings.openJson', title: 'Open keyboard shortcuts (JSON)', category: 'Preferences' },
]

export const COMMAND_IDS: ReadonlySet<string> = new Set(COMMANDS.map((one) => one.id))

export function commandInfo(id: string): CommandInfo | null {
  return COMMANDS.find((one) => one.id === id) ?? null
}
