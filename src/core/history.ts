/**
 * Undo/redo for immutable documents whose masks are mutable bitmaps.
 * Each entry keeps the document object plus the alpha bytes of every mask it references. Mask bytes are
 * shared between entries while a mask's version is unchanged, so memory only grows with mask edits.
 */

export interface MaskLike {
  id: string;
  version: number;
}

export interface MaskIO<M extends MaskLike> {
  read(m: M): Uint8Array;
  write(m: M, alpha: Uint8Array): void;
}

interface MaskSnap<M> {
  mask: M;
  version: number;
  alpha: Uint8Array;
}

interface Entry<D, M> {
  doc: D;
  masks: MaskSnap<M>[];
}

export class History<D, M extends MaskLike> {
  private undoStack: Entry<D, M>[] = [];
  private redoStack: Entry<D, M>[] = [];
  private committed: Entry<D, M>;
  /** entries dropped from the bottom of the undo stack (keeps `position` stable across trims) */
  private dropped = 0;

  constructor(
    doc: D,
    private masksOf: (d: D) => M[],
    private io: MaskIO<M>,
    private limit = 40,
    private byteBudget = 160 * 1024 * 1024,
  ) {
    this.committed = this.snap(doc, null);
  }

  private snap(doc: D, prev: Entry<D, M> | null): Entry<D, M> {
    const masks = this.masksOf(doc).map((m) => {
      const old = prev?.masks.find((s) => s.mask === m && s.version === m.version);
      return old ?? { mask: m, version: m.version, alpha: this.io.read(m) };
    });
    return { doc, masks };
  }

  private restore(e: Entry<D, M>) {
    for (const s of e.masks) {
      if (s.mask.version !== s.version) {
        this.io.write(s.mask, s.alpha);
        s.mask.version = s.version;
      }
    }
  }

  private trim() {
    while (this.undoStack.length > this.limit) {
      this.undoStack.shift();
      this.dropped++;
    }
    const all = [...this.undoStack, this.committed, ...this.redoStack];
    const seen = new Set<Uint8Array>();
    let bytes = 0;
    for (const e of all) for (const s of e.masks) if (!seen.has(s.alpha)) (seen.add(s.alpha), (bytes += s.alpha.byteLength));
    while (bytes > this.byteBudget && this.undoStack.length > 0) {
      const dropped = this.undoStack.shift()!;
      this.dropped++;
      const stillUsed = new Set<Uint8Array>();
      for (const e of [...this.undoStack, this.committed, ...this.redoStack]) for (const s of e.masks) stillUsed.add(s.alpha);
      for (const s of dropped.masks) if (!stillUsed.has(s.alpha) && seen.has(s.alpha)) (seen.delete(s.alpha), (bytes -= s.alpha.byteLength));
    }
  }

  /** Record `doc` as a new undoable state. */
  commit(doc: D) {
    if (doc === this.committed.doc && this.masksOf(doc).every((m) => this.committed.masks.some((s) => s.mask === m && s.version === m.version)))
      return;
    this.undoStack.push(this.committed);
    this.committed = this.snap(doc, this.committed);
    this.redoStack = [];
    this.trim();
  }

  /** The last committed document (what an interrupted, uncommitted change reverts to). */
  get current(): D {
    return this.committed.doc;
  }

  /** Puts masks back to the committed state (e.g. a cancelled stroke) and returns the committed doc. */
  revert(): D {
    this.restore(this.committed);
    return this.committed.doc;
  }

  /**
   * How many commits deep the current state is. Monotonic for a given history line (trimming old entries does not
   * change it), so a tool session can remember where it started and undo back to exactly there.
   */
  get position(): number {
    return this.dropped + this.undoStack.length;
  }

  /** Every document still reachable through undo/redo, plus the current one. */
  docs(): D[] {
    return [...this.undoStack.map((e) => e.doc), this.committed.doc, ...this.redoStack.map((e) => e.doc)];
  }

  get canUndo() {
    return this.undoStack.length > 0;
  }

  get canRedo() {
    return this.redoStack.length > 0;
  }

  undo(): D | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.redoStack.push(this.committed);
    this.committed = e;
    this.restore(e);
    return e.doc;
  }

  redo(): D | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.undoStack.push(this.committed);
    this.committed = e;
    this.restore(e);
    return e.doc;
  }
}
