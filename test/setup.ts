import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setKnownDocument } from '../file/document.ts'
import { setKnownFolders } from '../file/folders.ts'

/*
 * Tests never reach the real machine: no host is asked about a project (the doors'
 * tests give their own answer through `setHostResolve`, and anything that slips
 * past asks a port nothing listens on), and no registration lands in the real
 * registry.
 */
process.env.KEHIKOT_ORIGINS = 'http://127.0.0.1:9'
process.env.KEHIKOT_MODULES_DIR = mkdtempSync(join(tmpdir(), 'editor-registry-'))
delete process.env.EDITOR_ROOTS

/* Nobody keeps a document unless a test says so: the host is never asked who does. */
setKnownDocument(null, Number.POSITIVE_INFINITY)
setKnownFolders({}, Number.POSITIVE_INFINITY)

/* A document for the tests that render one; the pure tests do not care. */
GlobalRegistrator.register()
