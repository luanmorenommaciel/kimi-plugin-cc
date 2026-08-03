import { execFile } from 'node:child_process';

/**
 * Best-effort desktop notification when a background crank finishes.
 *
 * Channel resolution order:
 *   1. $KIMI_NOTIFY_CMD — custom command; receives the title/message via the
 *      KIMI_NOTIFY_TITLE / KIMI_NOTIFY_MESSAGE env vars.
 *   2. osascript (macOS) / notify-send (Linux) when available.
 *
 * This NEVER throws and never blocks the session lifecycle — a missing or
 * failing notifier is fine.
 */
export async function notifyCompletion(title, message, opts = {}) {
  const runImpl = opts.runImpl || run;
  const custom = process.env.KIMI_NOTIFY_CMD;
  try {
    if (custom) {
      await runImpl(custom, [], {
        env: { ...process.env, KIMI_NOTIFY_TITLE: title, KIMI_NOTIFY_MESSAGE: message },
      });
      return true;
    }
    if (process.platform === 'darwin') {
      await runImpl('osascript', [
        '-e',
        `display notification "${quote(message)}" with title "${quote(title)}"`,
      ]);
      return true;
    }
    if (process.platform === 'linux') {
      await runImpl('notify-send', [title, message]);
      return true;
    }
  } catch {
    // notifier missing/failed — swallow by design
  }
  return false;
}

function quote(s) {
  return String(s).replace(/["\\]/g, '\\$&').slice(0, 200);
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 10000, ...opts }, (err) => (err ? reject(err) : resolve()));
  });
}
