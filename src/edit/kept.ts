import { projectKey } from 'kehikot-module-protocol'
import { held, type HeldReader } from 'kehikot-module-protocol/client'

import type { Draft } from './state.ts'

/**
 * What the page keeps in the browser, never on disk: unsaved drafts and the
 * recently opened files. Both are kept per PROJECT KEY — the project's own id
 * when the host sends one (protocol 2.1.0), else its path — and per file by its
 * project-relative path, so a project that is renamed or moved keeps both.
 *
 * Drafts go through the protocol's `held` (the tab's sessionStorage): they
 * survive the frame being reloaded, which is what a host does to a container,
 * and they are written as they change, because no reload can be caught in time.
 */

/** The key a project's drafts and recent files are kept under, or null with no project. */
export function keyOf(context: { projectId?: string | null; projectPath?: string | null }): string | null {
  return projectKey(context)?.key ?? null
}

const readDraft: HeldReader<Draft> = (stored) => {
  const one = stored as Partial<Draft> | null
  if (!one || typeof one !== 'object' || typeof one.text !== 'string' || typeof one.version !== 'string') return null
  return { version: one.version, text: one.text }
}

const drafts = held<Draft>('kehikot.editor.drafts', readDraft)

export function readDraftFor(key: string | null, relative: string): Draft | null {
  return key ? drafts.at(key).read(relative) : null
}

/** Keep a draft, or forget it with null (saved, reverted). */
export function keepDraft(key: string | null, relative: string, draft: Draft | null): void {
  if (key) drafts.at(key).keep(relative, draft)
}

/** Every file with a draft under a project, by relative path. */
export function draftsIn(key: string | null): string[] {
  return key ? Object.keys(drafts.at(key).all()) : []
}

/** How many recent files are remembered and offered. */
export const RECENT = 8

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readRecent(key: string | null): string[] {
  if (!key) return []
  try {
    const parsed: unknown = JSON.parse(storage()?.getItem(`kehikot.editor.recent:${key}`) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((one): one is string => typeof one === 'string' && one.length <= 4096).slice(0, RECENT) : []
  } catch {
    return []
  }
}

/** Put a file at the top of the recent list, and return the new list. */
export function noteRecent(key: string | null, relative: string): string[] {
  const next = [relative, ...readRecent(key).filter((one) => one !== relative)].slice(0, RECENT)
  if (!key) return next
  try {
    storage()?.setItem(`kehikot.editor.recent:${key}`, JSON.stringify(next))
  } catch {
    /* No storage: the list lasts as long as the page. */
  }
  return next
}
