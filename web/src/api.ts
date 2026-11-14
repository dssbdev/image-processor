import type {
  FocalPoint,
  FsListing,
  FsOpResult,
  ImageInfo,
  ImportPlan,
  Job,
  QuickRoot,
  RenderRequest,
  ServerInfo,
  Settings,
} from '../../shared/src/api.js';
import type { NormRect } from '../../shared/src/crop.js';
import type { FolderEdits, ImageEditPatch } from '../../shared/src/edits.js';
import type { LookPreset, LookPresetInput } from '../../shared/src/looks.js';
import type { AspectRatio, ExportPreset, ExportPresetInput, Gravity, Look } from '../../shared/src/spec.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public issues?: unknown,
  ) {
    super(message);
  }
}

/** The error a failed response describes: the server's `{ error, issues }` body when there is one. */
async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: unknown };
  return new ApiError(res.status, body.error ?? res.statusText, body.issues);
}

/** Send JSON (when there is a body), fail on a non-2xx status, hand back the raw response. */
async function send(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(url, {
    method,
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw await toApiError(res);
  return res;
}

async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(method, url, body);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const get = <T>(url: string) => json<T>('GET', url);
const post = <T>(url: string, body?: unknown) => json<T>('POST', url, body);
const put = <T>(url: string, body?: unknown) => json<T>('PUT', url, body);

/** "?a=1&b=2", skipping undefined values. */
function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  return `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`;
}

/** The REST surface every preset library has (looks, export presets). */
function presetApi<T, Input extends { slug: string }>(base: string) {
  const one = (slug: string) => `${base}/${encodeURIComponent(slug)}`;
  return {
    list: () => get<T[]>(base),
    create: (preset: Input) => post<T>(base, preset),
    update: (preset: Input) => put<T>(one(preset.slug), preset),
    remove: (slug: string) => json<{ ok: true }>('DELETE', one(slug)),
    restoreDefaults: () => post<{ restored: number }>(`${base}/restore-defaults`),
  };
}

export const api = {
  info: () => get<ServerInfo>('/api/info'),
  settings: () => get<Settings>('/api/settings'),
  saveSettings: (patch: Partial<Settings>) => put<Settings>('/api/settings', patch),

  roots: () => get<QuickRoot[]>('/api/fs/roots'),
  list: (path: string) => get<FsListing>(`/api/fs/list${query({ path })}`),
  imageInfo: (path: string) => get<ImageInfo>(`/api/image/info${query({ path })}`),
  thumbUrl: (path: string, size?: number) => `/api/thumb${query({ path, size })}`,
  proxyUrl: (path: string) => `/api/proxy${query({ path })}`,

  edits: (dir: string) => get<FolderEdits>(`/api/edits${query({ dir })}`),
  patchEdits: (dir: string, patch: Record<string, ImageEditPatch | null>) => put<FolderEdits>('/api/edits', { dir, patch }),
  trash: (paths: string[]) => post<FsOpResult>('/api/fs/trash', { paths }),
  move: (paths: string[], dest: string) => post<FsOpResult>('/api/fs/move', { paths, dest }),
  openInOs: (path: string) => post<{ ok: true; path: string }>('/api/os/open', { path }),

  looks: presetApi<LookPreset, LookPresetInput>('/api/looks'),
  exports: presetApi<ExportPreset, ExportPresetInput>('/api/exports'),

  jobs: () => get<Job[]>('/api/jobs'),
  job: (id: string) => get<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  cancelJob: (id: string) => post<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/cancel`),
  render: (req: RenderRequest) => post<Job>('/api/jobs/render', req),

  planImport: (source: string) => post<ImportPlan>('/api/import/plan', { source }),
  runImport: (plan: ImportPlan) => post<Job>('/api/import/run', { plan }),
};

export interface PreviewResult {
  url: string;
  crop: NormRect | null;
  width: number;
  height: number;
  sourceWidth: number;
  sourceHeight: number;
}

export interface PreviewArgs {
  path: string;
  /** Look preset slug (''/undefined = none) or unsaved look object (editor state). */
  look?: string | Partial<Look> | null;
  adjust?: Record<string, number> | null;
  aspect?: AspectRatio | null;
  gravity?: Gravity | null;
  focal?: FocalPoint | null;
  crop?: NormRect | null;
  maxEdge?: number;
  mode?: 'before' | 'after';
}

/** "1200x800" → [1200, 800]; a missing header reads as 0 × 0. */
function sizeHeader(res: Response, name: string): [number, number] {
  const [w, h] = (res.headers.get(name) ?? '').split('x').map(Number);
  return [w || 0, h || 0];
}

/**
 * Render a preview through the real pipeline (same code as the export, smaller output).
 * Returns an object URL; call URL.revokeObjectURL when done with it.
 */
export async function fetchPreview(args: PreviewArgs, signal?: AbortSignal): Promise<PreviewResult> {
  const res = await send('POST', '/api/preview', args, signal);
  const [width, height] = sizeHeader(res, 'X-Size');
  const [sourceWidth, sourceHeight] = sizeHeader(res, 'X-Source-Size');
  const crop = JSON.parse(res.headers.get('X-Crop') ?? 'null') as NormRect | null;
  return { url: URL.createObjectURL(await res.blob()), crop, width, height, sourceWidth, sourceHeight };
}
