import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

import { MAX_BYTES, bytes } from './file/shape.ts'
import pkg from './package.json'

export const ID = 'kehikot.editor'
/** The module's version: package.json's, the one place it is written. A release is tagged with it. */
export const VERSION: string = pkg.version

/**
 * Where this module would like to answer. Said once, here, and read by
 * `vite.config.ts` and `register.ts`. 8030: the next free place on the ten-apart
 * grid above the official list (Browser holds 8020).
 */
export const PREFERRED_PORT = 8030

/**
 * What this app says about itself.
 *
 * ## An editor beside a viewer
 *
 * Source shows the file the canvas points at and never writes; that is its whole
 * claim, and it stays true. This module is the other half: the same file, the
 * same fence, and an explicit save. It follows the passage the way Source does
 * (`reacts: ['passage']`) and never points the canvas itself.
 *
 * ## What it will not do
 *
 * - Save without being asked: there is no autosave, only Save, ⌘S and the
 *   header's Save.
 * - Overwrite a file that changed on disk since the edit began.
 * - Write anything under `.kehikot/`: each module there is the only writer of its
 *   folder (Paper's LaTeX, Notes' notes, the host's own records).
 * - Write for an agent: its MCP door only reads.
 *
 * ## `partless`
 *
 * It edits one file — the one the canvas points at, or the one a person opened
 * from its Go menu — which is in their hands whatever parts of the epic are
 * picked. There is nothing here to narrow.
 *
 * ## `storage: true`
 *
 * For the same reason as Source: the page's `/api` calls must be same-origin, so
 * no permissive CORS header ever lets another page read a file's contents or
 * reach the save.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Editor',
  version: VERSION,
  summary:
    'Edit the file the canvas points at: explicit save, refused when the file changed on disk, never under .kehikot/.',
  tags: ['code', 'writing'],
  guidance:
    'Editor is the container the person edits a file in. It follows the canvas passage, and the person saves '
    + 'explicitly; nothing there is saved for them. Its MCP door only reads: call `editing` with the project to learn '
    + 'which file they have open and whether they have unsaved changes (text: true returns those changes). It cannot '
    + 'write. Edit files with your own tools — and when the person has unsaved changes in the file you are about to '
    + 'change, tell them: the Editor will refuse their save and offer a reload or a comparison. Files under .kehikot/ '
    + `are read-only there. Files over ${bytes(MAX_BYTES)} and binary files are not opened.`,
  entry: '/app',
  modes: [{ id: 'editor', label: 'Editor', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'Which file the person has open in the Editor, and whether they have unsaved changes. Read-only.',
  },
  extensions: { emits: [], consumes: [] },
  reacts: ['passage'],
  partless:
    'It edits the one file the canvas points at, which is in the person’s hands whatever parts of the epic are picked.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: [],
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
