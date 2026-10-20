import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * The fence, and the only place in this program that decides whether a path may
 * be opened — or written.
 *
 * Copied from kehikko-source's `file/confine.ts`, where it was written and tried,
 * so the Editor and Source refuse exactly the same paths. A change to one belongs
 * in the other. Here the stakes are higher again: Source shows a file's contents,
 * this module REPLACES them, so a hole in this fence is a write anywhere on the
 * disk the process can reach. `file/save.ts` runs every path through `inside`
 * and writes only to the real path it answers, never to the path a request named.
 *
 * This is the most dangerous file in the module, and it is more dangerous here
 * than in the explorer it was copied from. That module answers with NAMES; this
 * one answers with CONTENTS. A hole in the explorer's fence leaks a directory
 * listing. A hole in this one hands over `~/.ssh/id_ed25519` to whatever asked,
 * and what asks is a passage — a path a stranger's program put on the canvas.
 * The protocol says so itself, at `passageSchema`: a consumer that resolves a
 * passage path and opens it "is opening a path a stranger's program chose, and
 * owes itself the confinement check it would owe any other".
 *
 * It is small on purpose, it is pure apart from one `realpath` call, and
 * `test/confine.test.ts` exists entirely to try to get past it.
 *
 * ## Two checks, and neither is sufficient alone
 *
 * **`resolve` first.** `join(root, '../../etc')` is a string containing `..`
 * and `resolve` is what turns it into the path it actually means. A prefix
 * check run before resolution is checking a string nobody will open.
 *
 * **`realpath` second.** Resolution is lexical: it knows nothing about
 * symlinks. `<root>/link` where `link -> /etc` resolves to a path that starts
 * with the root and opens somewhere else entirely. So the resolved path is
 * realpath'd and the check is made against the ANSWER — which is also why the
 * root is realpath'd, since comparing a real path against a symlinked root
 * (`/tmp` is `/private/tmp` on macOS, and this workspace's tests run in
 * `mkdtemp` under it) rejects everything.
 *
 * ## The failure this shape is written against, which happened in this workspace
 *
 * A sibling module had a version of this that fell back to a LEXICAL prefix
 * comparison when it could not `realpath` the target — the reasoning being that
 * a file which does not exist yet is not an escape. It is: a path that cannot
 * be resolved is a path this program knows nothing about, and "it is probably
 * fine" is not a sentence a fence gets to say. That fallback was removed on the
 * day this module was written, and this file has never had one. **A path that
 * cannot be realpath'd is refused.** There is no branch below where a lexical
 * comparison is the last word.
 *
 * The consequence is worth stating so nobody re-adds it as a bug fix: this app
 * cannot show a file that does not exist. That is correct — there is nothing in
 * it to show.
 *
 * ## The separator is not decoration
 *
 * `'/project-evil'.startsWith('/project')` is true. It is the oldest bug in
 * this family and it is a prefix check written by somebody who was thinking
 * about directories while the language was thinking about strings. So the
 * comparison is against `root + sep`, with the root itself allowed as its own
 * special case, and there is a test named after `/project-evil`.
 *
 * ## What a refusal is
 *
 * `null`, always, with no distinction between "outside the root", "does not
 * exist" and "cannot be read". That is deliberate. Three different refusals is
 * an oracle: a caller that can tell "outside the root" from "does not exist"
 * can probe for the existence of files it is not allowed to see, one question
 * at a time. Callers here get one word back and the word is no.
 *
 * ## The root itself is not confined by this file
 *
 * `inside()` answers "is this path inside that root", which is a relative
 * question. Which roots are permissible at all is a separate decision and it
 * lives in `rootOf` below, because the two have different answers: the root
 * comes from the host's context and a path comes from a request.
 */
export function inside(root: string, target: string): string | null {
  if (!root || !isAbsolute(root)) return null

  const asked = resolve(root)
  const realRoot = real(asked)
  if (realRoot === null) return null

  /*
   * A path spelled under the root AS THE CALLER WAS GIVEN IT is re-expressed
   * relative to it, so that the two spellings of one directory are one
   * directory.
   *
   * This covers the case where the caller has the symlinked spelling of the root
   * and passes it as `root` too. The harder half is below.
   */
  const spelled = isAbsolute(target) ? resolve(target) : target
  const wanted = isAbsolute(spelled) && contains(asked, spelled) ? relative(asked, spelled) : spelled

  const resolved = resolve(realRoot, wanted)

  if (!contains(realRoot, resolved)) {
    /*
     * The one deliberate departure from the fence this was copied from, and it
     * is a bug found by pointing the real module at a real project rather than
     * by reading the code.
     *
     * ## What goes wrong without this branch
     *
     * The caller here is a passage, and a passage carries an ABSOLUTE path built
     * by whichever module pointed the canvas — almost always the host's
     * `projectPath` with something joined onto it. `rootOf` has already
     * realpath'd the root. So if `projectPath` runs through a symlink, and on
     * macOS every temporary directory does (`/tmp` is `/private/tmp`,
     * `/var/folders/…` is `/private/var/folders/…`), the passage says
     * `/var/…/project/file.ts` while this fence holds
     * `/private/var/…/project`. `resolve` cannot reconcile them — a realpath
     * cannot be inverted — the lexical check fails, and the module refuses every
     * file in the project it was pointed at, with the same sentence it uses for
     * `/etc/shadow`. A viewer that shows nothing, ever, and blames the file.
     *
     * ## Why the extra `realpath` is affordable here and not in general
     *
     * The sibling module refuses lexically at this point and never touches disk,
     * because doing a `realpath` on a path outside the root in order to then
     * decide we were not allowed to is an existence oracle with extra steps.
     * That argument is sound and it is kept for the case it was written about:
     * a RELATIVE path that resolved outside the root got there through `..`,
     * which is the traversal attack, and it is refused below without a syscall.
     *
     * An ABSOLUTE path that resolved outside the root is a different animal. It
     * is not a traversal; it is a passage naming somewhere else, which is what a
     * second spelling of the same directory looks like. So it gets exactly one
     * `realpath`, and it is judged on the answer.
     *
     * What that costs is one `stat` of a path the caller already named in full,
     * whose result is the same `null` either way. What it buys is a module that
     * works on a project whose path contains a symlink, which is every project
     * under `/tmp` and, for anybody whose home directory is linked, all of them.
     */
    if (!isAbsolute(spelled)) return null
    const elsewhere = real(spelled)
    if (elsewhere === null || !contains(realRoot, elsewhere)) return null
    return elsewhere
  }

  const realTarget = real(resolved)
  if (realTarget === null) return null
  /* And again on the answer, because between the two lines above the path may
     have been a symlink all along. This is the check that matters, and it is
     the last word: there is no branch here that accepts an unresolvable path. */
  if (!contains(realRoot, realTarget)) return null
  return realTarget
}

/**
 * Whether `path` is `root` or is beneath it, as directories rather than as
 * strings. See the essay above for why the separator is here.
 */
export function contains(root: string, path: string): boolean {
  if (path === root) return true
  return path.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * `realpathSync`, or null.
 *
 * A throw here is ENOENT, EACCES or ELOOP, and every one of them means the same
 * thing to this program: it is not going to open that. Distinguishing them on
 * the way out is the oracle the essay above refuses.
 */
function real(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/**
 * Which directories may be a root at all.
 *
 * ## The root does not come from a request, and yet it arrives in one
 *
 * The rule this module is built to keep is that the project root comes from the
 * host's context rather than from a parameter a caller chose. That is true of
 * where the value ORIGINATES — `context.projectPath`, sent by the host to every
 * framed module — and it cannot be true of how it travels, because this server
 * is not on the canvas and is never handed a context. The page reads
 * `projectPath` off the wire and sends it with each read; an agent at `/mcp`
 * types it. From the server's side both are strings in a request.
 *
 * So the two callers are told apart by what they can show:
 *
 *   - **The page** carries the ticket this process printed into it, and what it
 *     names is what the host put it in. A project the page names is served, and
 *     remembered for as long as this process lives.
 *   - **An agent** has no ticket, so it is served only a project this app
 *     already knows: one its own page has named since this process started.
 *
 * That is the honest extent of what a module server can know about "the
 * projects the app has open". A `.kehikot` folder does not say it: a project
 * that was just added has none, and one can be made, or arrive in a clone, in a
 * folder nobody opened.
 *
 * ## Never the whole disk, never a home folder
 *
 * `/`, the home folder, and anything above it are refused as a root whoever
 * names them. A project is a folder inside those, and every file a person has
 * is not what a container showing one project's file is for.
 *
 * ## `EDITOR_ROOTS`, when an operator sets it
 *
 * A colon-separated list of absolute directories. Set, it is the whole rule: a
 * root is served when it is inside one of them and refused when it is not, for
 * the page and an agent alike. The operator named those directories; nothing
 * above is consulted.
 *
 * What is refused in every configuration: a relative root, an empty root, a
 * root this process cannot realpath, and one that is not a directory. A relative
 * root would resolve against this module's own directory and quietly serve
 * this app's own source to somebody who thought they were asking about their
 * project.
 */
export function rootOf(asked: string | null | undefined, by: 'page' | 'agent' = 'agent'): string | null {
  if (!asked || !isAbsolute(asked)) return null
  const realRoot = real(resolve(asked))
  if (realRoot === null || !isDirectory(realRoot)) return null

  const allowed = configuredRoots()
  if (allowed.length) {
    for (const one of allowed) {
      if (!isAbsolute(one)) continue
      const realAllowed = real(one)
      /* Each configured root is realpath'd and compared on its own, never merged
         into a union of prefixes. Two roots checked as a set is how `../` climbs
         out of one and lands inside the other. */
      if (realAllowed !== null && contains(realAllowed, realRoot)) return realRoot
    }
    return null
  }

  if (tooWide(realRoot)) return null
  if (by === 'page') {
    remember(realRoot)
    return realRoot
  }
  return known.has(realRoot) ? realRoot : null
}

/** The directories an operator listed, as written. Empty when none are. */
export function configuredRoots(): string[] {
  return (process.env.EDITOR_ROOTS ?? '')
    .split(':')
    .map((one) => one.trim())
    .filter(Boolean)
}

/** How many projects are remembered. Far more than anybody has open; a bound on what a caller can make this hold. */
const MAX_KNOWN = 64

/** The projects this app's own page has named since this process started, oldest first. Real paths. */
const known = new Set<string>()

function remember(realRoot: string): void {
  known.delete(realRoot)
  known.add(realRoot)
  while (known.size > MAX_KNOWN) known.delete(known.values().next().value as string)
}

/** For tests: forget every project the page has named. */
export function forgetKnown(): void {
  known.clear()
}

/**
 * Is this the disk's root, the home folder, something above it, or another
 * person's home beside it? `home` is a parameter so a test can say where home is.
 */
export function tooWide(realRoot: string, home: string = homedir()): boolean {
  if (dirname(realRoot) === realRoot) return true
  const realHome = real(home) ?? home
  return contains(realRoot, realHome) || dirname(realRoot) === dirname(realHome)
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
