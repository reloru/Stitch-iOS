import { useState } from 'preact/hooks';
import { newDoc, type Doc } from '../core/doc';
import { loadSource, type SourceImage } from '../core/source';
import { Editor } from '../editor/Editor';
import { loadStitchItems, Stitch } from '../stitch/Stitch';
import type { StitchItem } from '../stitch/view';
import { Busy, toast, ToastHost, usePicker } from '../ui/common';
import { IcPhoto, IcStitch } from '../ui/icons';

type Screen = { kind: 'home' } | { kind: 'editor'; doc: Doc; key: number } | { kind: 'stitch'; items: StitchItem[]; key: number };

let screenKey = 1;

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [busy, setBusy] = useState<string | null>(null);

  const openEditor = (src: SourceImage) => setScreen({ kind: 'editor', doc: newDoc(src), key: screenKey++ });

  const pickOne = usePicker(async (files) => {
    setBusy('Opening photo…');
    try {
      const f = files[0];
      openEditor(await loadSource(f, f.name.replace(/\.[^.]+$/, '')));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, false);

  const pickMany = usePicker(async (files) => {
    setBusy('Opening photos…');
    try {
      const items = await loadStitchItems(files, (i) => setBusy(`Opening photo ${i + 1} of ${files.length}…`));
      setScreen({ kind: 'stitch', items, key: screenKey++ });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, true);

  return (
    <>
      {screen.kind === 'home' && (
        <div class="home">
          <div class="status-cap" />
          <h1>Stitch</h1>
          <p class="lead">Edit, overlay, mask and stitch photos. Everything stays on your phone.</p>
          <button class="home-card" onClick={pickOne.open} data-testid="home-edit">
            <div class="ic" style={{ background: 'linear-gradient(135deg,#ffb35c,#ff5e7a)' }}>
              <IcPhoto />
            </div>
            <div>
              <h2>Edit a photo</h2>
              <span>Adjust, filters, crop, overlays, text and masks</span>
            </div>
          </button>
          <button class="home-card" onClick={pickMany.open} data-testid="home-stitch">
            <div class="ic" style={{ background: 'linear-gradient(135deg,#5ce1e6,#5b7cff)' }}>
              <IcStitch />
            </div>
            <div>
              <h2>Stitch photos</h2>
              <span>Combine photos or scrolling screenshots, trim the seams</span>
            </div>
          </button>
          <div class="foot">Build {__BUILD__}</div>
        </div>
      )}
      {screen.kind === 'editor' && (
        <Editor
          key={screen.key}
          initial={screen.doc}
          onClose={() => setScreen({ kind: 'home' })}
        />
      )}
      {screen.kind === 'stitch' && (
        <Stitch key={screen.key} initial={screen.items} onClose={() => setScreen({ kind: 'home' })} onEdit={openEditor} />
      )}
      {pickOne.input}
      {pickMany.input}
      <Busy text={busy} />
      <ToastHost />
    </>
  );
}
