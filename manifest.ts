import { MANIFEST_KIND, PROTOCOL, manifestSchema, type Manifest } from 'kehikot-module-protocol'

export const ID = 'kehikot.editor'
export const VERSION = '0.1.0'

/**
 * Where this module would like to answer. Said once, here, and read by
 * `vite.config.ts` and `register.ts`. Modules on this machine sit ten apart, so
 * a drift up from one never lands on a neighbour's number.
 */
export const PREFERRED_PORT = 8030

/**
 * Parsed rather than shipped as a bare object: the cheapest way to learn this
 * file says something no host will accept is to fail when it is imported.
 */
export const MANIFEST: Manifest = manifestSchema.parse({
  kind: MANIFEST_KIND,
  protocol: PROTOCOL,
  id: ID,
  name: 'Editor',
  version: VERSION,
  /* The format of what this module keeps under `.kehikot/`. Raise it only in
     the release that first writes data an older release cannot read; a host
     then refuses to run an older release against that project. */
  dataVersion: 1,
  summary: 'What Editor is, in a sentence, for a person deciding whether to place it.',
  /* Where a host files this module in its list, most fitting first: e.g.
     `['code', 'review']`. The suggested words are `TAGS` in the protocol;
     empty is filed under "other". */
  tags: [],
  /* What this module's PRESENCE obliges an agent to do. Composed into every
     agent's prompt on the canvas, so write it to somebody who just arrived. */
  guidance:
    'This canvas has Editor on it. Call `read_value` with the project path to see what it is holding.',
  entry: '/app',
  modes: [{ id: 'editor', label: 'Editor', scope: 'epic' }],
  mcp: {
    url: '/mcp',
    transport: 'http',
    about: 'What an agent can do with Editor.',
  },
  extensions: { emits: [], consumes: [] },
  reacts: [],
  /* Every module either follows the parts of the epic a person picked out —
     `reacts: ['parts']`, narrowing with `useFocus` from the protocol's
     `/client/react` — or says here, in one sentence, why it has nothing to
     narrow. Replace this the day the module holds items of its own. */
  partless: 'A new module: it keeps one value for the project and nothing that belongs to a part of an epic.',
  declares: {
    protocol: `>=${PROTOCOL} <${PROTOCOL + 1}`,
    uses: [],
    /* True because this module keeps material and takes writes: the host then
       frames it on its real origin, so its scripts and `/api` calls are plain
       same-origin requests and nothing needs a permissive CORS header that
       would let any page read the write ticket. See vite.config.ts. */
    storage: true,
    prompt: false,
  },
  health: '/healthz',
})
