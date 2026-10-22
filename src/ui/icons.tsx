import type { SVGAttributes } from 'preact';

type P = SVGAttributes<SVGSVGElement>;

function I(props: Omit<P, 'd'> & { d: string | string[] }) {
  const { d, ...rest } = props;
  const paths = Array.isArray(d) ? d : [d];
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths.map((p) => (
        <path d={p} />
      ))}
    </svg>
  );
}

export const IcBack = (p: P) => <I {...p} d="M15 5l-7 7 7 7" />;
export const IcUndo = (p: P) => <I {...p} d={['M9 14L4 9l5-5', 'M4 9h10a6 6 0 010 12h-3']} />;
export const IcRedo = (p: P) => <I {...p} d={['M15 14l5-5-5-5', 'M20 9H10a6 6 0 000 12h3']} />;
export const IcShare = (p: P) => <I {...p} d={['M12 3v12', 'M7 8l5-5 5 5', 'M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6']} />;
export const IcPhoto = (p: P) => (
  <I {...p} d={['M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z', 'M3 16l5-5 4 4 3-3 6 6', 'M15.5 9.5h.01']} />
);
export const IcStitch = (p: P) => (
  <I {...p} d={['M5 3h14v8H5z', 'M5 13h14v8H5z', 'M3 12h2', 'M8 12h2', 'M14 12h2', 'M19 12h2']} />
);
export const IcAdjust = (p: P) => (
  <I {...p} d={['M4 6h10', 'M18 6h2', 'M4 12h4', 'M12 12h8', 'M4 18h12', 'M20 18h0', 'M16 4v4', 'M10 10v4', 'M18 16v4']} />
);
export const IcFilter = (p: P) => (
  <I {...p} d={['M9 9m-5 0a5 5 0 1010 0a5 5 0 10-10 0', 'M15 9m-5 0a5 5 0 1010 0a5 5 0 10-10 0', 'M12 15m-5 0a5 5 0 1010 0a5 5 0 10-10 0']} />
);
export const IcCrop = (p: P) => <I {...p} d={['M6 2v14a2 2 0 002 2h14', 'M2 6h14a2 2 0 012 2v14']} />;
export const IcLayers = (p: P) => <I {...p} d={['M12 3l9 5-9 5-9-5 9-5z', 'M3 13l9 5 9-5', 'M3 17l9 5 9-5']} />;
export const IcMask = (p: P) => (
  <I {...p} d={['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 3v18', 'M12 7h5', 'M12 11h8', 'M12 15h7', 'M12 19h4']} />
);
export const IcRotate = (p: P) => <I {...p} d={['M20 11a8 8 0 10-2.3 5.7', 'M20 4v7h-7']} />;
export const IcFlipH = (p: P) => <I {...p} d={['M12 3v18', 'M8 7l-5 5 5 5V7z', 'M16 7l5 5-5 5V7z']} />;
export const IcFlipV = (p: P) => <I {...p} d={['M3 12h18', 'M7 8l5-5 5 5H7z', 'M7 16l5 5 5-5H7z']} />;
export const IcPlus = (p: P) => <I {...p} d={['M12 5v14', 'M5 12h14']} />;
export const IcTrash = (p: P) => <I {...p} d={['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3']} />;
export const IcUp = (p: P) => <I {...p} d={['M12 19V5', 'M6 11l6-6 6 6']} />;
export const IcDown = (p: P) => <I {...p} d={['M12 5v14', 'M6 13l6 6 6-6']} />;
export const IcLeft = (p: P) => <I {...p} d={['M19 12H5', 'M11 6l-6 6 6 6']} />;
export const IcRight = (p: P) => <I {...p} d={['M5 12h14', 'M13 6l6 6-6 6']} />;
export const IcCopy = (p: P) => <I {...p} d={['M8 8h12v12H8z', 'M4 16V4h12']} />;
export const IcText = (p: P) => <I {...p} d={['M5 6V4h14v2', 'M12 4v16', 'M9 20h6']} />;
export const IcBrush = (p: P) => (
  <I {...p} d={['M14 4l6 6-8 8-6-6 8-8z', 'M6 12l-2 2c-1.5 1.5-1 4-1 6 2 0 4.5.5 6-1l2-2']} />
);
export const IcEraser = (p: P) => <I {...p} d={['M15 4l5 5-10 10H5l-2-2 12-13z', 'M10 9l5 5', 'M10 20h10']} />;
export const IcGradient = (p: P) => (
  <I {...p} d={['M4 4h16v16H4z', 'M4 9h16', 'M4 14h16', 'M8 4v5', 'M12 9v5', 'M16 14v6']} />
);
export const IcRadial = (p: P) => <I {...p} d={['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 8a4 4 0 100 8 4 4 0 000-8z']} />;
export const IcWand = (p: P) => <I {...p} d={['M4 20L15 9', 'M15 3v3', 'M18 6h3', 'M12 6h1', 'M15 12v1', 'M19 9l1 1', 'M19 3l-1 1']} />;
export const IcInvert = (p: P) => <I {...p} d={['M12 3a9 9 0 100 18 9 9 0 000-18z', 'M12 3v18', 'M12 3a9 9 0 010 18']} />;
export const IcEye = (p: P) => <I {...p} d={['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', 'M12 9a3 3 0 100 6 3 3 0 000-6z']} />;
export const IcCheck = (p: P) => <I {...p} d="M5 12l5 5 9-10" />;
export const IcClose = (p: P) => <I {...p} d={['M6 6l12 12', 'M18 6L6 18']} />;
export const IcAuto = (p: P) => (
  <I {...p} d={['M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z', 'M18 15l.9 2.1L21 18l-2.1.9L18 21l-.9-2.1L15 18l2.1-.9L18 15z']} />
);
export const IcGrid = (p: P) => <I {...p} d={['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z']} />;
export const IcCols = (p: P) => <I {...p} d={['M4 4h7v16H4z', 'M13 4h7v16h-7z']} />;
export const IcRows = (p: P) => <I {...p} d={['M4 4h16v7H4z', 'M4 13h16v7H4z']} />;
export const IcEdit = (p: P) => <I {...p} d={['M4 20h4L19 9l-4-4L4 16v4z', 'M14 6l4 4']} />;
export const IcFit = (p: P) => <I {...p} d={['M4 9V4h5', 'M20 9V4h-5', 'M4 15v5h5', 'M20 15v5h-5']} />;
