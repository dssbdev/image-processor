import { PATHS } from '../config.js';
import { DEFAULT_LOOK_PRESETS, LookPresetSchema, type LookPreset } from '../../../shared/src/looks.js';
import { createPresetStore } from './presets.js';

const GROUP_ORDER = { scenario: 0, style: 1, custom: 2 } as const;

/** The look library: `<config>/looks/<slug>.json`, listed scenarios first, then styles, then your own. */
export const lookStore = createPresetStore<LookPreset>({
  dir: PATHS.looks,
  label: 'look',
  schema: LookPresetSchema,
  defaults: DEFAULT_LOOK_PRESETS,
  compare: (a, b) => GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.name.localeCompare(b.name),
});
