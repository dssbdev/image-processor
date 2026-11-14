import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { FsListing, Job, ServerInfo, Settings } from '../../shared/src/api.js';
import { FOLDER_EDITS_VERSION, type FolderEdits, type ImageEdit, type ImageEditPatch } from '../../shared/src/edits.js';
import type { LookPreset } from '../../shared/src/looks.js';
import type { AspectRatio, ExportPreset } from '../../shared/src/spec.js';
import { api } from './api.js';
import { useJobsFeed } from './hooks/useJobs.js';
import { baseNameOf, dirOf } from './lib/paths.js';

const TABS = ['gallery', 'edit', 'looks', 'import', 'jobs', 'settings'] as const;
export type Tab = (typeof TABS)[number];

/** A step-through session: which photos, which tools, what happens at the end. Lives in memory. */
export interface PipelineSession {
  dir: string;
  paths: string[];
  index: number;
  /** Look preset slug applied to every photo when the session started ('' = none). */
  look: string;
  /** Crop ratio applied to every photo when the session started ('original' = no crop). */
  aspect: AspectRatio;
  tools: { frame: boolean; look: boolean };
  /** Open the export dialog when the last photo is done. */
  exportAfter: boolean;
  startedAt: number;
}

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'bad';
  title: string;
  body?: string;
  actions?: { label: string; onClick: () => void }[];
  ttl?: number;
}

type Setter<T> = (next: T | ((prev: T) => T)) => void;
type EditPatches = Record<string, ImageEditPatch | null>;

export interface AppStore {
  tab: Tab;
  go: (t: Tab) => void;
  info: ServerInfo | null;
  settings: Settings | null;
  reloadSettings: () => Promise<void>;
  exports: ExportPreset[];
  reloadExports: () => Promise<void>;
  looks: LookPreset[];
  reloadLooks: () => Promise<void>;
  jobs: Job[];

  // gallery
  dir: string;
  listing: FsListing | null;
  loadingDir: boolean;
  dirError: string | null;
  loadDir: (p: string) => Promise<void>;
  reloadDir: () => Promise<void>;
  selection: Set<string>;
  setSelection: Setter<Set<string>>;
  focusedPath: string | null;
  setFocusedPath: (p: string | null) => void;
  /** Look preset the gallery applies with one click ('' = none). Remembered. */
  activeLook: string;
  setActiveLook: (slug: string) => void;
  /** Crop ratio the gallery applies with one click. Remembered. */
  activeAspect: AspectRatio;
  setActiveAspect: (a: AspectRatio) => void;
  /** Export preset used by default in the export dialog. Remembered. */
  activeExport: string;
  setActiveExport: (slug: string) => void;

  // per-folder edits
  edits: FolderEdits;
  editFor: (path: string) => ImageEdit | undefined;
  /** Patch one photo, by its full path. */
  patchEdit: (path: string, patch: ImageEditPatch | null) => Promise<void>;
  /** Patch many photos, keyed by full path (they may live in different folders). */
  patchEdits: (patch: EditPatches) => Promise<void>;

  // pipeline
  session: PipelineSession | null;
  setSession: Setter<PipelineSession | null>;

  // toasts
  toasts: Toast[];
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

const Ctx = createContext<AppStore | null>(null);

export function useApp(): AppStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('useApp outside provider');
  return s;
}

const NO_EDITS: FolderEdits = { version: FOLDER_EDITS_VERSION, edits: {} };
const TOAST_TTL_MS = 5000;
const TOAST_WITH_ACTIONS_TTL_MS = 12_000;

function tabFromHash(): Tab {
  const hash = window.location.hash.replace('#', '');
  return TABS.find((t) => t === hash) ?? 'gallery';
}

/** State that survives a reload: mirrored to localStorage under `ip.<name>` (null or '' forgets it). */
function useRemembered<T extends string | null>(name: string, fallback: T): [T, (value: T) => void] {
  const key = `ip.${name}`;
  const [value, setValue] = useState<T>(() => (localStorage.getItem(key) as T | null) ?? fallback);
  const remember = useCallback(
    (next: T) => {
      setValue(next);
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
    },
    [key],
  );
  return [value, remember];
}

/** A folder's files and its sidecar edits; a folder without a readable sidecar simply has no edits. */
async function fetchFolder(dir: string): Promise<{ listing: FsListing; edits: FolderEdits }> {
  const [listing, edits] = await Promise.all([api.list(dir), api.edits(dir).catch(() => NO_EDITS)]);
  return { listing, edits };
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [exports, setExports] = useState<ExportPreset[]>([]);
  const [looks, setLooks] = useState<LookPreset[]>([]);
  const { jobs } = useJobsFeed();

  const [dir, setDir] = useRemembered<string>('dir', '');
  const [listing, setListing] = useState<FsListing | null>(null);
  const [loadingDir, setLoadingDir] = useState(false);
  const [dirError, setDirError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [focusedPath, setFocusedPath] = useRemembered<string | null>('focusedPath', null);
  const [activeLook, setActiveLook] = useRemembered<string>('activeLook', '');
  const [activeAspect, setActiveAspect] = useRemembered<AspectRatio>('activeAspect', 'original');
  const [activeExport, setActiveExport] = useRemembered<string>('activeExport', '');
  const [edits, setEdits] = useState<FolderEdits>(NO_EDITS);
  const [session, setSession] = useState<PipelineSession | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(1);

  const go = useCallback((t: Tab) => {
    window.location.hash = t;
    setTab(t);
  }, []);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const reloadSettings = useCallback(async () => setSettings(await api.settings()), []);
  const reloadExports = useCallback(async () => setExports(await api.exports.list()), []);
  const reloadLooks = useCallback(async () => setLooks(await api.looks.list()), []);

  useEffect(() => {
    void Promise.allSettled([reloadSettings(), reloadExports(), reloadLooks(), api.info().then(setInfo)]);
  }, [reloadSettings, reloadExports, reloadLooks]);

  // A remembered preset that no longer exists falls back: the first export preset, no look.
  useEffect(() => {
    if (exports.length && !exports.some((p) => p.slug === activeExport)) setActiveExport(exports[0]!.slug);
  }, [exports, activeExport, setActiveExport]);
  useEffect(() => {
    if (activeLook && looks.length && !looks.some((l) => l.slug === activeLook)) setActiveLook('');
  }, [looks, activeLook, setActiveLook]);

  const loadDir = useCallback(
    async (target: string) => {
      if (!target) return;
      setLoadingDir(true);
      setDirError(null);
      try {
        const folder = await fetchFolder(target);
        setListing(folder.listing);
        setEdits(folder.edits);
        setDir(folder.listing.path);
        setSelection(new Set());
      } catch (err) {
        setDirError((err as Error).message);
      } finally {
        setLoadingDir(false);
      }
    },
    [setDir],
  );

  /** Re-read the current folder, keeping the selection of the files that are still there. */
  const reloadDir = useCallback(async () => {
    if (!dir) return;
    try {
      const folder = await fetchFolder(dir);
      setListing(folder.listing);
      setEdits(folder.edits);
      const present = new Set(folder.listing.files.map((f) => f.path));
      setSelection((prev) => new Set([...prev].filter((p) => present.has(p))));
    } catch (err) {
      setDirError((err as Error).message);
    }
  }, [dir]);

  // Initial folder: last used, else the first quick root.
  useEffect(() => {
    if (dir) void loadDir(dir);
    else
      api
        .roots()
        .then((r) => r[0] && loadDir(r[0].path))
        .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const editFor = useCallback((p: string) => edits.edits[baseNameOf(p)], [edits]);

  const patchEdits = useCallback(
    async (patch: EditPatches) => {
      // One request per folder: paths may come from the current dir or from a session's dir.
      const byDir = new Map<string, EditPatches>();
      for (const [file, change] of Object.entries(patch)) {
        const folder = dirOf(file) || dir;
        byDir.set(folder, { ...byDir.get(folder), [baseNameOf(file)]: change });
      }
      for (const [folder, changes] of byDir) {
        const next = await api.patchEdits(folder, changes);
        if (folder === dir) setEdits(next);
      }
    },
    [dir],
  );
  const patchEdit = useCallback((p: string, change: ImageEditPatch | null) => patchEdits({ [p]: change }), [patchEdits]);

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = toastId.current++;
      setToasts((prev) => [...prev, { ...t, id }]);
      const ttl = t.ttl ?? (t.actions ? TOAST_WITH_ACTIONS_TTL_MS : TOAST_TTL_MS);
      if (ttl > 0) window.setTimeout(() => dismissToast(id), ttl);
    },
    [dismissToast],
  );

  const value = useMemo<AppStore>(
    () => ({
      tab,
      go,
      info,
      settings,
      reloadSettings,
      exports,
      reloadExports,
      looks,
      reloadLooks,
      jobs,
      dir,
      listing,
      loadingDir,
      dirError,
      loadDir,
      reloadDir,
      selection,
      setSelection,
      focusedPath,
      setFocusedPath,
      activeLook,
      setActiveLook,
      activeAspect,
      setActiveAspect,
      activeExport,
      setActiveExport,
      edits,
      editFor,
      patchEdit,
      patchEdits,
      session,
      setSession,
      toasts,
      toast,
      dismissToast,
    }),
    [
      tab, go, info, settings, reloadSettings, exports, reloadExports, looks, reloadLooks, jobs, dir, listing, loadingDir, dirError, loadDir, reloadDir,
      selection, setSelection, focusedPath, setFocusedPath, activeLook, setActiveLook, activeAspect, setActiveAspect, activeExport, setActiveExport,
      edits, editFor, patchEdit, patchEdits, session, setSession, toasts, toast, dismissToast,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
