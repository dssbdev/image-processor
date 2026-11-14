/** Where darktable-cli is usually installed on this platform, most likely first. */
export function darktableCandidates(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[];

/** The command that finds an executable on PATH. */
export function whichCommand(platform?: NodeJS.Platform): 'where' | 'which';
