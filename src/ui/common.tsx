import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { IcClose } from './icons';

export function Slider(props: {
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** value shown when unchanged; tapping the value resets to it */
  neutral?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const neutral = props.neutral ?? 0;
  const changed = props.value !== neutral;
  return (
    <div class="slider">
      <span class="name">{props.name}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step ?? 1}
        value={props.value}
        aria-label={props.name}
        onInput={(e) => props.onInput(Number((e.target as HTMLInputElement).value))}
        onChange={(e) => props.onCommit(Number((e.target as HTMLInputElement).value))}
      />
      <button
        class={'val' + (changed ? ' changed' : '')}
        aria-label={`Reset ${props.name}`}
        onClick={() => {
          if (!changed) return;
          props.onInput(neutral);
          props.onCommit(neutral);
        }}
      >
        {props.format ? props.format(props.value) : Math.round(props.value)}
      </button>
    </div>
  );
}

/**
 * Bottom sheet. Sheets that hold work (`keep`) ignore taps outside them and show a close button instead, so a stray
 * tap above the sheet cannot throw the work away. `clear` leaves the picture undimmed (live preview while typing).
 */
export function Sheet(props: { onClose: () => void; children: ComponentChildren; title?: string; keep?: boolean; clear?: boolean }) {
  return (
    <div
      class={'sheet-backdrop' + (props.clear ? ' clear' : '')}
      onClick={(e) => {
        if (!props.keep && e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="sheet" role="dialog" aria-label={props.title}>
        <div class="grab" />
        {(props.title || props.keep) && (
          <div class="sheet-head">
            {props.title && <h3>{props.title}</h3>}
            {props.keep && (
              <button class="tb-btn" aria-label="Close" onClick={props.onClose}>
                <IcClose />
              </button>
            )}
          </div>
        )}
        {props.children}
      </div>
    </div>
  );
}

/**
 * A one-line hint over the picture that gets out of the way: hidden after the first touch on the picture or after a
 * few seconds, and shown again only when its text changes.
 */
export function useHint(text: string | null, ms = 5000) {
  const [gone, setGone] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    const t = window.setTimeout(() => setGone(text), ms);
    return () => clearTimeout(t);
  }, [text]);
  return { visible: !!text && gone !== text, dismiss: () => text && setGone(text) };
}

/** Horizontally scrolling row that fades the edge(s) with more content, so off-screen buttons are discoverable. */
export function Scroller(props: { class?: string; children: ComponentChildren; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState('');
  useLayoutEffect(() => {
    const el = ref.current!;
    const update = () => {
      const l = el.scrollLeft > 2;
      const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setFade(l && r ? ' fade-lr' : l ? ' fade-l' : r ? ' fade-r' : '');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  });
  return (
    <div ref={ref} class={(props.class ?? 'row scroll') + fade} data-testid={props.testId}>
      {props.children}
    </div>
  );
}

/**
 * Keeps `--kb` (CSS px hidden by the on-screen keyboard) up to date. iOS overlays the keyboard on the layout viewport,
 * so fixed bottom sheets use it to stay above the keyboard.
 */
export function trackKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const update = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}

let kbdProxy: HTMLInputElement | null = null;

/**
 * iOS shows the keyboard only for a focus() made while handling the tap itself. Call this synchronously in the tap
 * handler that opens a text field; the field then takes the focus over from this proxy when it mounts.
 */
export function raiseKeyboard() {
  if (!kbdProxy) {
    kbdProxy = document.createElement('input');
    kbdProxy.type = 'text';
    kbdProxy.className = 'kbd-proxy';
    kbdProxy.setAttribute('aria-hidden', 'true');
    kbdProxy.tabIndex = -1;
    document.body.appendChild(kbdProxy);
  }
  kbdProxy.focus({ preventScroll: true });
}

let toastSetter: ((s: string | null) => void) | null = null;
let toastTimer = 0;

export function toast(msg: string, ms = 2600) {
  toastSetter?.(msg);
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastSetter?.(null), ms);
}

export function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSetter = setMsg;
    return () => {
      toastSetter = null;
    };
  }, []);
  return msg ? (
    <div class="toast" role="status">
      {msg}
    </div>
  ) : null;
}

export function Busy(props: { text: string | null }) {
  if (!props.text) return null;
  return (
    <div class="busy" role="alert" aria-busy="true">
      <div class="box">{props.text}</div>
    </div>
  );
}

/** Hidden file input opened programmatically (iOS shows the Photos picker for accept="image/*"). */
export function usePicker(onFiles: (files: File[]) => void, multiple: boolean, testId?: string) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      class="hidden-input"
      type="file"
      accept="image/*"
      multiple={multiple}
      data-testid={testId ?? (multiple ? 'pick-multi' : 'pick-one')}
      onChange={(e) => {
        const el = e.target as HTMLInputElement;
        const files = Array.from(el.files ?? []);
        el.value = '';
        if (files.length) onFiles(files);
      }}
    />
  );
  return { input, open: () => ref.current?.click() };
}

export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
}
