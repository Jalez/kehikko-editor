import { resolveDoorProject, type DoorProject } from 'kehikot-module-protocol/serve'

/**
 * Which project is this folder? Asked of the host, in this server, before any folder a request names
 * is read (protocol 2.3.0, `resolveDoorProject`). A page's word, or an agent's, is not the host's.
 *
 * The answer's `path` is what is read, never the folder that was asked about: an agent that learnt a
 * path before the folder was renamed is followed to where the project is now, once, and only after the
 * host has said the new path is the same project. A host that says no, a host that does not know the
 * route, and no host answering at all read nothing.
 */
export type Resolve = (folder: string) => Promise<DoorProject>

export const resolveProject: Resolve = (folder) => resolveDoorProject(folder)
