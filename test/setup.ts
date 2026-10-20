import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/*
 * Tests never reach the real machine: no host is asked about a project (the doors'
 * tests give their own answer through `setHostResolve`, and anything that slips
 * past asks a port nothing listens on), and no registration lands in the real
 * registry.
 */
process.env.KEHIKOT_ORIGINS = 'http://127.0.0.1:9'
process.env.KEHIKOT_MODULES_DIR = mkdtempSync(join(tmpdir(), 'editor-registry-'))
delete process.env.EDITOR_ROOTS

/* A document for the tests that render one; the pure tests do not care. */
GlobalRegistrator.register()
