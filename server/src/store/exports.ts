import { PATHS } from '../config.js';
import { DEFAULT_EXPORTS, ExportPresetSchema, type ExportPreset } from '../../../shared/src/spec.js';
import { createPresetStore } from './presets.js';

const SEEDED = DEFAULT_EXPORTS.map((preset) => preset.slug);

/** Position among the seeded presets; presets of your own come after them. */
function seedRank(slug: string): number {
  const index = SEEDED.indexOf(slug);
  return index === -1 ? SEEDED.length : index;
}

/** The export presets: `<config>/exports/<slug>.json`, listed in seeded order, then the rest by name. */
export const exportStore = createPresetStore<ExportPreset>({
  dir: PATHS.exports,
  label: 'export preset',
  schema: ExportPresetSchema,
  defaults: DEFAULT_EXPORTS,
  compare: (a, b) => seedRank(a.slug) - seedRank(b.slug) || a.name.localeCompare(b.name),
});
