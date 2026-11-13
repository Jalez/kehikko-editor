import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

import { SETTINGS } from './src/commands/settings.ts'
import { MAX_BYTES, bytes } from './file/shape.ts'
import pkg from './package.json'

export const ID = 'kehikot.editor'
/** The module's version: package.json's, the one place it is written. A release is tagged with it. */
export const VERSION: string = pkg.version

/**
 * Where this module would like to answer. Said once, here, and read by
 * `vite.config.ts` and `register.ts`. 8030: the next free place on the ten-apart
 * grid above the official list.
 */
export const PREFERRED_PORT = 8030

/**
 * What this app says about itself.
 *
 * ## An editor beside a viewer
 *
 * A viewer may show the file the canvas points at and never write; this module is
 * the other half: the same file, a fence as strict, and an explicit save. It
 * follows the passage (`reacts: ['passage']`) and never points the canvas itself.
 *
 * ## What it will not do
 *
 * - Save without being asked: there is no autosave, only Save, ⌘S and the
 *   header's Save.
 * - Overwrite a file that changed on disk since the edit began.
 * - Write anything under `.kehikot/`: each module there is the only writer of its
 *   folder (a document that takes edits as proposals, notes, the host's own records).
 * - Write for an agent: its MCP door never writes a file. It opens files as tabs, focuses a tab and
 *   closes saved tabs — never one with unsaved changes.
 *
 * ## `partless`
 *
 * It edits one file — the one the canvas points at, or the one a person opened
 * from its Go menu — which is in their hands whatever parts of the epic are
 * picked. There is nothing here to narrow.
 *
 * ## `state:keep`
 *
 * Whether lines wrap is kept for the container (2.51.0): the host holds it per container and hands
 * it back in the greeting, so it is as it was left after a restart. The recent files and the
 * unsaved drafts are not view state of a container and stay where they were.
 *
 * ## `services:read`
 *
 * Which module keeps a document per epic and takes edits only as proposals (`document.proposals`,
 * 2.83.0), so its files are read-only here in its own name and its folders are followed where they
 * lead; and which module owns each folder under `.kehikot/` (`module.folders`, 2.85.0), so a file
 * there is read-only in its owner's name. Asked by the server (`file/document.ts`, `file/folders.ts`);
 * with no answer the `.kehikot/` rule still holds, in generic words.
 *
 * ## `storage: true`
 *
 * The page's `/api` calls must be same-origin, so
 * no permissive CORS header ever lets another page read a file's contents or
 * reach the save.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Editor',
  /* The icon a host draws beside the name: a key of the protocol's module icons, never a path
     or URL; the same key Kehikot's official list gives it. */
  icon: 'lucide:file-pen',
  version: VERSION,
  summary:
    'Edit files in tabs: explicit save, refused when a file changed on disk; go to definition, search, never under .kehikot/.',
  tags: ['code', 'writing'],
  guidance:
    'Editor is the container the person edits files in, as tabs. Nothing is saved for them: they save explicitly. Its MCP '
    + 'door never writes a file. tabs says which tabs are open and which have unsaved changes; editing (text: true) returns '
    + 'the active tab’s unsaved text. open_files opens files as tabs, at a line or a selected range, in the background '
    + '(focus asks for one to be active when the person has no unsaved changes there); focus_tab and close_tabs act on '
    + 'tabs, and close only saved ones. Use them to show the person the code you are talking about. Edit files with your '
    + 'own tools, and when the person has unsaved changes in a file you change, tell them: their save will be refused and '
    + `offered a reload or a comparison. Files under .kehikot/ are read-only there; files over ${bytes(MAX_BYTES)} and binary `
    + 'files are not opened.',
  agentSays: 'Open files as tabs in the Editor to show the person code (open_files), and see which tabs they have open and unsaved (tabs).',
  entry: '/app',
  /* What its content belongs to (protocol 2.29.0): one mode per scope, the default first. */
  modes: [
    { id: 'editor', label: 'Editor', scope: 'project', scopeSays: 'the files of this project, whatever epic is open' },
  ],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'The tabs the person has open in the Editor and which are unsaved; open files as tabs, focus or close saved ones. Never writes a file.',
  },
  extensions: { emits: [], consumes: [] },
  reacts: ['passage'],
  /* It opens a file the host points the canvas at (protocol 2.33.0): a host's "Open the file" — a
     module's settings file, say — comes here instead of a dialog. */
  opens: ['file'],
  partless:
    'It edits the one file the canvas points at, which is in the person’s hands whatever parts of the epic are picked.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: ['state:keep', 'services:read'],
    settings: SETTINGS,
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
