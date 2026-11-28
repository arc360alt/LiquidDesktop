// Asking for your password before something needs administrator rights (installing a missing package, turning
// on local snapshots…), shared by the newer apps and Settings panes. The password is checked by the main process
// (sudo) and kept there for the next sudo command; it never comes back here.
import { api } from './sys.js';
import { prompt, alertDialog } from './menus.js';

export async function askSudo(why, anchor) {
  if (!(await api.sddm.sudoStatus().catch(() => ({ needed: true }))).needed) return true;
  for (let i = 0; i < 3; i++) {
    const pw = await prompt('Enter your password', '', { type: 'password', ok: 'Authenticate', message: why }, anchor);
    if (pw == null) return false;
    if (await api.sddm.sudoCheck(pw)) return true;
    await alertDialog({ title: 'Incorrect password', message: 'Try again.' }, anchor);
  }
  return false;
}

/** Ask for the password, then run fn (an install); errors are shown in an alert. Returns fn's result or null. */
export async function withAdmin(why, fn, anchor) {
  if (!(await askSudo(why, anchor))) return null;
  try { return await fn(); } catch (e) { await alertDialog({ title: 'That didn’t work', message: e.message }, anchor); return null; }
}
