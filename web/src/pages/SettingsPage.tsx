import { useEffect, useState } from 'react';
import { Aperture, CircleAlert, CircleCheck, Cpu, Crop, FolderOpen, Gauge, HardDriveDownload, Image as ImageIcon, Images, Save, ShieldCheck, Sparkles } from 'lucide-react';
import type { ServerInfo, Settings } from '../../../shared/src/api.js';

import { api } from '../api.js';
import { Button, Card, Field, Hero, Input, KV, layout, PageHeader, Select, Stat, StatStrip, type SelectOption } from '../components/ui.js';
import { GRAVITY_OPTIONS, VERIFY_WORDS, autoPlacement } from '../lib/spec.js';
import { useApp } from '../store.js';
import { baseNameOf } from '../lib/paths.js';

const RAW_ENGINE_OPTIONS: SelectOption<Settings['raw']['engine']>[] = [
  { value: 'auto', label: 'Auto', hint: 'darktable if installed, else built-in LibRaw' },
  { value: 'darktable', label: 'darktable-cli', hint: 'falls back to LibRaw if not found' },
  { value: 'libraw', label: 'LibRaw (built in)', hint: 'no install, CPU only, ~10 s for 50 MP' },
  { value: 'embedded', label: 'Embedded preview only', hint: 'never develop; use the JPEG inside the DNG' },
];
const VERIFY_OPTIONS: SelectOption<Settings['importVerify']>[] = [
  { value: 'photos', label: 'Photos and RAW', hint: 'videos: size only' },
  { value: 'all', label: 'Everything', hint: 'including videos (slower)' },
  { value: 'none', label: 'Never', hint: 'size only' },
];
const VERIFY_SHORT = { photos: 'Photos + RAW', all: 'Everything', none: 'Size only' } as const;
const ENGINE_LABEL = { darktable: 'darktable', libraw: 'LibRaw', embedded: 'Preview only' } as const;


export function SettingsPage() {
  const app = useApp();
  const [draft, setDraft] = useState<Settings | null>(app.settings);
  const [info, setInfo] = useState<ServerInfo | null>(app.info);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => setDraft(app.settings), [app.settings]);
  useEffect(() => {
    api.info().then(setInfo).catch(() => undefined);
  }, []);

  if (!draft) return <div className="p-6 text-ink-2">Loading…</div>;
  const set = (patch: Partial<Settings>) => {
    setDraft({ ...draft, ...patch });
    setMsg(null);
  };
  const dirty = JSON.stringify(draft) !== JSON.stringify(app.settings);

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      await api.saveSettings(draft);
      await app.reloadSettings();
      setInfo(await api.info());
      setMsg('Saved');
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const engine = info?.raw.engine;
  const hero =
    engine === 'darktable' ? (
      <Hero
        tone="green"
        icon={CircleCheck}
        title={`DNGs develop with darktable${info?.raw.version ? ` ${info.raw.version}` : ''}`}
        text={`Found at ${info?.raw.darktablePath}. Each DNG is developed once to a cached full-resolution JPEG, then edited like any photo.${info?.raw.libraw ? ' LibRaw stays as the fallback.' : ''}`}
      />
    ) : engine === 'libraw' ? (
      <Hero
        tone="green"
        icon={CircleCheck}
        title="DNGs develop with the built-in LibRaw"
        text="No install needed: a 50 MP DNG takes about 5 to 10 seconds the first time, then it is cached. darktable (free) would add its rendering and GPU speed; the app finds darktable-cli by itself once it is installed."
        actions={
          <a href="https://www.darktable.org/install/" target="_blank" rel="noreferrer">
            <Button variant="hero">Get darktable</Button>
          </a>
        }
      />
    ) : engine === 'embedded' ? (
      <Hero
        tone="amber"
        icon={CircleAlert}
        title="DNGs only show the preview embedded in them"
        text={`${info?.raw.librawError ? `LibRaw failed to load: ${info.raw.librawError}. ` : ''}Set the engine to Auto below, or install darktable, to develop them properly.`}
      />
    ) : null;

  const folderNote = `Import copies into the ${baseNameOf(draft.archiveRoot) || 'archive'} folder; exports without a folder of their own go to the ${baseNameOf(draft.exportRoot) || 'export'} folder, one subfolder per preset. The cache holds thumbnails, previews and developed DNGs, and is safe to delete.`;
  const rawNote =
    draft.raw.engine === 'auto'
      ? `Auto uses darktable when it is installed, else the built-in LibRaw; on this machine that means ${engine ? ENGINE_LABEL[engine] : '…'}.`
      : draft.raw.engine === 'embedded'
        ? 'DNGs will never be developed: the gallery and exports use the small JPEG inside each file.'
        : `Forced to ${draft.raw.engine === 'darktable' ? 'darktable-cli' : 'LibRaw'}; if it is missing the app falls back down the chain. Developed files are JPEG q${draft.raw.quality}.`;

  return (
    <div className={layout.scrollPage}>
      <PageHeader title="Settings" sub="Where files go, how DNGs develop, how fast it runs.">
        {msg && <span className={msg === 'Saved' ? 'text-small text-good' : 'text-small text-bad'}>{msg}</span>}
        {dirty && !msg && <span className="text-small text-warn">Unsaved changes</span>}
        <Button variant="primary" onClick={() => void save()} disabled={saving || !dirty}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save settings'}
        </Button>
      </PageHeader>

      <div className={layout.pageBody}>
        {hero}

        <StatStrip>
          <Stat label="RAW engine" value={engine ? ENGINE_LABEL[engine] : '–'} sub={draft.raw.engine === 'auto' ? 'chosen automatically' : `set to ${draft.raw.engine}`} icon={Aperture} tone={engine === 'embedded' ? 'amber' : 'green'} />
          <Stat label="Parallel jobs" value={draft.concurrency} sub="renders or copies at once" icon={Cpu} tone="gray" />
          <Stat label="Preview proxy" value={`${draft.previewMaxEdge} px`} sub="long edge" icon={ImageIcon} tone="blue" />
          <Stat label="Thumbnails" value={`${draft.thumbSize} px`} sub="gallery tiles" icon={Images} tone="blue" />
          <Stat label="Copies checked" value={VERIFY_SHORT[draft.importVerify]} sub="on import" icon={ShieldCheck} tone="violet" />
        </StatStrip>

        <div className={layout.columns}>
          <div className={layout.column}>
            <Card title="Folders" icon={FolderOpen} tone="blue" note={folderNote}>
              <div className="space-y-3">
                <Field label="Archive root" hint="Import copies here as YYYY/YYYY-MM-DD">
                  <Input value={draft.archiveRoot} onChange={(e) => set({ archiveRoot: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="Export root" hint="presets without a destination write to <export>/<preset>">
                  <Input value={draft.exportRoot} onChange={(e) => set({ exportRoot: e.target.value })} spellCheck={false} />
                </Field>
                <Field label="Cache folder" hint="thumbnails, proxies, developed RAWs">
                  <Input value={draft.cacheDir} onChange={(e) => set({ cacheDir: e.target.value })} spellCheck={false} />
                </Field>
              </div>
            </Card>

            <Card title="RAW (DNG) development" icon={Aperture} tone="amber" note={rawNote}>
              <div className="grid grid-cols-[13rem_1fr] gap-3">
                <Field label="Engine">
                  <Select value={draft.raw.engine} options={RAW_ENGINE_OPTIONS} onChange={(v) => set({ raw: { ...draft.raw, engine: v } })} />
                </Field>
                <Field label="darktable-cli path" hint="empty = search Program Files / PATH">
                  <Input value={draft.raw.darktablePath} onChange={(e) => set({ raw: { ...draft.raw, darktablePath: e.target.value } })} spellCheck={false} placeholder="C:\Program Files\darktable\bin\darktable-cli.exe" />
                </Field>
              </div>
            </Card>

            <Card title="Crop" icon={Crop} tone="blue" note={`Photos you have not framed by hand are cropped ${autoPlacement(draft.defaultGravity)}. Cropping only removes pixels; the export preset decides the size.`}>
              <Field label="Automatic crop position" hint="used for photos you have not framed by hand">
                <Select value={draft.defaultGravity} options={GRAVITY_OPTIONS} onChange={(g) => set({ defaultGravity: g })} />
              </Field>
            </Card>

            <Card
              title="Performance"
              icon={Gauge}
              tone="gray"
              note={`${draft.concurrency} at a time. Previews render from a ${draft.previewMaxEdge} px copy and thumbnails are ${draft.thumbSize} px; changing either only affects new cache files.`}
            >
              <div className="grid grid-cols-3 gap-3">
                <Field label="Concurrency" hint="parallel renders/copies">
                  <Input type="number" min={1} max={16} value={draft.concurrency} onChange={(e) => set({ concurrency: Math.min(16, Math.max(1, Math.floor(Number(e.target.value) || 1))) })} />
                </Field>
                <Field label="Preview proxy (px)" hint="long edge">
                  <Input type="number" min={600} max={4000} value={draft.previewMaxEdge} onChange={(e) => set({ previewMaxEdge: Math.min(4000, Math.max(600, Math.floor(Number(e.target.value) || 1600))) })} />
                </Field>
                <Field label="Thumbnail (px)">
                  <Input type="number" min={120} max={640} value={draft.thumbSize} onChange={(e) => set({ thumbSize: Math.min(640, Math.max(120, Math.floor(Number(e.target.value) || 320))) })} />
                </Field>
              </div>
            </Card>

            <Card title="Import" icon={HardDriveDownload} tone="violet" note={`Copies are checked ${VERIFY_WORDS[draft.importVerify]}; size is always compared.`}>
              <Field label="Verify copies by content hash" hint="size is always checked">
                <Select value={draft.importVerify} options={VERIFY_OPTIONS} onChange={(v) => set({ importVerify: v })} />
              </Field>
            </Card>

            <Card
              title="AI upscaler"
              subtitle="reserved"
              icon={Sparkles}
              tone="gray"
              note={`${draft.upscaler.binPath ? 'A path is set, but the' : 'Not configured. The'} upscale step is a typed slot for realesrgan-ncnn-vulkan on the GPU and does nothing yet.`}
            >
              <Field label="realesrgan-ncnn-vulkan binary">
                <Input value={draft.upscaler.binPath} onChange={(e) => set({ upscaler: { ...draft.upscaler, binPath: e.target.value } })} spellCheck={false} placeholder="C:\tools\realesrgan\realesrgan-ncnn-vulkan.exe" />
              </Field>
            </Card>
          </div>

          <div className={layout.column}>
            <Card title="System" icon={Cpu} tone="gray" note={info ? 'Settings, looks and export presets are plain files in the config folder; back that folder up to keep them. The data folder holds the cache and the job history.' : undefined}>
              {info ? (
                <>
                  <KV label="Server">v{info.version}</KV>
                  <KV label="Node">{info.node}</KV>
                  <KV label="Platform">{info.platform}</KV>
                  <KV label="Config folder" title={info.configDir}>
                    {info.configDir}
                  </KV>
                  <KV label="Data folder" title={info.dataDir}>
                    {info.dataDir}
                  </KV>
                  <KV label="LibRaw">{info.raw.libraw ? 'loaded' : 'not available'}</KV>
                  <KV label="darktable" title={info.raw.darktablePath ?? undefined}>
                    {info.raw.darktablePath ? (info.raw.version ?? 'found') : 'not installed'}
                  </KV>
                </>
              ) : (
                <div className="text-small text-ink-2">Asking the server…</div>
              )}
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
