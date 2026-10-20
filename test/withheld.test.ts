import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { open } from '../file/open.ts'
import { WITHHELD, withheld } from '../file/withheld.ts'

describe('which files are not shown', () => {
  test('what a program signs in with, by its name, wherever it is', () => {
    const kept = [
      '.env',
      '.env.local',
      '.env.production',
      'apps/web/.env',
      'deploy/prod.env',
      '.git/config',
      '.git/HEAD',
      'vendor/thing/.git/config',
      '.ssh/config',
      '.aws/credentials',
      '.gnupg/pubring.kbx',
      '.netrc',
      '.npmrc',
      '.pgpass',
      'keys/id_rsa',
      'id_ed25519',
      'certs/server.pem',
      'certs/server.key',
      '.ENV',
      '.Git/config',
      '.git\\config',
    ]
    for (const path of kept) expect([path, withheld(path)]).toEqual([path, true])
  })

  test('every other file is shown, dot-files and the project’s own material among them', () => {
    const shown = [
      'README.md',
      'src/app.tsx',
      '.gitignore',
      '.gitattributes',
      '.github/workflows/ci.yml',
      '.kehikot/paper/thesis/main.tex',
      '.kehikot/slides/talk.md',
      '.eslintrc.json',
      'docs/environment.md',
      'src/env.ts',
      'src/keys.ts',
      'id_rsa.pub',
      'gitlog.txt',
      '',
    ]
    for (const path of shown) expect([path, withheld(path)]).toEqual([path, false])
  })
})

describe('a file that is not shown, at the reader', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'editor-withheld-'))
  const root = realpathSync(scratch)
  afterAll(() => rmSync(scratch, { recursive: true, force: true }))

  mkdirSync(join(root, '.git'), { recursive: true })
  mkdirSync(join(root, '.kehikot', 'paper', 'thesis'), { recursive: true })
  writeFileSync(join(root, '.env'), 'TOKEN=THE-CONTENTS\n')
  writeFileSync(join(root, '.git', 'config'), '[remote]\n url = THE-CONTENTS\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  writeFileSync(join(root, '.kehikot', 'paper', 'thesis', 'main.tex'), '\\section{Intro}\n')
  symlinkSync(join(root, '.env'), join(root, 'plain.txt'))
  symlinkSync(join(root, '.git'), join(root, 'innocent'))

  const said = (at: string) => {
    const seen = open(root, at)
    return seen.kind === 'refused' ? seen.error : seen.text
  }

  test('it is refused in a sentence that names the rule, as written and as an absolute path', () => {
    for (const at of ['.env', './.env', '.git/config', join(root, '.env'), join(root, '.git', 'config')]) {
      expect([at, said(at)]).toEqual([at, WITHHELD])
    }
  })

  test('a link with a plain name is judged by what it leads to', () => {
    expect(said('plain.txt')).toBe(WITHHELD)
    expect(said('innocent/config')).toBe(WITHHELD)
  })

  test('a name that is not there is refused by its name alone, the same way', () => {
    expect(said('nowhere/.env')).toBe(WITHHELD)
  })

  test('the paper’s source and an ordinary dot-file are shown', () => {
    expect(said('.kehikot/paper/thesis/main.tex')).toBe('\\section{Intro}\n')
    expect(said('.gitignore')).toBe('node_modules\n')
  })
})

describe('the person’s page and the agents’ door', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'editor-page-'))
  const root = realpathSync(scratch)
  const outside = mkdtempSync(join(tmpdir(), 'editor-outside-'))
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.env'), 'TOKEN=FAKE\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  writeFileSync(join(root, '.git', 'config'), '[core]\n')
  writeFileSync(join(root, 'id_rsa'), 'FAKE KEY\n')
  writeFileSync(join(root, 'a.pem'), 'FAKE\n')
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE\n')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'out.txt'))
  symlinkSync(join(root, '.git'), join(root, 'innocent'))

  const page = (at: string) => open(root, at, 'page')
  const agent = (at: string) => open(root, at)

  test('.env is shown to the page, marked hidden, and refused to the door', () => {
    const seen = page('.env')
    expect(seen.kind).toBe('text')
    expect(seen.kind === 'text' && seen.text).toBe('TOKEN=FAKE\n')
    expect(seen.kind === 'text' && seen.hidden).toBe(true)
    expect(agent('.env')).toEqual({ kind: 'refused', error: WITHHELD })
  })

  test('an ordinary dot-file is shown to both and is not marked', () => {
    const seen = page('.gitignore')
    expect(seen.kind === 'text' && seen.hidden).toBe(false)
    expect(agent('.gitignore').kind).toBe('text')
  })

  test('.git internals and private-key names are refused on both paths', () => {
    for (const at of ['.git/config', join(root, '.git', 'config'), 'innocent/config', 'id_rsa', 'a.pem']) {
      expect([at, page(at).kind]).toEqual([at, 'refused'])
      expect([at, agent(at).kind]).toEqual([at, 'refused'])
    }
  })

  test('traversal, a link out of the project and an outside absolute path are refused on both paths', () => {
    for (const at of ['../x', '../../etc/passwd', 'out.txt', join(outside, 'secret.txt'), '/etc/passwd']) {
      expect([at, page(at).kind]).toEqual([at, 'refused'])
      expect([at, agent(at).kind]).toEqual([at, 'refused'])
    }
  })
})
