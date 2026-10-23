import { useEffect, useState } from 'preact/hooks';
import { newDoc, type Doc } from '../core/doc';
import { clearSession, restoreSession, sessionInfo, type SessionInfo } from '../core/persist';
import { loadSource, type SourceImage } from '../core/source';
import type { StitchSettings } from '../core/stitch';
import { Editor } from '../editor/Editor';
import { loadStitchItems, Stitch } from '../stitch/Stitch';
import type { StitchItem } from '../stitch/view';
import { Busy, Sheet, toast, ToastHost, usePicker } from '../ui/common';
import { IcClose, IcPhoto, IcStitch } from '../ui/icons';

type Screen =
  | { kind: 'home' }
  | { kind: 'editor'; doc: Doc; key: number; restored?: boolean }
  | { kind: 'stitch'; items: StitchItem[]; settings?: StitchSettings; key: number; restored?: boolean };

let screenKey = 1;

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' });
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<SessionInfo | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const [confirmDrop, setConfirmDrop] = useState(false);

  // the home screen offers to continue an edit that was autosaved (e.g. before iOS closed the app)
  useEffect(() => {
    if (screen.kind !== 'home') return;
    let cancelled = false;
    void sessionInfo().then((s) => {
      if (!cancelled) setSaved(s);
    });
    return () => {
      cancelled = true;
    };
  }, [screen.kind]);
  useEffect(() => {
    const url = saved?.thumb ? URL.createObjectURL(saved.thumb) : null;
    setThumb(url);
    return () => void (url && URL.revokeObjectURL(url));
  }, [saved]);

  const openEditor = (src: SourceImage) => setScreen({ kind: 'editor', doc: newDoc(src), key: screenKey++ });

  const resume = async () => {
    setBusy('Opening your last edit…');
    try {
      const r = await restoreSession();
      if (!r) {
        toast('The saved edit could not be opened');
        await clearSession();
        setSaved(null);
        return;
      }
      if (r.kind === 'editor') setScreen({ kind: 'editor', doc: r.doc, key: screenKey++, restored: true });
      else setScreen({ kind: 'stitch', items: r.items, settings: r.settings, key: screenKey++, restored: true });
    } finally {
      setBusy(null);
    }
  };

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
          <p class="lead">Edit, overlay, mask and stitch photos. Editing happens on your phone; only Remove background uses the internet.</p>
          {saved && (
            <div class="home-card resume">
              <button class="resume-open" onClick={() => void resume()} data-testid="home-resume">
                <div class="ic" style={thumb ? { backgroundImage: `url(${thumb})` } : { background: 'var(--panel-2)' }} />
                <div>
                  <h2>Continue {saved.kind === 'editor' ? 'editing' : 'stitch'}</h2>
                  <span>Saved {ago(saved.savedAt)}</span>
                </div>
              </button>
              <button class="tb-btn" aria-label="Discard saved edit" onClick={() => setConfirmDrop(true)}>
                <IcClose />
              </button>
            </div>
          )}
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
          {saved && <p class="note muted">Starting something new replaces the saved edit once you change it.</p>}
          <div class="foot">Build {__BUILD__}</div>
        </div>
      )}
      {screen.kind === 'editor' && <Editor key={screen.key} initial={screen.doc} restored={screen.restored} onClose={() => setScreen({ kind: 'home' })} />}
      {screen.kind === 'stitch' && (
        <Stitch
          key={screen.key}
          initial={screen.items}
          initialSettings={screen.settings}
          restored={screen.restored}
          onClose={() => setScreen({ kind: 'home' })}
          onEdit={openEditor}
        />
      )}
      {confirmDrop && (
        <Sheet title="Discard the saved edit?" onClose={() => setConfirmDrop(false)}>
          <p class="note">It can’t be brought back afterwards.</p>
          <div class="actions">
            <button class="btn" onClick={() => setConfirmDrop(false)}>
              Keep it
            </button>
            <button
              class="btn danger"
              onClick={() => {
                setConfirmDrop(false);
                setSaved(null);
                void clearSession();
              }}
            >
              Discard
            </button>
          </div>
        </Sheet>
      )}
      {pickOne.input}
      {pickMany.input}
      <Busy text={busy} />
      <ToastHost />
    </>
  );
}
