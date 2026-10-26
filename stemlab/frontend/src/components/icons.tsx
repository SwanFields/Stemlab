const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "currentColor",
  "aria-hidden": true,
} as const;

export const PlayIcon = () => (
  <svg {...base}>
    <path d="M4 2.5v11a.5.5 0 0 0 .76.43l9-5.5a.5.5 0 0 0 0-.86l-9-5.5A.5.5 0 0 0 4 2.5Z" />
  </svg>
);

export const PauseIcon = () => (
  <svg {...base}>
    <rect x="3.5" y="2.5" width="3" height="11" rx=".5" />
    <rect x="9.5" y="2.5" width="3" height="11" rx=".5" />
  </svg>
);

export const StopIcon = () => (
  <svg {...base}>
    <rect x="3" y="3" width="10" height="10" rx=".5" />
  </svg>
);

export const DownloadIcon = () => (
  <svg {...base}>
    <path d="M8 1.5a.5.5 0 0 1 .5.5v7.8l2.65-2.65a.5.5 0 0 1 .7.7l-3.5 3.5a.5.5 0 0 1-.7 0l-3.5-3.5a.5.5 0 1 1 .7-.7L7.5 9.8V2a.5.5 0 0 1 .5-.5ZM2.5 12a.5.5 0 0 1 .5.5v1h10v-1a.5.5 0 0 1 1 0v1.5a.5.5 0 0 1-.5.5h-11a.5.5 0 0 1-.5-.5v-1.5a.5.5 0 0 1 .5-.5Z" />
  </svg>
);
