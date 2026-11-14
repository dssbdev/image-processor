import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { LOOK_CONTROLS, type Look, type LookKey } from '../../../shared/src/spec.js';
import type { LookPreset } from '../../../shared/src/looks.js';
import { plural } from '../lib/format.js';
import { cx, layout, Select, Slider, type SelectOption } from './ui.js';

const GROUP_LABEL = { scenario: 'Scenarios', style: 'Styles', custom: 'Custom' } as const;

/** Look presets as dropdown options, grouped scenario / style / custom, optionally with a leading "none". */
export function lookOptions(looks: LookPreset[], none?: string): SelectOption<string>[] {
  const out: SelectOption<string>[] = [];
  if (none !== undefined) out.push({ value: '', label: none, hint: 'Sliders at zero — the photo as it came' });
  for (const g of ['scenario', 'style', 'custom'] as const) {
    for (const l of looks.filter((x) => x.group === g)) out.push({ value: l.slug, label: l.name, hint: l.description || undefined, group: GROUP_LABEL[g] });
  }
  return out;
}

const GROUPS: { id: 'tone' | 'colour' | 'effects'; label: string }[] = [
  { id: 'tone', label: 'Tone' },
  { id: 'colour', label: 'Colour' },
  { id: 'effects', label: 'Effects' },
];

/**
 * All look controls, grouped. In "adjust" mode (per-photo edits) `base` is the look preset and
 * `values` are the effective values; changed controls are marked and can be reset one by one.
 */
export function LookSliders({
  values,
  base,
  onChange,
  onReset,
  onResetAll,
  looks,
  onApplyPreset,
  compact = false,
}: {
  values: Look;
  /** Look preset values when editing per-photo adjustments; omit when editing the preset itself. */
  base?: Look;
  onChange: (key: LookKey, v: number) => void;
  onReset: (key: LookKey) => void;
  onResetAll?: () => void;
  looks?: LookPreset[];
  onApplyPreset?: (preset: LookPreset) => void;
  compact?: boolean;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ tone: true, colour: true, effects: true });
  const modifiedCount = base ? LOOK_CONTROLS.filter((c) => values[c.key] !== base[c.key]).length : 0;

  return (
    <div className="space-y-2">
      {looks && onApplyPreset && (
        <div className="flex items-center gap-2 pb-1">
          <Select
            value=""
            placeholder="Copy sliders from a look…"
            options={lookOptions(looks)}
            onChange={(slug) => {
              const p = looks.find((l) => l.slug === slug);
              if (p) onApplyPreset(p);
            }}
          />
        </div>
      )}
      {GROUPS.map((g) => {
        const controls = LOOK_CONTROLS.filter((c) => c.group === g.id);
        const changed = base ? controls.filter((c) => values[c.key] !== base[c.key]).length : 0;
        return (
          <div key={g.id} className={layout.well}>
            <button
              type="button"
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => setOpen((o) => ({ ...o, [g.id]: !o[g.id] }))}
            >
              <span className="text-small font-medium text-ink-1">{g.label}</span>
              <span className="flex items-center gap-2 text-micro text-ink-2">
                {changed > 0 && <span className="tone-violet rounded-full px-1.5 leading-[18px]">{changed} changed</span>}
                <ChevronRight size={14} className={cx('transition-transform', open[g.id] ? 'rotate-90' : '')} />
              </span>
            </button>
            {open[g.id] && (
              <div className={cx('px-3 pb-2', compact ? '' : '')}>
                {controls.map((c) => (
                  <Slider
                    key={c.key}
                    label={c.label}
                    min={c.min}
                    max={c.max}
                    step={c.step}
                    unit={c.unit ?? ''}
                    hint={c.help}
                    value={values[c.key]}
                    baseValue={base ? base[c.key] : undefined}
                    modified={base ? values[c.key] !== base[c.key] : false}
                    onChange={(v) => onChange(c.key, c.step < 1 ? Math.round(v * 10) / 10 : Math.round(v))}
                    onReset={() => onReset(c.key)}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
      {onResetAll && (
        <div className="flex justify-end pt-1">
          <button className="text-caption text-ink-2 hover:text-ink-0" onClick={onResetAll}>
            {base ? (modifiedCount ? `reset ${plural(modifiedCount, 'adjustment')} to the look` : 'no adjustments') : 'reset all sliders'}
          </button>
        </div>
      )}
    </div>
  );
}
