import { useEffect, useState } from 'preact/hooks';
import type { Doc } from '../core/doc';
import { docExportSize, exportDoc, type ExportResult, type Format } from '../core/export';
import { nextFrame, Sheet, Slider, toast } from './common';
import { IcShare } from './icons';

export interface ExportSpec {
  formats: Format[];
  sizes: { label: string; scale: number }[];
  /** output size for a scale and format, plus an optional note */
  describe(scale: number, format: Format): { w: number; h: number; note?: string };
  produce(format: Format, quality: number, scale: number, onProgress: (f: number) => void): Promise<ExportResult>;
}

function mb(n: number) {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;
}

/** Saves through the iOS share sheet ("Save Image" puts it in Photos), falling back to a download. */
function share(r: ExportResult) {
  const file = new File([r.blob], r.name, { type: r.blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    // Must run synchronously inside the tap handler: Safari requires a fresh user gesture.
    nav.share({ files: [file] }).catch((e: Error) => {
      if (e.name !== 'AbortError') {
        toast('Sharing failed — use Download instead');
      }
    });
    return;
  }
  download(r);
}

function download(r: ExportResult) {
  const url = URL.createObjectURL(r.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = r.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ExportSheetBase(props: { spec: ExportSpec; onClose: () => void; title?: string }) {
  const { spec } = props;
  const [format, setFormat] = useState<Format>(spec.formats[0]);
  const [quality, setQuality] = useState(92);
  const [scale, setScale] = useState(spec.sizes[0].scale);
  const [progress, setProgress] = useState<number | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const info = spec.describe(scale, format);

  const run = async () => {
    setProgress(0);
    await nextFrame();
    try {
      const r = await spec.produce(format, quality / 100, scale, (f) => setProgress(f));
      setResult(r);
      setUrl(URL.createObjectURL(r.blob));
    } catch (e) {
      console.error(e);
      toast(`Export failed: ${(e as Error).message}`);
    } finally {
      setProgress(null);
    }
  };

  if (result && url) {
    return (
      <Sheet title="Ready" onClose={props.onClose} keep>
        <img class="preview-img" src={url} alt="Exported image" data-testid="export-preview" />
        <p class="note" data-testid="export-info">
          {result.width} × {result.height} · {result.blob.type === 'image/png' ? 'PNG' : 'JPEG'} · {mb(result.blob.size)}
          {result.limited ? ' · reduced to fit this device' : ''}
        </p>
        <p class="note">Tap Save, then choose “Save Image” to put it in Photos. You can also long-press the preview.</p>
        <div class="actions">
          <button class="btn" onClick={() => download(result)}>
            Download
          </button>
          <button class="btn primary" onClick={() => share(result)} data-testid="share-btn">
            <IcShare /> Save
          </button>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet title={props.title ?? 'Save'} onClose={props.onClose}>
      {spec.formats.length > 1 && (
        <div class="row">
          {spec.formats.map((f) => (
            <button key={f} class={'chip' + (format === f ? ' on' : '')} onClick={() => setFormat(f)}>
              {f === 'jpeg' ? 'JPEG' : 'PNG'}
            </button>
          ))}
        </div>
      )}
      {format === 'jpeg' && (
        <Slider name="Quality" min={50} max={100} neutral={92} value={quality} onInput={setQuality} onCommit={setQuality} />
      )}
      <div class="row wrap">
        {spec.sizes.map((s) => (
          <button key={s.label} class={'chip' + (scale === s.scale ? ' on' : '')} onClick={() => setScale(s.scale)}>
            {s.label}
          </button>
        ))}
      </div>
      <p class="note" data-testid="export-dims">
        {info.w} × {info.h} px{info.note ? ` · ${info.note}` : ''}
      </p>
      {format === 'png' && <p class="note">PNG keeps transparency and is lossless, but files are larger.</p>}
      <div class="actions">
        <button class="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button class="btn primary" onClick={run} disabled={progress !== null} data-testid="export-run">
          {progress === null ? 'Export' : `Working… ${Math.round(progress * 100)}%`}
        </button>
      </div>
    </Sheet>
  );
}

export function ExportSheet(props: { doc: Doc; onClose: () => void }) {
  const { doc } = props;
  const hasTransparency = doc.background === null && (doc.base.mask !== null || doc.layers.length > 0);
  const spec: ExportSpec = {
    formats: hasTransparency && doc.base.mask ? ['png', 'jpeg'] : ['jpeg', 'png'],
    sizes: [
      { label: 'Full size', scale: 1 },
      { label: 'Large (50%)', scale: 0.5 },
      { label: 'Small (25%)', scale: 0.25 },
    ],
    describe: (s) => {
      const r = docExportSize(doc, s);
      return { w: r.w, h: r.h, note: r.limited ? 'reduced to the largest size this device can render' : undefined };
    },
    produce: (f, q, s) => exportDoc(doc, f, q, s),
  };
  return <ExportSheetBase spec={spec} onClose={props.onClose} />;
}
