/** Where things live inside every VM. The VM always uses these paths; the owner's own paths are not mirrored. */

/** The home of vmon's default VM user `user` (uid 1000, group `sudo`, passwordless `sudo -n`); the working directory and omp's config live under it. */
export const VM_HOME = "/home/user";
export const VM_WORKSPACE = "/home/user/work";
export const VM_AGENT_DIR = "/home/user/.omp/agent";
/** Service-owned files: config overlay and system prompt. */
export const VM_CLOUD_DIR = "/home/user/.omp-cloud";
/** The IRC extension omp starts with (`-e`) and the per-thread file it reads, both under `VM_CLOUD_DIR`. */
export const VM_IRC_EXTENSION = `${VM_CLOUD_DIR}/irc-peer.ts`;
export const VM_IRC_CONFIG = `${VM_CLOUD_DIR}/irc.json`;
