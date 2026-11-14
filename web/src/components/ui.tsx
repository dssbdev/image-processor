import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, X, type LucideIcon } from 'lucide-react';

// The kit. Every colour, size and radius is a token from styles.css (canvas, card, fill-1..3, ink-0..3, brand,
// text-micro..heading, rounded-control …). Status is always a tone class (tone-green … tone-gray), never a raw colour.

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export type Tone = 'green' | 'red' | 'amber' | 'blue' | 'violet' | 'gray';

/** Class strings the pages share, so the page frame, the columns and the wells cannot drift apart. */
export const layout = {
  /** A page that scrolls as a whole. */
  scrollPage: 'scroll-thin h-full overflow-y-auto',
  /** A page that fills the window and scrolls its own panes. */
  fixedPage: 'flex h-full min-h-0 flex-col',
  /** The strip at the top of a page: title, what the page is about, its tools. */
  pageBar: 'flex min-h-[64px] shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-6 pt-4 pb-3',
  /** Everything under the page bar. */
  pageBody: 'space-y-4 px-6 pb-6',
  /** A main column and a narrow side column from xl up. */
  columns: 'grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]',
  /** One of those columns: cards stacked. */
  column: 'min-w-0 space-y-4',
  /** The big number or name: page titles, headline stats. */
  heading: 'font-display text-heading leading-tight font-medium tracking-[-0.015em] text-ink-0',
  /** A recessed panel inside a card or a dialog. */
  well: 'rounded-xl bg-fill-1',
} as const;

// ---------------------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft' | 'hero';
type Size = 'sm' | 'md' | 'lg';

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded-control font-medium transition-all duration-150 select-none whitespace-nowrap ' +
    'disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60 active:scale-[0.98]';
  const sizes: Record<Size, string> = {
    sm: 'h-7 px-2.5 text-small',
    md: 'h-9 px-3.5 text-body',
    lg: 'h-11 px-5 text-lead',
  };
  const styles: Record<Variant, string> = {
    // primary actions are light on dark; green only says "you are here"
    primary: 'bg-ink-0 text-canvas shadow-raised hover:bg-white',
    secondary: 'bg-fill-1 text-ink-0 ring-1 ring-inset ring-edge hover:bg-fill-2',
    soft: 'bg-brand/15 text-brand hover:bg-brand/25',
    ghost: 'text-ink-1 hover:bg-fill-2 hover:text-ink-0',
    danger: 'tone-red hover:brightness-125',
    // the action inside a tinted hero: a dark pill
    hero: 'bg-canvas/85 text-ink-0 shadow-raised hover:bg-canvas',
  };
  return <button className={cx(base, sizes[size], styles[variant], className)} {...rest} />;
}

export function IconButton({ className, label, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-fill-2 hover:text-ink-0 disabled:opacity-40',
        className,
      )}
      {...rest}
    />
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        'h-9 w-full rounded-control bg-fill-1 px-3 text-body text-ink-0 ring-1 ring-inset ring-edge placeholder:text-ink-3 outline-none transition focus:ring-brand/60 disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}

export interface SelectOption<T extends string = string> {
  value: T;
  label: ReactNode;
  /** Secondary text under the label in the list (not in the button). */
  hint?: ReactNode;
  /** Options with the same group are listed under a small heading. */
  group?: string;
  disabled?: boolean;
  /** Small element at the right of the row (a badge, a swatch). */
  extra?: ReactNode;
}

/**
 * Custom dropdown (button + listbox in a portal), keyboard-complete, styled like the rest of the app instead
 * of the browser's native <select>. Controlled: `value` + `onChange`.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  placeholder = 'Choose…',
  size = 'md',
  className,
  disabled,
  align = 'start',
  menuWidth,
  renderValue,
  title,
}: {
  value: T | '' | null | undefined;
  options: SelectOption<T>[];
  onChange: (v: T) => void;
  placeholder?: ReactNode;
  size?: 'sm' | 'md';
  className?: string;
  disabled?: boolean;
  align?: 'start' | 'end';
  /** Minimum width of the menu in px (defaults to the button width). */
  menuWidth?: number;
  /** Custom rendering of the selected option inside the button. */
  renderValue?: (o: SelectOption<T>) => ReactNode;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; up: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ text: '', at: 0 });
  const id = useId();
  const selected = useMemo(() => options.find((o) => o.value === value) ?? null, [options, value]);
  const enabled = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [options]);

  const place = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.max(menuWidth ?? 0, r.width, 180);
    const estimated = Math.min(360, options.length * 34 + 12);
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const up = spaceBelow < Math.min(estimated, 220) && r.top > spaceBelow;
    let left = align === 'end' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ top: up ? r.top - 6 : r.bottom + 6, left, width: w, up });
  }, [align, menuWidth, options.length]);

  const openMenu = useCallback(() => {
    if (disabled) return;
    place();
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setOpen(true);
  }, [disabled, options, place, value]);

  const close = useCallback(() => setOpen(false), []);

  const choose = useCallback(
    (i: number) => {
      const o = options[i];
      if (!o || o.disabled) return;
      onChange(o.value);
      setOpen(false);
      btnRef.current?.focus();
    },
    [onChange, options],
  );

  // Close on outside click / scroll / resize; keyboard while open (capture phase so a modal's Escape does not fire).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close();
    };
    const onScroll = (e: Event) => {
      if (listRef.current && e.target instanceof Node && listRef.current.contains(e.target)) return;
      place();
    };
    const onKey = (e: KeyboardEvent) => {
      const move = (dir: 1 | -1) => {
        if (!enabled.length) return;
        const cur = enabled.indexOf(active);
        const next = cur === -1 ? (dir === 1 ? enabled[0]! : enabled[enabled.length - 1]!) : enabled[(cur + dir + enabled.length) % enabled.length]!;
        setActive(next);
      };
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          close();
          btnRef.current?.focus();
          return;
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          move(1);
          return;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          move(-1);
          return;
        case 'Home':
          e.preventDefault();
          setActive(enabled[0] ?? -1);
          return;
        case 'End':
          e.preventDefault();
          setActive(enabled[enabled.length - 1] ?? -1);
          return;
        case 'Enter':
        case ' ':
          e.preventDefault();
          e.stopPropagation();
          choose(active);
          return;
        case 'Tab':
          close();
          return;
        default: {
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const now = Date.now();
            const t = typeahead.current;
            t.text = now - t.at < 700 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
            t.at = now;
            const labelOf = (o: SelectOption<T>) => (typeof o.label === 'string' ? o.label : String(o.value)).toLowerCase();
            const hit = options.findIndex((o) => !o.disabled && labelOf(o).startsWith(t.text));
            if (hit >= 0) setActive(hit);
          }
        }
      }
    };
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, close, place, enabled, active, choose, options]);

  // Keep the active row visible.
  useLayoutEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const sizes = size === 'sm' ? 'h-7 pl-2.5 pr-7 text-small' : 'h-9 pl-3 pr-8 text-body';

  // Group headings are inserted where the group changes (options keep their order).
  const grouped: ({ kind: 'group'; label: string } | { kind: 'opt'; index: number })[] = [];
  let lastGroup: string | undefined;
  options.forEach((o, i) => {
    if (o.group !== lastGroup && o.group) grouped.push({ kind: 'group', label: o.group });
    lastGroup = o.group;
    grouped.push({ kind: 'opt', index: i });
  });

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMenu();
          }
        }}
        className={cx(
          'relative inline-flex w-full items-center rounded-control bg-fill-1 text-left text-ink-0 ring-1 ring-inset ring-edge outline-none transition',
          'hover:bg-fill-2 focus-visible:ring-brand/60 disabled:cursor-not-allowed disabled:opacity-50',
          open && 'bg-fill-2 ring-brand/60',
          sizes,
          className,
        )}
      >
        <span className={cx('min-w-0 flex-1 truncate', !selected && 'text-ink-3')}>{selected ? (renderValue ? renderValue(selected) : selected.label) : placeholder}</span>
        <ChevronDown size={size === 'sm' ? 13 : 15} className={cx('pointer-events-none absolute right-2 text-ink-2 transition-transform', open && 'rotate-180')} />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            className="animate-pop fixed z-[100] max-h-[360px] overflow-y-auto rounded-xl bg-popover p-1 shadow-pop"
            style={{ top: pos.up ? undefined : pos.top, bottom: pos.up ? window.innerHeight - pos.top : undefined, left: pos.left, width: pos.width }}
          >
            {grouped.map((row) =>
              row.kind === 'group' ? (
                <div key={`g-${row.label}`} className="px-2.5 pt-2 pb-1 text-caption text-ink-2">
                  {row.label}
                </div>
              ) : (
                (() => {
                  const o = options[row.index]!;
                  const isSel = o.value === value;
                  const isAct = row.index === active;
                  return (
                    <div
                      key={o.value}
                      role="option"
                      aria-selected={isSel}
                      data-index={row.index}
                      onMouseEnter={() => !o.disabled && setActive(row.index)}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => choose(row.index)}
                      className={cx(
                        'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-body transition-colors',
                        o.disabled && 'cursor-not-allowed opacity-40',
                        isAct ? 'bg-fill-2 text-ink-0' : 'text-ink-1',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={cx('block truncate', isSel && 'text-ink-0')}>{o.label}</span>
                        {o.hint && <span className="block truncate text-caption leading-4 text-ink-2">{o.hint}</span>}
                      </span>
                      {o.extra}
                      <span className="w-4 shrink-0 text-brand">{isSel && <Check size={14} />}</span>
                    </div>
                  );
                })()
              ),
            )}
            {options.length === 0 && <div className="px-2.5 py-2 text-small text-ink-2">Nothing here</div>}
          </div>,
          document.body,
        )}
    </>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-small text-ink-1">{label}</span>
        {hint && <span className="truncate text-caption text-ink-2">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  size = 'md',
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <div className={cx('inline-flex items-center gap-0.5 rounded-control bg-track p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-lg font-medium transition-colors',
            size === 'sm' ? 'h-6 px-2 text-caption' : 'h-7 px-2.5 text-small',
            value === o.value ? 'bg-fill-3 text-ink-0 shadow-raised' : 'text-ink-2 hover:text-ink-0',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-fill-1">
      <span className={cx('relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors', checked ? 'bg-brand' : 'bg-track ring-1 ring-inset ring-edge')}>
        <span className={cx('inline-block h-4 w-4 transform rounded-full shadow transition-transform', checked ? 'translate-x-4 bg-brand-ink' : 'translate-x-0.5 bg-ink-1')} />
      </span>
      <span className="min-w-0">
        <span className="block text-body text-ink-0">{label}</span>
        {hint && <span className="block text-caption text-ink-2">{hint}</span>}
      </span>
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  onChange,
  onReset,
  hint,
  modified,
  baseValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: string;
  onChange: (v: number) => void;
  onReset?: () => void;
  /** Highlight as overridden (per-image edit differs from the look). */
  modified?: boolean;
  /** Where the look's value sits, drawn as a tick. */
  baseValue?: number;
}) {
  const shown = step < 1 ? value.toFixed(1) : String(value);
  const pct = ((value - min) / (max - min)) * 100;
  const basePct = baseValue === undefined ? null : ((baseValue - min) / (max - min)) * 100;
  const zeroPct = min < 0 ? ((0 - min) / (max - min)) * 100 : 0;
  return (
    <div className="group py-1" title={hint}>
      <div className="mb-1 flex items-center justify-between">
        <span className={cx('text-small', modified ? 'text-look' : 'text-ink-1')}>
          {label}
          {modified && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-look align-middle" />}
        </span>
        <div className="flex items-center gap-1.5">
          <input
            type="number"
            className="h-6 w-14 rounded-md bg-fill-1 px-1.5 text-right text-caption text-ink-0 tabular-nums ring-1 ring-inset ring-line outline-none focus:ring-brand/60"
            value={shown}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
            }}
          />
          <span className="w-4 text-micro text-ink-2">{unit}</span>
          {onReset && (
            <button
              type="button"
              className={cx('rounded px-1 transition-opacity hover:text-ink-0', modified ? 'text-look' : 'text-ink-3 opacity-0 group-hover:opacity-100')}
              onClick={onReset}
              title="Reset"
              aria-label={`Reset ${label}`}
            >
              <ResetGlyph />
            </button>
          )}
        </div>
      </div>
      <div className="relative h-4">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-track" />
        {min < 0 && <div className="absolute top-1/2 h-2 w-px -translate-y-1/2 bg-white/25" style={{ left: `${zeroPct}%` }} />}
        {basePct !== null && basePct !== pct && (
          <div className="absolute top-1/2 h-2.5 w-0.5 -translate-y-1/2 rounded bg-look/80" style={{ left: `calc(${basePct}% - 1px)` }} title="the look's value" />
        )}
        {/* neutral fill: colour never sits next to the photo it is judging */}
        <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-ink-2" style={{ left: `${Math.min(pct, zeroPct)}%`, width: `${Math.abs(pct - zeroPct)}%` }} />
        <input type="range" className="slider absolute inset-0 w-full" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      </div>
    </div>
  );
}

function ResetGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/15 border-t-brand align-middle', className)} aria-label="loading" />;
}

type BadgeTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent' | Tone;
const BADGE_TONE: Record<BadgeTone, Tone> = { neutral: 'gray', ok: 'green', warn: 'amber', bad: 'red', info: 'blue', accent: 'violet', green: 'green', red: 'red', amber: 'amber', blue: 'blue', violet: 'violet', gray: 'gray' };

/** A pill: tinted background + text. accent = violet = a look. */
export function Badge({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: BadgeTone; className?: string; title?: string }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro leading-4 font-medium whitespace-nowrap', `tone-${BADGE_TONE[tone]}`, className)}>
      {children}
    </span>
  );
}

export function ProgressBar({ value, total, failed = 0, className }: { value: number; total: number; failed?: number; className?: string }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const bad = total > 0 ? Math.round((failed / total) * 100) : 0;
  return (
    <div className={cx('h-1.5 w-full overflow-hidden rounded-full bg-track', className)}>
      <div className="flex h-full gap-px">
        <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${Math.max(0, pct - bad)}%` }} />
        <div className="solid-red h-full rounded-full transition-all" style={{ width: `${bad}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: LucideIcon }) {
  return (
    <div className="flex h-full flex-col items-center justify-center p-8 text-center">
      {icon && <IconTile icon={icon} tone="gray" size="lg" className="mb-3" />}
      <div className="text-title font-medium text-ink-0">{title}</div>
      {children && <div className="mt-2 max-w-md text-body leading-relaxed text-ink-2">{children}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onMouseDown={onClose}>
      <div className={cx('animate-fade-up w-full overflow-hidden rounded-card bg-popover shadow-pop', width)} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="flex items-center justify-between px-5 pt-4 pb-2">
          <h2 className="text-title font-medium tracking-[-0.01em] text-ink-0">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className="px-5 py-2">{children}</div>
        {footer && <footer className="mt-2 flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-chip bg-fill-2 px-1 text-micro text-ink-1 ring-1 ring-inset ring-edge">{children}</kbd>;
}

// ---------------------------------------------------------------------------------------------------------
// Page furniture: page header, hero, stat strip, cards with icons and a closing sentence
// ---------------------------------------------------------------------------------------------------------

/** Page title on the canvas, what the page is about next to it, the page's tools on the right. */
export function PageHeader({ title, sub, children, className }: { title: ReactNode; sub?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <header className={cx(layout.pageBar, className)}>
      <h1 className={layout.heading}>{title}</h1>
      <div className="min-w-0 flex-1 text-body text-ink-2">{sub}</div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** A tinted square with an icon: before a stat, a card title or a list row. The tone says what it is. */
export function IconTile({ icon: Icon, tone = 'gray', size = 'md', className }: { icon: LucideIcon; tone?: Tone; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const box = size === 'sm' ? 'h-7 w-7 rounded-control' : size === 'lg' ? 'h-10 w-10 rounded-xl' : 'h-8 w-8 rounded-control';
  return (
    <span className={cx('inline-grid shrink-0 place-items-center', box, `tone-${tone}`, className)}>
      <Icon size={size === 'sm' ? 14 : size === 'lg' ? 19 : 16} strokeWidth={1.9} />
    </span>
  );
}

/** The page's one headline: what is happening, two or three computed facts, at most one action. */
export function Hero({ tone = 'blue', icon: Icon, title, text, actions, className }: { tone?: Tone; icon: LucideIcon; title: ReactNode; text?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={cx('flex flex-wrap items-center gap-x-4 gap-y-3 rounded-hero px-5 py-4', `tone-${tone}`, className)}>
      <span className="inline-grid h-[38px] w-[38px] shrink-0 place-items-center rounded-xl" style={{ background: 'currentColor' }}>
        <Icon size={19} strokeWidth={2} className="text-card" />
      </span>
      <div className="min-w-0 flex-[1_1_24rem]">
        <div className="text-title leading-snug font-medium tracking-[-0.01em] text-ink-0">{title}</div>
        {text && <div className="mt-0.5 text-body leading-relaxed">{text}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </section>
  );
}

/** Headline numbers in ONE card, split by hairlines (the first cell of each row loses its line). */
export function StatStrip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-card bg-card px-[18px] py-4 shadow-card', className)}>
      <div className="-mx-4 grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-y-4 overflow-hidden">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub, icon, tone = 'gray', title }: { label: string; value: ReactNode; sub?: ReactNode; icon?: LucideIcon; tone?: Tone; title?: string }) {
  return (
    <div className="-ml-px flex min-w-0 items-center gap-3 border-l border-line px-4" title={title}>
      {icon && <IconTile icon={icon} tone={tone} />}
      <div className="min-w-0">
        <div className="truncate text-small text-ink-2">{label}</div>
        <div className={cx('truncate', layout.heading)}>{value}</div>
        {sub && <div className="truncate text-caption text-ink-2">{sub}</div>}
      </div>
    </div>
  );
}

/** The closing sentence of a card: what the numbers above it mean. */
export function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx('border-t border-line pt-3 text-small leading-relaxed text-ink-2', className)}>{children}</p>;
}

/**
 * A floating card. `icon` + `tone` put a tinted tile before the title; `note` is the closing sentence
 * (computed, or omitted); `flush` drops the body padding (tables, photo grids).
 */
export function Card({
  children,
  className,
  title,
  subtitle,
  actions,
  icon,
  tone = 'gray',
  note,
  flush = false,
  bodyClassName,
}: {
  children?: ReactNode;
  className?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
  note?: ReactNode;
  flush?: boolean;
  bodyClassName?: string;
}) {
  const head = !!(title || actions);
  return (
    <section className={cx('flex min-w-0 flex-col rounded-card bg-card shadow-card', className)}>
      {head && (
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-[18px] pt-4 pb-3">
          {icon && <IconTile icon={icon} tone={tone} size="sm" />}
          <div className="flex min-w-0 flex-auto items-baseline gap-2">
            {title && <h3 className="truncate text-lead font-medium text-ink-0">{title}</h3>}
            {subtitle && <span className="truncate text-small text-ink-2">{subtitle}</span>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </header>
      )}
      {children !== undefined && <div className={cx(flush ? '' : 'px-[18px] pb-[18px]', !head && !flush && 'pt-[18px]', bodyClassName)}>{children}</div>}
      {note && <Note className={cx('mx-[18px] mb-4', flush && 'mt-3')}>{note}</Note>}
    </section>
  );
}

/** A thin bar: brand by default, or a tone. */
export function Meter({ value, max = 100, tone, className }: { value: number; max?: number; tone?: Tone; className?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className={cx('block h-1.5 overflow-hidden rounded-full bg-track', className)}>
      <span className={cx('block h-full rounded-full transition-all', tone ? `solid-${tone}` : 'bg-brand')} style={{ width: `${pct}%`, minWidth: pct > 0 ? 3 : 0 }} />
    </span>
  );
}

export interface SegItem {
  label: ReactNode;
  n: number;
  tone?: Tone;
  value?: ReactNode;
}

/** A split bar (parts of a whole) with an optional legend of label · value · share. */
export function SegBar({ items, legend = true }: { items: SegItem[]; legend?: boolean }) {
  const total = items.reduce((s, i) => s + i.n, 0);
  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-track">
        {items
          .filter((i) => i.n > 0)
          .map((i, k) => (
            <span key={k} className={cx('h-full first:rounded-l-full last:rounded-r-full', `solid-${i.tone ?? 'gray'}`)} style={{ width: `${(i.n / total) * 100}%` }} />
          ))}
      </div>
      {legend && (
        <ul className="mt-3 grid gap-1.5 text-small">
          {items.map((i, k) => (
            <li key={k} className="flex items-center gap-2">
              <span className={cx('h-2 w-2 shrink-0 rounded-full', `solid-${i.tone ?? 'gray'}`)} />
              <span className="min-w-0 flex-1 truncate text-ink-1">{i.label}</span>
              <span className="text-ink-0">{i.value ?? i.n.toLocaleString('en-US')}</span>
              <span className="w-10 text-right text-ink-2">{total ? Math.round((i.n / total) * 100) : 0}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One key-value line inside a card. */
export function KV({ label, children, title }: { label: ReactNode; children: ReactNode; title?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-1.5 text-body last:border-b-0">
      <span className="shrink-0 text-ink-2">{label}</span>
      <span className="min-w-0 truncate text-right text-ink-0" title={title}>
        {children}
      </span>
    </div>
  );
}
