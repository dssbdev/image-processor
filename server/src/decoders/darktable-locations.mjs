// Plain JS on purpose: the server imports this, and so does scripts/doctor.mjs, which must run with `node`
// alone (no TypeScript loader) to diagnose a broken install.
import path from 'node:path';

/** Where darktable-cli is usually installed on this platform, most likely first. */
export function darktableCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), 'C:\\Program Files'];
    return [...new Set(roots.filter(Boolean))].map((root) => path.join(root, 'darktable', 'bin', 'darktable-cli.exe'));
  }
  if (platform === 'darwin') {
    return ['/Applications/darktable.app/Contents/MacOS/darktable-cli', '/opt/homebrew/bin/darktable-cli', '/usr/local/bin/darktable-cli'];
  }
  return ['/usr/bin/darktable-cli', '/usr/local/bin/darktable-cli', '/snap/bin/darktable-cli', '/var/lib/flatpak/exports/bin/org.darktable.Darktable'];
}

/** The command that finds an executable on PATH. */
export function whichCommand(platform = process.platform) {
  return platform === 'win32' ? 'where' : 'which';
}
