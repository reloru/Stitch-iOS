import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ADJUST_DEFAULTS, ADJUST_UI, FILTERS, LOOK_DEFAULT, type Adjust, type Look } from '../core/adjust';
import { canvasToBlob, downscale, releaseCanvas } from '../core/canvas';
import {
  BLEND_MODES,
  FONTS,
  docMasks,
  flipH,
  flipV,
  moveLayer,
  newImageLayer,
  newTextLayer,
  outputSize,
  removeLayer,
  resetGeometry,
  rotateCCW,
  rotateCW,
  setAngle,
  setAspect,
  setLayerCrop,
  updateLayer,
  type Doc,
  type ImageLayer,
  type Layer,
  type TextLayer,
} from '../core/doc';
import { renderAdjusted } from '../core/gl';
import { History } from '../core/history';
import { cloneMask, createMask, fillMask, invertMask, readAlpha, touch, writeAlpha, type Mask } from '../core/mask';
import { disposeSource, loadSource, uid, type SourceImage } from '../core/source';
import { Busy, Sheet, Slider, toast, usePicker } from '../ui/common';
import { ExportSheet } from '../ui/ExportSheet';
import { removeBackground } from '../core/removebg';
import { flattenDoc } from '../core/export';
import { CropSheet } from './CropSheet';
import {
  IcAdjust,
  IcBack,
  IcBrush,
  IcCopy,
  IcCrop,
  IcDown,
  IcEye,
  IcFilter,
  IcFlipH,
  IcFlipV,
  IcGradient,
  IcInvert,
  IcLayers,
  IcCheck,
  IcClose,
  IcMask,
  IcMerge,
  IcPhoto,
  IcRadial,
  IcRedo,
  IcRotate,
  IcShare,
  IcText,
  IcTrash,
  IcUndo,
  IcUp,
  IcWand,
} from '../ui/icons';
import { EditorView, MASK_DEFAULTS, type MaskSettings, type Tool } from './view';

const maskIO = { read: readAlpha, write: writeAlpha };
const BG_NOTICE_KEY = 'stitch.removebg.notice';

const ASPECTS: { name: string; v: number | null | 'orig' }[] = [
  { name: 'Free', v: null },
  { name: 'Original', v: 'orig' },
  { name: 'Square', v: 1 },
  { name: '4:5', v: 4 / 5 },
  { name: '3:4', v: 3 / 4 },
  { name: '9:16', v: 9 / 16 },
  { name: '16:9', v: 16 / 9 },
  { name: '3:2', v: 3 / 2 },
  { name: '2:3', v: 2 / 3 },
];

const TOOLS: { id: Tool; name: string; Icon: typeof IcAdjust }[] = [
  { id: 'adjust', name: 'Adjust', Icon: IcAdjust },
  { id: 'filters', name: 'Filters', Icon: IcFilter },
  { id: 'crop', name: 'Crop', Icon: IcCrop },
  { id: 'layers', name: 'Overlay', Icon: IcLayers },
  { id: 'mask', name: 'Mask', Icon: IcMask },
];

interface Target {
  id: string;
  name: string;
  src: SourceImage;
  adjust: Adjust;
  look: Look;
}

function targetOf(doc: Doc, selected: string): Target | null {
  if (selected === 'base') return { id: 'base', name: 'Photo', src: doc.base.src, adjust: doc.base.adjust, look: doc.base.look };
  const l = doc.layers.find((x) => x.id === selected);
  if (!l || l.kind !== 'image') return null;
  return { id: l.id, name: l.name, src: l.src, adjust: l.adjust, look: l.look };
}

function patchTarget(doc: Doc, id: string, patch: { adjust?: Adjust; look?: Look }): Doc {
  if (id === 'base') return { ...doc, base: { ...doc.base, ...patch } };
  return updateLayer(doc, id, patch);
}

export function Editor(props: { initial: Doc; onClose: () => void }) {
  const [doc, setDocState] = useState<Doc>(props.initial);
  const docRef = useRef(doc);
  const hist = useMemo(() => new History<Doc, Mask>(props.initial, docMasks, maskIO), []);
  const [, setTick] = useState(0);
  const [tool, setTool] = useState<Tool>('adjust');
  const [selected, setSelected] = useState('base');
  const [mask, setMask] = useState<MaskSettings>(MASK_DEFAULTS);
  const [aspect, setAspectLock] = useState<number | null>(null);
  const [compare, setCompare] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [editingText, setEditingText] = useState<string | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [bgConfirm, setBgConfirm] = useState<string | null>(null);
  const [cropping, setCropping] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const ownedSources = useRef(new Set<SourceImage>([props.initial.base.src]));
  /** documents produced by ✓ Apply (plus the photo as opened): ✗ Discard returns to the latest of these */
  const checkpoints = useRef(new Set<Doc>([props.initial]));

  const sel = doc.layers.some((l) => l.id === selected) ? selected : 'base';

  const change = (next: Doc, commit: boolean) => {
    docRef.current = next;
    setDocState(next);
    if (commit) {
      hist.commit(next);
      setTick((t) => t + 1);
    }
  };
  const restore = (d: Doc | null) => {
    if (!d) return;
    docRef.current = d;
    setDocState(d);
    viewRef.current?.maskChanged();
    setTick((t) => t + 1);
  };

  const cbRef = useRef({
    change,
    select: (id: string) => setSelected(id),
    revert: () => restore(hist.revert()),
    editText: (id: string) => setEditingText(id),
    notify: (m: string) => toast(m),
  });
  cbRef.current.change = change;

  useEffect(() => {
    const cb = {
      change: (d: Doc, c: boolean) => cbRef.current.change(d, c),
      select: (id: string) => cbRef.current.select(id),
      revert: () => cbRef.current.revert(),
      editText: (id: string) => cbRef.current.editText(id),
      notify: (m: string) => cbRef.current.notify(m),
    };
    const v = new EditorView(hostRef.current!, { doc, tool, selected: sel, mask, aspect, compare }, cb);
    viewRef.current = v;
    return () => {
      v.destroy();
      for (const s of ownedSources.current) disposeSource(s);
    };
  }, []);

  useEffect(() => {
    viewRef.current?.update({ doc, tool, selected: sel, mask, aspect, compare });
  }, [doc, tool, sel, mask, aspect, compare]);

  const addPhoto = usePicker(async (files) => {
    setBusy('Opening photo…');
    try {
      const src = await loadSource(files[0], files[0].name.replace(/\.[^.]+$/, ''));
      ownedSources.current.add(src);
      const d = docRef.current;
      const layer = newImageLayer(d, src);
      change({ ...d, layers: [...d.layers, layer] }, true);
      setSelected(layer.id);
      setTool('layers');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, false, 'pick-layer');

  const target = targetOf(doc, sel);
  const selLayer = doc.layers.find((l) => l.id === sel) ?? null;

  const hint = (() => {
    if (tool === 'crop') return 'Drag edges to crop · drag inside to move · pinch to zoom';
    if (tool === 'layers') return doc.layers.length ? 'Drag to move · pinch or use the handle to resize and rotate' : 'Add a photo or text overlay below';
    if (tool === 'mask') {
      if (mask.tool === 'brush') return `Paint to ${mask.mode === 'hide' ? 'hide' : 'reveal'} · two fingers to zoom`;
      if (mask.tool === 'linear') return 'Drag: kept at the start, faded out at the end';
      if (mask.tool === 'radial') return `Drag from the centre outward to ${mask.mode === 'hide' ? 'hide inside' : 'keep inside'}`;
      return `Tap a colour to ${mask.mode === 'hide' ? 'hide' : 'keep only'} it`;
    }
    return null;
  })();

  const changed = hist.canUndo;
  const dirty = !checkpoints.current.has(doc);

  const doRemoveBg = async (id: string) => {
    const d = docRef.current;
    const layer = d.layers.find((l): l is ImageLayer => l.id === id && l.kind === 'image');
    if (id !== 'base' && !layer) return;
    const src = layer ? layer.src : d.base.src;
    const existing = layer ? layer.mask : d.base.mask;
    setBusy('Removing background…');
    try {
      const m = await removeBackground(src, existing);
      const cur = docRef.current;
      const next = layer ? updateLayer(cur, id, { mask: m }) : { ...cur, base: { ...cur.base, mask: m } };
      viewRef.current?.maskChanged();
      change(next, true);
      toast('Background removed. Use the Mask tools to touch it up.');
    } catch (e) {
      toast((e as Error).message, 4000);
    } finally {
      setBusy(null);
    }
  };
  /**
   * ✓ Apply: bakes everything so far into a new single photo; tools reset and new edits stack on top.
   * The previous state stays in history, so Undo still steps back through it.
   */
  const apply = async (opts: { toAdjust?: boolean } = {}) => {
    if (!dirty) return;
    setBusy(docRef.current.layers.length ? 'Merging into one photo…' : 'Applying…');
    try {
      const r = await flattenDoc(docRef.current);
      ownedSources.current.add(r.src);
      checkpoints.current.add(r.doc);
      change(r.doc, true);
      setSelected('base');
      setAspectLock(null);
      if (opts.toAdjust) setTool('adjust');
      toast(
        r.limited
          ? 'Applied (reduced to the largest size this phone can edit). New edits stack on top.'
          : 'Applied. New edits stack on top; Undo steps back.',
        3000,
      );
    } catch (e) {
      toast(`Couldn't apply: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  const merge = () => apply({ toAdjust: true });

  /** ✗ Discard: steps back through history to the last applied state (or the photo as opened). */
  const discard = () => {
    let d: Doc | null = hist.current;
    while (!checkpoints.current.has(hist.current) && hist.canUndo) d = hist.undo();
    restore(d ?? hist.current);
  };

  const requestRemoveBg = (id: string) => {
    let ok = false;
    try {
      ok = localStorage.getItem(BG_NOTICE_KEY) === '1';
    } catch {
      /* storage unavailable: ask every time */
    }
    if (ok) void doRemoveBg(id);
    else setBgConfirm(id);
  };

  return (
    <>
      <div class="topbar">
        <button class="tb-btn" aria-label="Back" onClick={() => (changed ? setConfirmLeave(true) : props.onClose())}>
          <IcBack />
        </button>
        <div class="title">
          {(() => {
            const s = outputSize(doc);
            return `${s.w} × ${s.h}`;
          })()}
        </div>
        <button class="tb-btn primary" onClick={() => setExporting(true)}>
          <IcShare /> Save
        </button>
      </div>

      <div class="topbar-space" />
      <div class="stage" ref={hostRef}>
        {hint && <div class="hint">{hint}</div>}
      </div>
      <div class="editbar">
        <button class="tb-btn" aria-label="Undo" disabled={!hist.canUndo} onClick={() => restore(hist.undo())}>
          <IcUndo />
        </button>
        <button class="tb-btn" aria-label="Redo" disabled={!hist.canRedo} onClick={() => restore(hist.redo())}>
          <IcRedo />
        </button>
        <span class="spacer" />
        {(tool === 'adjust' || tool === 'filters') && (
          <button
            class="tb-btn"
            aria-label="Hold to compare with original"
            onPointerDown={() => setCompare(true)}
            onPointerUp={() => setCompare(false)}
            onPointerCancel={() => setCompare(false)}
            onPointerLeave={() => setCompare(false)}
          >
            <IcEye />
          </button>
        )}
        <button class="tb-btn" aria-label="Discard changes" disabled={!dirty} onClick={discard} data-testid="discard">
          <IcClose />
        </button>
        <button class="tb-btn apply" aria-label="Apply changes" disabled={!dirty} onClick={() => void apply()} data-testid="apply">
          <IcCheck />
        </button>
      </div>

      <div class="dock">
        <div class="panel">
          {(tool === 'adjust' || tool === 'filters') && doc.layers.length > 0 && <MergeHint merge={merge} />}
          {tool === 'adjust' && <AdjustPanel doc={doc} target={target} change={change} />}
          {tool === 'filters' && <FiltersPanel doc={doc} target={target} change={change} />}
          {tool === 'crop' && <CropPanel doc={doc} aspect={aspect} setAspect={setAspectLock} change={change} />}
          {tool === 'layers' && (
            <LayersPanel
              doc={doc}
              selected={sel}
              select={setSelected}
              change={change}
              addPhoto={addPhoto.open}
              addText={() => {
                const t = newTextLayer(docRef.current);
                change({ ...docRef.current, layers: [...docRef.current.layers, t] }, true);
                setSelected(t.id);
                setEditingText(t.id);
              }}
              editText={setEditingText}
              removeBg={requestRemoveBg}
              crop={setCropping}
              merge={merge}
            />
          )}
          {tool === 'mask' && (
            <MaskPanel
              doc={doc}
              selected={sel}
              select={setSelected}
              settings={mask}
              setSettings={setMask}
              change={change}
              maskChanged={() => viewRef.current?.maskChanged()}
              removeBg={requestRemoveBg}
            />
          )}
        </div>
        <div class="tabs" role="tablist">
          {TOOLS.map(({ id, name, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tool === id}
              class={'tab' + (tool === id ? ' on' : '')}
              onClick={() => {
                setTool(id);
                if ((id === 'adjust' || id === 'filters' || id === 'mask') && selLayer && selLayer.kind === 'text') setSelected('base');
              }}
            >
              <Icon />
              {name}
            </button>
          ))}
        </div>
      </div>
      {addPhoto.input}

      {exporting && <ExportSheet doc={doc} onClose={() => setExporting(false)} />}
      {editingText && (
        <TextSheet
          layer={doc.layers.find((l) => l.id === editingText) as TextLayer | undefined}
          onChange={(patch, commit) => change(updateLayer(docRef.current, editingText, patch), commit)}
          onClose={() => {
            change(docRef.current, true);
            setEditingText(null);
          }}
        />
      )}
      {bgConfirm && (
        <Sheet title="Remove background" onClose={() => setBgConfirm(null)}>
          <p class="note">
            This sends this photo to Cloudflare, which finds the subject and returns a cut-out. Stitch doesn’t store it. Everything
            else in Stitch stays on your phone. Needs an internet connection.
          </p>
          <div class="actions">
            <button class="btn" onClick={() => setBgConfirm(null)}>
              Cancel
            </button>
            <button
              class="btn primary"
              data-testid="removebg-confirm"
              onClick={() => {
                try {
                  localStorage.setItem(BG_NOTICE_KEY, '1');
                } catch {
                  /* ignore */
                }
                const id = bgConfirm;
                setBgConfirm(null);
                void doRemoveBg(id);
              }}
            >
              Continue
            </button>
          </div>
        </Sheet>
      )}
      {cropping && (doc.layers.find((l) => l.id === cropping)?.kind === 'image') && (
        <CropSheet
          layer={doc.layers.find((l) => l.id === cropping) as ImageLayer}
          onClose={() => setCropping(null)}
          onDone={(r) => {
            change(setLayerCrop(docRef.current, cropping, r), true);
            setCropping(null);
          }}
        />
      )}
      {confirmLeave && (
        <Sheet title="Leave the editor?" onClose={() => setConfirmLeave(false)}>
          <p class="note">Your edits are not saved anywhere until you tap Save. Leaving discards them.</p>
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

// ---------------------------------------------------------------------------

function MergeHint(props: { merge: () => void }) {
  return (
    <div class="row">
      <span class="label" style={{ flex: 1 }}>
        This edits one layer. Merge (or ✓) to edit the whole picture.
      </span>
      <button class="btn" onClick={props.merge} data-testid="merge-hint">
        <IcMerge /> Merge layers
      </button>
    </div>
  );
}

function TargetLabel(props: { target: Target | null }) {
  return (
    <div class="row">
      <span class="label">{props.target ? `Editing: ${props.target.name}` : 'Select a photo layer to adjust it'}</span>
    </div>
  );
}

function AdjustPanel(props: { doc: Doc; target: Target | null; change: (d: Doc, c: boolean) => void }) {
  const { doc, target, change } = props;
  return (
    <div>
      <TargetLabel target={target} />
      {target &&
        ADJUST_UI.map((a) => (
          <Slider
            key={a.key}
            name={a.name}
            min={a.min}
            max={a.max}
            value={target.adjust[a.key]}
            onInput={(v) => change(patchTarget(doc, target.id, { adjust: { ...target.adjust, [a.key]: v } }), false)}
            onCommit={(v) => change(patchTarget(doc, target.id, { adjust: { ...target.adjust, [a.key]: v } }), true)}
          />
        ))}
      <Slider
        name="Vignette"
        min={0}
        max={100}
        value={doc.vignette}
        onInput={(v) => change({ ...doc, vignette: v }, false)}
        onCommit={(v) => change({ ...doc, vignette: v }, true)}
      />
      {target && (
        <div class="row">
          <button class="btn" onClick={() => change(patchTarget(doc, target.id, { adjust: { ...ADJUST_DEFAULTS } }), true)}>
            Reset adjustments
          </button>
        </div>
      )}
    </div>
  );
}

function FiltersPanel(props: { doc: Doc; target: Target | null; change: (d: Doc, c: boolean) => void }) {
  const { doc, target, change } = props;
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const srcId = target?.src.id;
  const adjKey = target ? JSON.stringify(target.adjust) : '';
  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    (async () => {
      const p = target.src.proxy;
      const k = 96 / Math.min(p.width, p.height);
      const small = downscale(p, p.width, p.height, p.width * k, p.height * k);
      const out: Record<string, string> = {};
      for (const f of FILTERS) {
        const c = renderAdjusted(small, target.adjust, { filter: f.id, strength: 100 });
        out[f.id] = URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.8));
        releaseCanvas(c);
        if (cancelled) break;
      }
      releaseCanvas(small);
      if (!cancelled) setThumbs(out);
      else Object.values(out).forEach((u) => URL.revokeObjectURL(u));
    })();
    return () => {
      cancelled = true;
    };
  }, [srcId, adjKey]);
  useEffect(() => () => Object.values(thumbs).forEach((u) => URL.revokeObjectURL(u)), [thumbs]);

  if (!target) return <TargetLabel target={null} />;
  return (
    <div>
      <TargetLabel target={target} />
      <div class="thumbs">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            class={'thumb' + (target.look.filter === f.id ? ' on' : '')}
            onClick={() => change(patchTarget(doc, target.id, { look: { filter: f.id, strength: target.look.filter === f.id ? target.look.strength : 100 } }), true)}
          >
            {thumbs[f.id] ? <img src={thumbs[f.id]} alt="" /> : <canvas width={1} height={1} />}
            {f.name}
          </button>
        ))}
      </div>
      {target.look.filter !== 'none' && (
        <Slider
          name="Strength"
          min={0}
          max={100}
          neutral={100}
          value={target.look.strength}
          onInput={(v) => change(patchTarget(doc, target.id, { look: { ...target.look, strength: v } }), false)}
          onCommit={(v) => change(patchTarget(doc, target.id, { look: { ...target.look, strength: v } }), true)}
        />
      )}
      {target.look.filter !== 'none' && (
        <div class="row">
          <button class="btn" onClick={() => change(patchTarget(doc, target.id, { look: { ...LOOK_DEFAULT } }), true)}>
            Remove filter
          </button>
        </div>
      )}
    </div>
  );
}

function CropPanel(props: {
  doc: Doc;
  aspect: number | null;
  setAspect: (a: number | null) => void;
  change: (d: Doc, c: boolean) => void;
}) {
  const { doc, change } = props;
  const g = doc.geo;
  const origAspect = g.worldW / g.worldH;
  return (
    <div>
      <Slider
        name="Straighten"
        min={-45}
        max={45}
        step={0.5}
        value={g.angle}
        format={(v) => `${v.toFixed(1)}°`}
        onInput={(v) => change(setAngle(doc, v), false)}
        onCommit={(v) => change(setAngle(doc, v), true)}
      />
      <div class="row scroll">
        {ASPECTS.map((a) => {
          const v = a.v === 'orig' ? origAspect : a.v;
          const on = a.v === null ? props.aspect === null : props.aspect !== null && v !== null && Math.abs(props.aspect - v) < 1e-6;
          return (
            <button
              key={a.name}
              class={'chip' + (on ? ' on' : '')}
              onClick={() => {
                props.setAspect(v);
                if (v !== null) change(setAspect(doc, v), true);
              }}
            >
              {a.name}
            </button>
          );
        })}
      </div>
      <div class="row">
        <button class="icon-btn" aria-label="Rotate left" onClick={() => change(rotateCCW(doc), true)}>
          <IcRotate style={{ transform: 'scaleX(-1)' }} />
        </button>
        <button class="icon-btn" aria-label="Rotate right" onClick={() => change(rotateCW(doc), true)}>
          <IcRotate />
        </button>
        <button class="icon-btn" aria-label="Flip horizontal" onClick={() => change(flipH(doc), true)}>
          <IcFlipH />
        </button>
        <button class="icon-btn" aria-label="Flip vertical" onClick={() => change(flipV(doc), true)}>
          <IcFlipV />
        </button>
        <span class="spacer" />
        <button
          class="btn"
          onClick={() => {
            props.setAspect(null);
            change(resetGeometry(doc), true);
          }}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

function LayerThumb(props: { layer: Layer | null; doc: Doc }) {
  const l = props.layer;
  if (!l) return <span class="lt" style={{ backgroundImage: `url(${props.doc.base.src.thumbUrl})` }} />;
  if (l.kind === 'image') return <span class="lt" style={{ backgroundImage: `url(${l.src.thumbUrl})` }} />;
  return (
    <span class="lt" style={{ background: l.bg ?? '#333', color: l.color }}>
      T
    </span>
  );
}

function LayersPanel(props: {
  doc: Doc;
  selected: string;
  select: (id: string) => void;
  change: (d: Doc, c: boolean) => void;
  addPhoto: () => void;
  addText: () => void;
  editText: (id: string) => void;
  removeBg: (id: string) => void;
  crop: (id: string) => void;
  merge: () => void;
}) {
  const { doc, selected, change } = props;
  const l = doc.layers.find((x) => x.id === selected) ?? null;
  const set = (patch: Partial<ImageLayer> | Partial<TextLayer>, commit: boolean) => change(updateLayer(doc, selected, patch), commit);
  return (
    <div>
      <div class="layers">
        <button class="btn primary" onClick={props.addPhoto} data-testid="add-photo-layer">
          <IcPhoto /> Photo
        </button>
        <button class="btn" onClick={props.addText} data-testid="add-text-layer">
          <IcText /> Text
        </button>
        {doc.layers.length > 0 && (
          <button class="btn" onClick={props.merge} data-testid="merge-layers">
            <IcMerge /> Merge
          </button>
        )}
        {[...doc.layers].reverse().map((x) => (
          <button key={x.id} class={'layer-chip' + (x.id === selected ? ' on' : '')} onClick={() => props.select(x.id)}>
            <LayerThumb layer={x} doc={doc} />
            <span class="ln">{x.kind === 'text' ? x.text.split('\n')[0] || 'Text' : x.name}</span>
          </button>
        ))}
        <button class={'layer-chip' + (selected === 'base' ? ' on' : '')} onClick={() => props.select('base')}>
          <LayerThumb layer={null} doc={doc} />
          <span class="ln">Background</span>
        </button>
      </div>

      {!l && (
        <div class="row wrap">
          <span class="label">Behind transparent areas:</span>
          {[
            ['None', null],
            ['White', '#ffffff'],
            ['Black', '#000000'],
          ].map(([name, v]) => (
            <button key={name as string} class={'chip' + (doc.background === v ? ' on' : '')} onClick={() => change({ ...doc, background: v as string | null }, true)}>
              {name}
            </button>
          ))}
        </div>
      )}

      {l && (
        <>
          {l.kind === 'image' && (
            <div class="row">
              <button class="btn primary" onClick={() => props.removeBg(l.id)} data-testid="layer-removebg">
                <IcWand /> Remove background
              </button>
              <button class="btn" onClick={() => props.crop(l.id)} data-testid="layer-crop">
                <IcCrop /> Crop{l.crop ? ' ·' : ''}
              </button>
            </div>
          )}
          <Slider
            name="Opacity"
            min={0}
            max={100}
            neutral={100}
            value={Math.round(l.opacity * 100)}
            onInput={(v) => set({ opacity: v / 100 }, false)}
            onCommit={(v) => set({ opacity: v / 100 }, true)}
          />
          <div class="row scroll">
            {BLEND_MODES.map((b) => (
              <button key={b.id} class={'chip' + (l.blend === b.id ? ' on' : '')} onClick={() => set({ blend: b.id }, true)}>
                {b.name}
              </button>
            ))}
          </div>
          {l.kind === 'text' && <TextStyleRow layer={l} set={set} edit={() => props.editText(l.id)} />}
          <div class="row">
            <button class="icon-btn" aria-label="Bring forward" onClick={() => change(moveLayer(doc, l.id, 1), true)}>
              <IcUp />
            </button>
            <button class="icon-btn" aria-label="Send backward" onClick={() => change(moveLayer(doc, l.id, -1), true)}>
              <IcDown />
            </button>
            <button class="icon-btn" aria-label="Mirror" onClick={() => set({ t: { ...l.t, flipX: !l.t.flipX } }, true)}>
              <IcFlipH />
            </button>
            <button
              class="icon-btn"
              aria-label="Duplicate"
              onClick={() => {
                const copy = {
                  ...l,
                  id: uid('layer'),
                  t: { ...l.t, x: l.t.x + doc.geo.crop.w * 0.04, y: l.t.y + doc.geo.crop.h * 0.04 },
                } as Layer;
                if (copy.kind === 'image' && copy.mask) copy.mask = cloneMask(copy.mask);
                change({ ...doc, layers: [...doc.layers, copy] }, true);
                props.select(copy.id);
              }}
            >
              <IcCopy />
            </button>
            <span class="spacer" />
            <button
              class="icon-btn"
              aria-label="Delete layer"
              style={{ color: 'var(--danger)' }}
              onClick={() => {
                change(removeLayer(doc, l.id), true);
                props.select('base');
              }}
            >
              <IcTrash />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

const SWATCHES = ['#ffffff', '#000000', '#ffb35c', '#ff5e7a', '#5ce1e6', '#5b7cff', '#7ee081', '#ffe066'];

function TextStyleRow(props: { layer: TextLayer; set: (p: Partial<TextLayer>, c: boolean) => void; edit: () => void }) {
  const { layer: l, set } = props;
  return (
    <>
      <div class="row scroll">
        <button class="btn" onClick={props.edit}>
          <IcText /> Edit text
        </button>
        {FONTS.map((f) => (
          <button key={f.id} class={'chip' + (l.font === f.id ? ' on' : '')} style={{ fontFamily: f.css }} onClick={() => set({ font: f.id }, true)}>
            {f.name}
          </button>
        ))}
      </div>
      <div class="row scroll">
        {SWATCHES.map((c) => (
          <button
            key={c}
            aria-label={`Text colour ${c}`}
            class={'icon-btn' + (l.color === c ? ' on' : '')}
            style={{ background: c }}
            onClick={() => set({ color: c }, true)}
          />
        ))}
        <input type="color" value={l.color} aria-label="Custom colour" onInput={(e) => set({ color: (e.target as HTMLInputElement).value }, false)} onChange={() => set({}, true)} />
      </div>
      <div class="row scroll">
        <button class={'chip' + (l.bold ? ' on' : '')} onClick={() => set({ bold: !l.bold }, true)}>
          Bold
        </button>
        <button class={'chip' + (l.shadow ? ' on' : '')} onClick={() => set({ shadow: !l.shadow }, true)}>
          Shadow
        </button>
        <button class={'chip' + (l.bg ? ' on' : '')} onClick={() => set({ bg: l.bg ? null : l.color === '#000000' ? '#ffffff' : '#000000' }, true)}>
          Box
        </button>
        {(['left', 'center', 'right'] as CanvasTextAlign[]).map((a) => (
          <button key={a} class={'chip' + (l.align === a ? ' on' : '')} onClick={() => set({ align: a }, true)}>
            {a[0].toUpperCase() + a.slice(1)}
          </button>
        ))}
      </div>
    </>
  );
}

function TextSheet(props: { layer: TextLayer | undefined; onChange: (p: Partial<TextLayer>, commit: boolean) => void; onClose: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  if (!props.layer) return null;
  return (
    <Sheet title="Text" onClose={props.onClose}>
      <textarea
        ref={ref}
        rows={3}
        value={props.layer.text}
        data-testid="text-input"
        onInput={(e) => props.onChange({ text: (e.target as HTMLTextAreaElement).value }, false)}
      />
      <div class="actions">
        <button class="btn primary" onClick={props.onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

function MaskPanel(props: {
  doc: Doc;
  selected: string;
  select: (id: string) => void;
  settings: MaskSettings;
  setSettings: (m: MaskSettings) => void;
  change: (d: Doc, c: boolean) => void;
  maskChanged: () => void;
  removeBg: (id: string) => void;
}) {
  const { doc, settings: ms, setSettings } = props;
  const set = (p: Partial<MaskSettings>) => setSettings({ ...ms, ...p });
  const photoLayers = doc.layers.filter((l): l is ImageLayer => l.kind === 'image');
  const curMask = props.selected === 'base' ? doc.base.mask : photoLayers.find((l) => l.id === props.selected)?.mask ?? null;
  const targetSrc = props.selected === 'base' ? doc.base.src : photoLayers.find((l) => l.id === props.selected)?.src ?? null;
  const op = (fn: (m: Mask) => void) => {
    if (!targetSrc) return;
    let m = curMask;
    let d = doc;
    if (!m) {
      m = createMask(targetSrc.width, targetSrc.height);
      d = props.selected === 'base' ? { ...doc, base: { ...doc.base, mask: m } } : updateLayer(doc, props.selected, { mask: m });
    }
    fn(m);
    touch(m);
    props.maskChanged();
    props.change({ ...d }, true);
  };
  const removeMask = () => {
    const d = props.selected === 'base' ? { ...doc, base: { ...doc.base, mask: null } } : updateLayer(doc, props.selected, { mask: null });
    props.change(d, true);
  };
  return (
    <div>
      <div class="layers">
        {[...photoLayers].reverse().map((x) => (
          <button key={x.id} class={'layer-chip' + (x.id === props.selected ? ' on' : '')} onClick={() => props.select(x.id)}>
            <LayerThumb layer={x} doc={doc} />
            <span class="ln">{x.name}</span>
          </button>
        ))}
        <button class={'layer-chip' + (props.selected === 'base' ? ' on' : '')} onClick={() => props.select('base')}>
          <LayerThumb layer={null} doc={doc} />
          <span class="ln">Background</span>
        </button>
      </div>
      <div class="row">
        {(
          [
            ['brush', 'Brush', IcBrush],
            ['linear', 'Linear', IcGradient],
            ['radial', 'Radial', IcRadial],
            ['wand', 'Color', IcWand],
          ] as const
        ).map(([id, name, Icon]) => (
          <button key={id} class={'chip' + (ms.tool === id ? ' on' : '')} onClick={() => set({ tool: id })} aria-label={name}>
            <Icon style={{ width: 16, height: 16, verticalAlign: '-3px' }} /> {name}
          </button>
        ))}
      </div>
      {ms.tool !== 'linear' && (
        <div class="row">
          <button class={'chip' + (ms.mode === 'hide' ? ' on' : '')} onClick={() => set({ mode: 'hide' })}>
            {ms.tool === 'wand' ? 'Hide colour' : ms.tool === 'radial' ? 'Hide inside' : 'Hide'}
          </button>
          <button class={'chip' + (ms.mode === 'reveal' ? ' on' : '')} onClick={() => set({ mode: 'reveal' })}>
            {ms.tool === 'wand' ? 'Keep colour' : ms.tool === 'radial' ? 'Keep inside' : 'Reveal'}
          </button>
          <span class="spacer" />
          <button class={'icon-btn' + (ms.show ? ' on' : '')} aria-label="Show mask overlay" onClick={() => set({ show: !ms.show })}>
            <IcEye />
          </button>
        </div>
      )}
      {ms.tool === 'brush' && (
        <>
          <Slider name="Size" min={4} max={120} neutral={28} value={ms.size} onInput={(v) => set({ size: v })} onCommit={(v) => set({ size: v })} />
          <Slider
            name="Hardness"
            min={0}
            max={100}
            neutral={50}
            value={Math.round(ms.hardness * 100)}
            onInput={(v) => set({ hardness: v / 100 })}
            onCommit={(v) => set({ hardness: v / 100 })}
          />
          <Slider name="Flow" min={5} max={100} neutral={90} value={Math.round(ms.flow * 100)} onInput={(v) => set({ flow: v / 100 })} onCommit={(v) => set({ flow: v / 100 })} />
        </>
      )}
      {ms.tool === 'radial' && (
        <Slider
          name="Feather"
          min={0}
          max={100}
          neutral={50}
          value={Math.round(ms.feather * 100)}
          onInput={(v) => set({ feather: v / 100 })}
          onCommit={(v) => set({ feather: v / 100 })}
        />
      )}
      {ms.tool === 'wand' && (
        <>
          <Slider name="Tolerance" min={1} max={120} neutral={32} value={ms.tolerance} onInput={(v) => set({ tolerance: v })} onCommit={(v) => set({ tolerance: v })} />
          <div class="row">
            <button class={'chip' + (ms.contiguous ? ' on' : '')} onClick={() => set({ contiguous: !ms.contiguous })}>
              Connected area only
            </button>
          </div>
        </>
      )}
      <div class="row scroll">
        <button class="btn primary" disabled={!targetSrc} onClick={() => props.removeBg(props.selected)}>
          <IcWand /> Remove background
        </button>
        <button class="btn" disabled={!targetSrc} onClick={() => op(invertMask)}>
          <IcInvert /> Invert
        </button>
        <button class="btn" disabled={!targetSrc} onClick={() => op((m) => fillMask(m, true))}>
          Show all
        </button>
        <button class="btn" disabled={!targetSrc} onClick={() => op((m) => fillMask(m, false))}>
          Hide all
        </button>
        <button class="btn danger" disabled={!curMask} onClick={removeMask}>
          <IcTrash /> Remove mask
        </button>
      </div>
    </div>
  );
}
