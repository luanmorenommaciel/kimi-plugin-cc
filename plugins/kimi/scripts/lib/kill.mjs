/**
 * Signal a process GROUP first, falling back to the single pid.
 *
 * The kimi child is spawned `detached: true`, making it a process-group
 * leader; every tool subprocess it spawns (test runners, builds) inherits
 * that group. Signalling only the leader pid orphans those subprocesses —
 * they keep running (and keep the session's pipe fds open) after the crank
 * is "killed". Killing -pid reaches the whole tree.
 *
 * Falls back to the plain pid when the group is gone (ESRCH — e.g. the
 * target was never a group leader, like a foreground spawn on some
 * platforms) or the group signal is not permitted (EPERM).
 *
 * @param {number} pid
 * @param {string} [signal='SIGTERM']
 */
export function signalGroup(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // group gone or not a group leader — try the bare pid below
  }
  try {
    process.kill(pid, signal);
  } catch {
    // already gone
  }
}
