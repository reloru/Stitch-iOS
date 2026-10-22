import { describe, it, expect } from 'vitest';
import { History } from '../../src/core/history';

interface FakeMask {
  id: string;
  version: number;
  data: Uint8Array;
}
let v = 1;
const io = {
  read: (m: FakeMask) => m.data.slice(),
  write: (m: FakeMask, a: Uint8Array) => void m.data.set(a),
};
interface D {
  n: number;
  masks: FakeMask[];
}

describe('history', () => {
  it('undoes and redoes document changes', () => {
    const h = new History<D, FakeMask>({ n: 0, masks: [] }, (d) => d.masks, io);
    h.commit({ n: 1, masks: [] });
    h.commit({ n: 2, masks: [] });
    expect(h.undo()?.n).toBe(1);
    expect(h.undo()?.n).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()?.n).toBe(1);
    h.commit({ n: 5, masks: [] });
    expect(h.canRedo).toBe(false);
  });

  it('restores mask pixels and shares unchanged snapshots', () => {
    const m: FakeMask = { id: 'm', version: v++, data: new Uint8Array([255, 255]) };
    const d0 = { n: 0, masks: [m] };
    const h = new History<D, FakeMask>(d0, (d) => d.masks, io);
    // stroke 1
    m.data[0] = 10;
    m.version = v++;
    const d1 = { n: 0, masks: [m] };
    h.commit(d1);
    // stroke 2
    m.data[1] = 20;
    m.version = v++;
    h.commit({ n: 0, masks: [m] });
    h.undo();
    expect([...m.data]).toEqual([10, 255]);
    h.undo();
    expect([...m.data]).toEqual([255, 255]);
    h.redo();
    h.redo();
    expect([...m.data]).toEqual([10, 20]);
  });

  it('revert() discards an uncommitted stroke', () => {
    const m: FakeMask = { id: 'm', version: v++, data: new Uint8Array([1]) };
    const h = new History<D, FakeMask>({ n: 0, masks: [m] }, (d) => d.masks, io);
    m.data[0] = 99;
    m.version = v++;
    h.revert();
    expect(m.data[0]).toBe(1);
  });

  it('drops oldest entries beyond the byte budget', () => {
    const m: FakeMask = { id: 'm', version: v++, data: new Uint8Array(1000) };
    const h = new History<D, FakeMask>({ n: 0, masks: [m] }, (d) => d.masks, io, 100, 3500);
    for (let i = 1; i <= 10; i++) {
      m.data[0] = i;
      m.version = v++;
      h.commit({ n: i, masks: [m] });
    }
    let undos = 0;
    while (h.undo()) undos++;
    expect(undos).toBeLessThan(4);
    expect(undos).toBeGreaterThan(0);
  });
});
