import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { toGray, autoTrims, type Gray } from '../core/autostitch';
import { ctx2d, releaseCanvas } from '../core/canvas';
import { exportStitch, planStitchExport, renderStitchForEditor } from '../core/export';
import { History } from '../core/history';
import { decodeFull, disposeSource, loadSource, sourceFromCanvas, uid, type SourceImage } from '../core/source';
import { NO_TRIM, STITCH_DEFAULTS, type StitchSettings, type Trim } from '../core/stitch';
import { Busy, nextFrame, Scroller, Sheet, Slider, toast, useHint, usePicker } from '../ui/common';
import { ExportSheetBase, type ExportSpec } from '../ui/ExportSheet';
import { IcAuto, IcBack, IcCols, IcEdit, IcGrid, IcLeft, IcPlus, IcRedo, IcRight, IcRows, IcShare, IcTrash, IcUndo } from '../ui/icons';
import { itemDims, StitchView, type StitchItem } from './view';

interface StitchState {
  items: StitchItem[];
  settings: StitchSettings;
}

const BG = ['#ffffff', '#000000', '#16161d', '#f4efe6', '#ffb35c', '#5ce1e6'];
const CELL_ASPECTS: { name: string; v: number | null }[] = [
  { name: 'Square', v: 1 },
  { name: '4:5', v: 4 / 5 },
  { name: '3:4', v: 3 / 4 },
  { name: '9:16', v: 9 / 16 },
  { name: 'First photo', v: null },
];

type Tab = 'photos' | 'layout' | 'style';

export async function loadStitchItems(files: File[], onProgress?: (i: number) => void): Promise<StitchItem[]> {
  const out: StitchItem[] = [];
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i);
    const src = await loadSource(files[i], files[i].name.replace(/\.[^.]+$/, ''));
    out.push({ id: uid('item'), src, trim: { ...NO_TRIM } });
  }
  return out;
}

export function Stitch(props: { initial: StitchItem[]; onClose: () => void; onEdit: (src: SourceImage) => void }) {
  const [st, setSt] = useState<StitchState>({ items: props.initial, settings: { ...STITCH_DEFAULTS } });
  const stRef = useRef(st);
  const hist = useMemo(() => new History<StitchState, never>(stRef.current, () => [], { read: () => new Uint8Array(), write: () => {} }), []);
  const [, setTick] = useState(0);
  const [selected, setSelected] = useState(-1);
  const [tab, setTab] = useState<Tab>('photos');
  const [busy, setBusy] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<StitchView | null>(null);
  const ownedSources = useRef(new Set<SourceImage>(props.initial.map((i) => i.src)));

  const change = (next: StitchState, commit: boolean) => {
    stRef.current = next;
    setSt(next);
    if (commit) {
      hist.commit(next);
      setTick((t) => t + 1);
    }
  };
  const restore = (s: StitchState | null) => {
    if (!s) return;
    stRef.current = s;
    setSt(s);
    setTick((t) => t + 1);
  };

  const cbRef = useRef({
    touched: () => {},
    select: (i: number) => setSelected(i),
    trim: (i: number, t: Trim, commit: boolean) => {
      const cur = stRef.current;
      change({ ...cur, items: cur.items.map((it, j) => (j === i ? { ...it, trim: t } : it)) }, commit);
    },
  });

  useEffect(() => {
    const v = new StitchView(hostRef.current!, { items: st.items, settings: st.settings, selected }, {
      select: (i) => cbRef.current.select(i),
      trim: (i, t, c) => cbRef.current.trim(i, t, c),
      touched: () => cbRef.current.touched(),
    });
    viewRef.current = v;
    return () => {
      v.destroy();
      for (const s of ownedSources.current) disposeSource(s);
    };
  }, []);

  useEffect(() => {
    viewRef.current?.update({ items: st.items, settings: st.settings, selected });
  }, [st, selected]);

  const sel = selected >= 0 && selected < st.items.length ? selected : -1;
  const hint = useHint(st.items.length > 0 && sel < 0 ? 'Tap a photo to trim it · hold a thumbnail to reorder' : null);
  cbRef.current.touched = hint.dismiss;
  const setSettings = (p: Partial<StitchSettings>, commit = true) => change({ ...st, settings: { ...st.settings, ...p } }, commit);

  const addMore = usePicker(async (files) => {
    setBusy('Opening photos…');
    try {
      const more = await loadStitchItems(files, (i) => setBusy(`Opening photo ${i + 1} of ${files.length}…`));
      more.forEach((m) => ownedSources.current.add(m.src));
      change({ ...stRef.current, items: [...stRef.current.items, ...more] }, true);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, true, 'pick-more');

  /** Moves item `from` to position `to` (long-press drag in the strip). */
  const reorder = (from: number, to: number) => {
    const cur = stRef.current;
    if (from === to || from < 0 || to < 0 || from >= cur.items.length || to >= cur.items.length) return;
    const items = cur.items.slice();
    const [x] = items.splice(from, 1);
    items.splice(to, 0, x);
    change({ ...cur, items }, true);
    setSelected(to);
  };
  const drag = useStripDrag(reorder);

  const move = (dir: -1 | 1) => {
    const j = sel + dir;
    if (sel < 0 || j < 0 || j >= st.items.length) return;
    const items = st.items.slice();
    [items[sel], items[j]] = [items[j], items[sel]];
    change({ ...st, items }, true);
    setSelected(j);
  };

  const remove = () => {
    if (sel < 0) return;
    change({ ...st, items: st.items.filter((_, i) => i !== sel) }, true);
    setSelected(-1);
  };

  const autoAlign = async () => {
    if (st.items.length < 2) {
      toast('Add at least two screenshots');
      return;
    }
    setBusy('Finding overlaps…');
    await nextFrame();
    try {
      const grays: Gray[] = [];
      for (const it of st.items) {
        const c = await decodeFull(it.src);
        const d = ctx2d(c, { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
        grays.push(toGray(d, c.width, c.height));
        releaseCanvas(c);
      }
      const { trims, failed } = autoTrims(grays);
      const items = st.items.map((it, i) => ({ ...it, trim: { ...it.trim, top: trims[i].top, bottom: trims[i].bottom } }));
      change({ items, settings: { ...st.settings, layout: 'vertical', gap: 0, padding: 0, radius: 0 } }, true);
      if (failed.length === st.items.length - 1) toast('No overlap found. These may not be scrolling screenshots of the same page.', 4000);
      else if (failed.length) toast(`Aligned, but no overlap between ${failed.map((i) => `${i + 1}–${i + 2}`).join(', ')}. Adjust those seams by hand.`, 4500);
      else toast('Screenshots aligned');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toEditor = async () => {
    setBusy('Preparing…');
    await nextFrame();
    try {
      const { canvas, limited } = await renderStitchForEditor(
        st.items.map((i) => i.src),
        itemDims(st.items),
        st.settings,
      );
      const src = await sourceFromCanvas(canvas, 'Stitched', false);
      releaseCanvas(canvas);
      if (limited) toast('The stitched image was reduced to fit the editor on this device. Save from here for full size.', 4500);
      props.onEdit(src);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportSpec: ExportSpec = {
    formats: ['jpeg', 'png'],
    sizes: [
      { label: 'Full size', scale: 1 },
      { label: 'Large (50%)', scale: 0.5 },
      { label: 'Small (25%)', scale: 0.25 },
    ],
    describe: (s, f) => {
      const p = planStitchExport(itemDims(st.items), st.settings, s, f === 'png');
      const note = p.tiled
        ? 'very large: written in strips as PNG'
        : p.limited
          ? f === 'jpeg'
            ? 'reduced to fit this device; choose PNG for full size'
            : 'reduced to fit this device'
          : undefined;
      return { w: p.w, h: p.h, note };
    },
    produce: (f, q, s, onProgress) => {
      const p = planStitchExport(itemDims(st.items), st.settings, s, f === 'png');
      return exportStitch(
        st.items.map((i) => i.src),
        p,
        st.settings,
        f,
        q,
        onProgress,
      );
    },
  };

  const it = sel >= 0 ? st.items[sel] : null;
  const S = st.settings;

  return (
    <>
      <div class="topbar">
        <button class="tb-btn" aria-label="Back" onClick={() => (hist.canUndo ? setConfirmLeave(true) : props.onClose())}>
          <IcBack />
        </button>
        <div class="title">Stitch · {st.items.length}</div>
        <button class="tb-btn" aria-label="Edit result" onClick={toEditor} disabled={!st.items.length}>
          <IcEdit /> Edit
        </button>
        <button class="tb-btn primary" onClick={() => setExporting(true)} disabled={!st.items.length}>
          <IcShare /> Save
        </button>
      </div>

      <div class="topbar-space" />
      <div class="stage" ref={hostRef}>
        {st.items.length > 0 && sel < 0 && <div class={'hint' + (hint.visible ? '' : ' gone')}>Tap a photo to trim it · hold a thumbnail to reorder</div>}
      </div>
      <div class="editbar">
        <button class="tb-btn" aria-label="Undo" disabled={!hist.canUndo} onClick={() => restore(hist.undo())}>
          <IcUndo />
        </button>
        <button class="tb-btn" aria-label="Redo" disabled={!hist.canRedo} onClick={() => restore(hist.redo())}>
          <IcRedo />
        </button>
      </div>

      <div class="dock">
        <div class="panel">
          {tab === 'photos' && (
            <div>
              <div class="strip-list" ref={drag.listRef}>
                {st.items.map((x, i) => (
                  <button
                    key={x.id}
                    data-strip-index={i}
                    aria-label={`Photo ${i + 1}`}
                    class={'strip-item' + (i === sel ? ' on' : '') + drag.classFor(i)}
                    onPointerDown={(e) => drag.down(e, i)}
                    onClick={() => {
                      if (drag.consumeClick()) return;
                      setSelected(i === sel ? -1 : i);
                    }}
                  >
                    <img src={x.src.thumbUrl} alt="" />
                    <span class="n">{i + 1}</span>
                  </button>
                ))}
                <button class="strip-item" aria-label="Add photos" onClick={addMore.open} style={{ display: 'grid', placeItems: 'center' }}>
                  <IcPlus style={{ width: 26, height: 26 }} />
                </button>
              </div>
              {!it && (
                <div class="row">
                  <button class="btn primary" onClick={autoAlign} disabled={st.items.length < 2} data-testid="auto-align">
                    <IcAuto /> Auto-stitch screenshots
                  </button>
                </div>
              )}
              {!it && <p class="note muted" style={{ fontSize: '12px', margin: '4px 0' }}>Finds the overlap between scrolling screenshots and removes repeated bars.</p>}
              {it && (
                <>
                  <div class="row">
                    <button class="icon-btn" aria-label="Move earlier" onClick={() => move(-1)} disabled={sel === 0}>
                      <IcLeft />
                    </button>
                    <button class="icon-btn" aria-label="Move later" onClick={() => move(1)} disabled={sel === st.items.length - 1}>
                      <IcRight />
                    </button>
                    <span class="label">
                      Photo {sel + 1}: {it.src.width}×{it.src.height}
                    </span>
                    <span class="spacer" />
                    <button class="icon-btn" aria-label="Remove photo" style={{ color: 'var(--danger)' }} onClick={remove}>
                      <IcTrash />
                    </button>
                  </div>
                  {(['top', 'bottom', 'left', 'right'] as const).map((edge) => {
                    const max = edge === 'top' || edge === 'bottom' ? it.src.height : it.src.width;
                    const set = (v: number, commit: boolean) => cbRef.current.trim(sel, clampTrimFor(it, { ...it.trim, [edge]: v }), commit);
                    return (
                      <Slider
                        key={edge}
                        name={`Trim ${edge}`}
                        min={0}
                        max={Math.round(max * 0.95)}
                        value={Math.round(it.trim[edge])}
                        format={(v) => `${v}`}
                        onInput={(v) => set(v, false)}
                        onCommit={(v) => set(v, true)}
                      />
                    );
                  })}
                  <div class="row">
                    <button class="btn" onClick={() => cbRef.current.trim(sel, { ...NO_TRIM }, true)}>
                      Reset trim
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {tab === 'layout' && (
            <div>
              <div class="row">
                {(
                  [
                    ['vertical', 'Vertical', IcRows],
                    ['horizontal', 'Side by side', IcCols],
                    ['grid', 'Grid', IcGrid],
                  ] as const
                ).map(([id, name, Icon]) => (
                  <button key={id} class={'chip' + (S.layout === id ? ' on' : '')} onClick={() => setSettings({ layout: id })}>
                    <Icon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> {name}
                  </button>
                ))}
              </div>
              {S.layout === 'grid' && (
                <>
                  <Slider name="Columns" min={1} max={6} neutral={2} value={S.columns} onInput={(v) => setSettings({ columns: v }, false)} onCommit={(v) => setSettings({ columns: v })} />
                  <Scroller>
                    {CELL_ASPECTS.map((a) => (
                      <button key={a.name} class={'chip' + (S.cellAspect === a.v ? ' on' : '')} onClick={() => setSettings({ cellAspect: a.v })}>
                        {a.name}
                      </button>
                    ))}
                  </Scroller>
                </>
              )}
              {S.layout !== 'grid' && <p class="note muted">Photos are scaled to a common {S.layout === 'vertical' ? 'width' : 'height'}. Tap a photo, then drag its orange handles to trim.</p>}
            </div>
          )}
          {tab === 'style' && (
            <div>
              <Slider name="Spacing" min={0} max={120} value={S.gap} onInput={(v) => setSettings({ gap: v }, false)} onCommit={(v) => setSettings({ gap: v })} />
              <Slider name="Border" min={0} max={160} value={S.padding} onInput={(v) => setSettings({ padding: v }, false)} onCommit={(v) => setSettings({ padding: v })} />
              <Slider name="Corners" min={0} max={160} value={S.radius} onInput={(v) => setSettings({ radius: v }, false)} onCommit={(v) => setSettings({ radius: v })} />
              <Scroller>
                {BG.map((c) => (
                  <button key={c} aria-label={`Background ${c}`} class={'icon-btn' + (S.background === c ? ' on' : '')} style={{ background: c }} onClick={() => setSettings({ background: c })} />
                ))}
                <input type="color" value={S.background} aria-label="Custom background" onInput={(e) => setSettings({ background: (e.target as HTMLInputElement).value }, false)} onChange={() => setSettings({})} />
              </Scroller>
            </div>
          )}
        </div>
        <div class="tabs" role="tablist">
          {(
            [
              ['photos', 'Photos', IcPlus],
              ['layout', 'Layout', IcGrid],
              ['style', 'Style', IcCols],
            ] as const
          ).map(([id, name, Icon]) => (
            <button key={id} role="tab" aria-selected={tab === id} class={'tab' + (tab === id ? ' on' : '')} onClick={() => setTab(id)}>
              <Icon />
              {name}
            </button>
          ))}
        </div>
      </div>
      {addMore.input}
      {exporting && <ExportSheetBase spec={exportSpec} onClose={() => setExporting(false)} />}
      {confirmLeave && (
        <Sheet title="Leave Stitch?" onClose={() => setConfirmLeave(false)}>
          <p class="note">Your stitch is not saved until you tap Save. Leaving discards it.</p>
          <div class="actions">
            <button class="btn" onClick={() => setConfirmLeave(false)}>
              Keep editing
            </button>
            <button class="btn danger" onClick={props.onClose}>
              Discard
            </button>
          </div>
        </Sheet>
      )}
      <Busy text={busy} />
    </>
  );
}

/**
 * Long-press a thumbnail, then drag it sideways to reorder. A quick swipe still scrolls the strip: dragging only
 * starts once the finger has rested on a thumbnail, and from then on the strip's scrolling is blocked.
 */
function useStripDrag(reorder: (from: number, to: number) => void) {
  const listRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ from: number; to: number } | null>(null);
  const st = useRef<{ from: number; to: number; x: number; y: number; timer: number; active: boolean; id: number } | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // iOS: once a drag is active, cancel the touch's scrolling (needs a non-passive listener)
    const tm = (e: TouchEvent) => {
      if (st.current?.active) e.preventDefault();
    };
    el.addEventListener('touchmove', tm, { passive: false });
    return () => el.removeEventListener('touchmove', tm);
  }, []);

  const target = (clientX: number): number => {
    const el = listRef.current!;
    const items = Array.from(el.querySelectorAll<HTMLElement>('[data-strip-index]'));
    let best = st.current!.from;
    let bestD = Infinity;
    for (const it of items) {
      const r = it.getBoundingClientRect();
      const d = Math.abs(clientX - (r.left + r.width / 2));
      if (d < bestD) (bestD = d), (best = Number(it.dataset.stripIndex));
    }
    return best;
  };

  const down = (e: PointerEvent, i: number) => {
    if (st.current) return;
    const btn = e.currentTarget as HTMLElement;
    const s = {
      from: i,
      to: i,
      x: e.clientX,
      y: e.clientY,
      id: e.pointerId,
      active: false,
      timer: window.setTimeout(() => {
        s.active = true;
        try {
          btn.setPointerCapture(s.id);
        } catch {
          /* pointer already gone */
        }
        setState({ from: i, to: i });
      }, 380),
    };
    st.current = s;
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== s.id) return;
      if (!s.active) {
        if (Math.hypot(ev.clientX - s.x, ev.clientY - s.y) > 8) end(ev, false);
        return;
      }
      const el = listRef.current!;
      const r = el.getBoundingClientRect();
      if (ev.clientX < r.left + 40) el.scrollLeft -= 10;
      else if (ev.clientX > r.right - 40) el.scrollLeft += 10;
      s.to = target(ev.clientX);
      setState({ from: s.from, to: s.to });
    };
    const end = (ev: PointerEvent, commit: boolean) => {
      if (ev.pointerId !== s.id) return;
      clearTimeout(s.timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      st.current = null;
      if (s.active) {
        suppressClick.current = true;
        setState(null);
        if (commit) reorder(s.from, s.to);
      }
    };
    const up = (ev: PointerEvent) => end(ev, true);
    const cancel = (ev: PointerEvent) => end(ev, false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };

  return {
    listRef,
    down,
    consumeClick: () => {
      const v = suppressClick.current;
      suppressClick.current = false;
      return v;
    },
    classFor: (i: number) => {
      if (!state) return '';
      if (i === state.from) return ' dragging';
      if (i === state.to) return state.to < state.from ? ' drop-before' : ' drop-after';
      return '';
    },
  };
}

function clampTrimFor(it: StitchItem, t: Trim): Trim {
  const w = it.src.width;
  const h = it.src.height;
  const keep = 16;
  return {
    top: Math.max(0, Math.min(t.top, h - keep - t.bottom)),
    bottom: Math.max(0, Math.min(t.bottom, h - keep - t.top)),
    left: Math.max(0, Math.min(t.left, w - keep - t.right)),
    right: Math.max(0, Math.min(t.right, w - keep - t.left)),
  };
}
