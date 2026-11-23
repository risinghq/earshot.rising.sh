// The room's icons, drawn like the server's: 24-unit boxes, hidden from
// assistive technology.

export const QuitIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

export const CheckIcon = () => (
  <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
  </svg>
);

export const CrossIcon = () => (
  <svg viewBox="0 0 24 24" class="choice-mark" aria-hidden="true">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
  </svg>
);

export const FlagIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z" />
  </svg>
);

export const OutIcon = () => (
  <svg viewBox="0 0 24 24" class="out-icon" aria-hidden="true">
    <path d="M8 16L16 8M9 8h7v7" />
  </svg>
);

export const CopyIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="8" y="8" width="12" height="12" rx="3" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
);

export const ShareIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v12M7 8l5-5 5 5M5 14v5h14v-5" />
  </svg>
);

export const SoundOffIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="is-solid" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </svg>
);

export const TvIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="5" width="18" height="12" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </svg>
);

export const ChevronIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M9 6l6 6-6 6" />
  </svg>
);

export const BackIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M15 6l-6 6 6 6" />
  </svg>
);

export const DevicesIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="2" y="4" width="14" height="10" rx="2" />
    <path d="M6 18h6" />
    <rect x="16" y="9" width="6" height="11" rx="1.5" />
  </svg>
);

export const LockIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

export const CloseIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const SearchIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
  </svg>
);

export const MuteIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path class="mute-body" d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
    <path class="mute-on" d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" />
    <path class="mute-off" d="M16 9.5l5 5M21 9.5l-5 5" />
  </svg>
);
