import { Images } from 'lucide-react';
import { isRenderable } from '../../../shared/src/pairing.js';
import { api } from '../api.js';
import { useApp } from '../store.js';
import { cx } from './ui.js';
import { baseNameOf } from '../lib/paths.js';

/**
 * Horizontal strip of the current gallery folder: pick which photo a look preview renders on.
 * Falls back to the last focused gallery photo when nothing is chosen.
 */
export function PhotoPicker({ value, onChange }: { value: string | null; onChange: (path: string) => void }) {
  const app = useApp();
  const files = (app.listing?.files ?? []).filter((f) => isRenderable(f.kind)).slice(0, 200);
  return (
    <div className="flex items-center gap-2">
      <div className="flex shrink-0 items-center gap-1 text-caption text-ink-2">
        <Images size={13} /> {app.dir ? baseNameOf(app.dir) : 'gallery folder'}
      </div>
      <div className="scroll-thin flex min-w-0 flex-1 gap-1.5 overflow-x-auto py-1">
        {files.length === 0 && <span className="text-caption text-ink-3">Open a folder with photos in the Gallery to preview on them</span>}
        {files.map((f) => (
          <button
            key={f.path}
            className={cx(
              'h-12 w-16 shrink-0 overflow-hidden rounded-lg bg-shade transition-all',
              value === f.path ? 'ring-2 ring-brand' : 'opacity-75 ring-1 ring-line ring-inset hover:opacity-100',
            )}
            title={f.name}
            onClick={() => onChange(f.path)}
          >
            <img src={api.thumbUrl(f.path, 160)} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
          </button>
        ))}
      </div>
    </div>
  );
}
