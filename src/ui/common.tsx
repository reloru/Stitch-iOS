import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export function Slider(props: {
  name: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** value shown when unchanged; double-tap the name to reset to it */
  neutral?: number;
  format?: (v: number) => string;
  onInput: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  const neutral = props.neutral ?? 0;
  const changed = props.value !== neutral;
  return (
    <div class="slider">
      <button
        class="name"
        style={{ textAlign: 'left' }}
        onDblClick={() => {
          props.onInput(neutral);
          props.onCommit(neutral);
        }}
        aria-label={`${props.name} (double-tap to reset)`}
      >
        {props.name}
      </button>
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
      <span class={'val' + (changed ? ' changed' : '')}>{props.format ? props.format(props.value) : Math.round(props.value)}</span>
    </div>
  );
}

export function Sheet(props: { onClose: () => void; children: ComponentChildren; title?: string }) {
  return (
    <div
      class="sheet-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div class="sheet" role="dialog" aria-label={props.title}>
        <div class="grab" />
        {props.title && <h3>{props.title}</h3>}
        {props.children}
      </div>
    </div>
  );
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
export function usePicker(onFiles: (files: File[]) => void, multiple: boolean) {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      class="hidden-input"
      type="file"
      accept="image/*"
      multiple={multiple}
      data-testid={multiple ? 'pick-multi' : 'pick-one'}
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
