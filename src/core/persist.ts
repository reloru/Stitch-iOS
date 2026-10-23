/**
 * Autosave of the open edit (editor document or stitch) to IndexedDB, so the work survives iOS closing the app in the
 * background. Only the current state is kept (no undo history). Every function swallows storage errors: editing must
 * never depend on storage.
 *
 * Layout: store `sources` holds each photo's original bytes once (keyed by source id); store `kv` holds one
 * `session` record that refers to them, plus mask pixels and a small thumbnail for the home screen.
 */
import { canvasToBlob, downscale, releaseCanvas } from './canvas';
import type { BaseLayer, Doc, ImageLayer, TextLayer } from './doc';
import { createMask, readAlpha, writeAlpha, type Mask } from './mask';
import { loadSource, type SourceImage } from './source';
import type { StitchSettings, Trim } from './stitch';

const DB = 'stitch-autosave';
const VERSION = 1;

interface SavedSource {
  id: string;
  name: string;
  type: string;
  alpha: boolean;
  data: ArrayBuffer;
}

interface SavedMask {
  w: number;
  h: number;
  alpha: Uint8Array;
}

type SavedLayer = (Omit<ImageLayer, 'src' | 'mask'> & { src: string; mask: SavedMask | null }) | TextLayer;

interface SavedDoc extends Omit<Doc, 'base' | 'layers'> {
  base: Omit<BaseLayer, 'src' | 'mask'> & { src: string; mask: SavedMask | null };
  layers: SavedLayer[];
}

interface SavedStitchItem {
  id: string;
  src: string;
  trim: Trim;
}

type SessionBody = { kind: 'editor'; doc: SavedDoc } | { kind: 'stitch'; items: SavedStitchItem[]; settings: StitchSettings };

type SessionRecord = SessionBody & { savedAt: number; thumb: Blob | null; sources: string[] };

export interface SessionInfo {
  kind: 'editor' | 'stitch';
  savedAt: number;
  thumb: Blob | null;
}

export type RestoredSession =
  | { kind: 'editor'; doc: Doc; sources: SourceImage[] }
  | { kind: 'stitch'; items: { id: string; src: SourceImage; trim: Trim }[]; settings: StitchSettings; sources: SourceImage[] };

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('aborted'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('sources', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    dbPromise.catch(() => (dbPromise = null));
  }
  return dbPromise;
}

function saveMask(m: Mask | null): SavedMask | null {
  return m ? { w: m.canvas.width, h: m.canvas.height, alpha: readAlpha(m) } : null;
}

async function thumbOf(src: SourceImage): Promise<Blob | null> {
  try {
    const p = src.proxy;
    if (!p.width) return null;
    const k = 160 / Math.max(p.width, p.height);
    const c = downscale(p, p.width, p.height, p.width * k, p.height * k);
    try {
      return await canvasToBlob(c, 'image/jpeg', 0.8);
    } finally {
      releaseCanvas(c);
    }
  } catch {
    return null;
  }
}

async function write(body: SessionBody, sources: SourceImage[], thumbFrom: SourceImage | null) {
  const d = await db();
  const unique = [...new Map(sources.map((s) => [s.id, s])).values()];
  // read which photos are already stored, then prepare everything before the write transaction (an IndexedDB
  // transaction closes if it waits on anything else)
  const existing = new Set((await req(d.transaction('sources').objectStore('sources').getAllKeys())) as string[]);
  const add: SavedSource[] = [];
  for (const s of unique)
    if (!existing.has(s.id)) add.push({ id: s.id, name: s.name, type: s.blob.type, alpha: s.alpha, data: await s.blob.arrayBuffer() });
  const record: SessionRecord = { ...body, savedAt: Date.now(), thumb: thumbFrom ? await thumbOf(thumbFrom) : null, sources: unique.map((s) => s.id) };
  const keep = new Set(record.sources);
  const tx = d.transaction(['kv', 'sources'], 'readwrite');
  const store = tx.objectStore('sources');
  for (const a of add) store.put(a);
  for (const k of existing) if (!keep.has(k)) store.delete(k);
  tx.objectStore('kv').put(record, 'session');
  await done(tx);
}

export async function saveEditor(doc: Doc): Promise<void> {
  try {
    const sources = [doc.base.src];
    const layers: SavedLayer[] = doc.layers.map((l) => {
      if (l.kind === 'text') return l;
      sources.push(l.src);
      return { ...l, src: l.src.id, mask: saveMask(l.mask) };
    });
    const saved: SavedDoc = { ...doc, base: { ...doc.base, src: doc.base.src.id, mask: saveMask(doc.base.mask) }, layers };
    await write({ kind: 'editor', doc: saved }, sources, doc.base.src);
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

export async function saveStitch(items: { id: string; src: SourceImage; trim: Trim }[], settings: StitchSettings): Promise<void> {
  try {
    await write(
      { kind: 'stitch', items: items.map((i) => ({ id: i.id, src: i.src.id, trim: i.trim })), settings },
      items.map((i) => i.src),
      items[0]?.src ?? null,
    );
  } catch (e) {
    console.warn('autosave failed', e);
  }
}

async function readRecord(): Promise<SessionRecord | null> {
  const d = await db();
  return ((await req(d.transaction('kv').objectStore('kv').get('session'))) as SessionRecord | undefined) ?? null;
}

export async function sessionInfo(): Promise<SessionInfo | null> {
  try {
    const r = await readRecord();
    return r ? { kind: r.kind, savedAt: r.savedAt, thumb: r.thumb } : null;
  } catch {
    return null;
  }
}

function loadMask(s: SavedMask | null, src: SourceImage): Mask | null {
  if (!s) return null;
  const m = createMask(src.width, src.height);
  if (m.canvas.width === s.w && m.canvas.height === s.h) {
    writeAlpha(m, s.alpha);
    return m;
  }
  // a device with a different canvas limit decoded the photo at another size: scale the saved mask onto it
  const tmp = createMask(1, 1);
  tmp.canvas.width = s.w;
  tmp.canvas.height = s.h;
  writeAlpha(tmp, s.alpha);
  const ctx = m.canvas.getContext('2d')!;
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(tmp.canvas, 0, 0, m.canvas.width, m.canvas.height);
  releaseCanvas(tmp.canvas);
  return m;
}

/** Rebuilds the saved session (decoding its photos). Null if there is none or it cannot be read. */
export async function restoreSession(): Promise<RestoredSession | null> {
  const loaded: SourceImage[] = [];
  try {
    const r = await readRecord();
    if (!r) return null;
    const d = await db();
    const store = d.transaction('sources').objectStore('sources');
    const raw = await Promise.all(r.sources.map((id) => req(store.get(id)) as Promise<SavedSource | undefined>));
    const byId = new Map<string, SourceImage>();
    for (const s of raw) {
      if (!s) throw new Error('A saved photo is missing');
      const src = await loadSource(new Blob([s.data], { type: s.type }), s.name);
      const restored = { ...src, alpha: s.alpha };
      loaded.push(restored);
      byId.set(s.id, restored);
    }
    const get = (id: string) => byId.get(id)!;
    if (r.kind === 'stitch') {
      return { kind: 'stitch', items: r.items.map((i) => ({ id: i.id, src: get(i.src), trim: i.trim })), settings: r.settings, sources: loaded };
    }
    const sd = r.doc;
    const base = get(sd.base.src);
    const doc: Doc = {
      ...sd,
      base: { ...sd.base, src: base, mask: loadMask(sd.base.mask, base) },
      layers: sd.layers.map((l) => {
        if (l.kind === 'text') return l;
        const src = get(l.src);
        return { ...l, src, mask: loadMask(l.mask, src) };
      }),
    };
    return { kind: 'editor', doc, sources: loaded };
  } catch (e) {
    console.warn('restore failed', e);
    for (const s of loaded) releaseCanvas(s.proxy);
    return null;
  }
}

export async function clearSession(): Promise<void> {
  try {
    const d = await db();
    const tx = d.transaction(['kv', 'sources'], 'readwrite');
    tx.objectStore('kv').delete('session');
    tx.objectStore('sources').clear();
    await done(tx);
  } catch (e) {
    console.warn('clearing autosave failed', e);
  }
}

/**
 * Debounced saver: `request()` after each committed change; writes never overlap, and the latest state wins. When the
 * page is hidden (app switch, lock) a pending save starts at once — best effort, since iOS may suspend the page.
 */
export function autosaver(save: () => Promise<void>, delay = 800) {
  let timer = 0;
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  const run = async () => {
    timer = 0;
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = save().finally(() => {
      running = null;
      if (again && !stopped) {
        again = false;
        void run();
      }
    });
  };
  const onHide = () => {
    if (document.visibilityState === 'hidden' && timer) {
      clearTimeout(timer);
      void run();
    }
  };
  document.addEventListener('visibilitychange', onHide);
  return {
    request() {
      if (stopped) return;
      clearTimeout(timer);
      timer = window.setTimeout(run, delay);
    },
    /** stop saving; resolves once any write in progress has finished */
    async stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onHide);
      await running;
    },
  };
}
