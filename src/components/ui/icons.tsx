import type { SVGProps } from 'react';

/**
 * Icon set.
 *
 * Every icon is decorative (`aria-hidden`) because it always accompanies a text
 * label — an icon-only control gets its name from `aria-label` on the control.
 *
 * Icons whose meaning is directional (a forward arrow, a chevron) carry
 * `data-flip-rtl`, which globals.css mirrors under `[dir='rtl']`. Icons whose
 * meaning is not directional — a clock, a check, a document — deliberately do
 * not, because mirroring them would be wrong.
 */

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconDashboard = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7.5" height="8.5" rx="1.5" />
    <rect x="13.5" y="3" width="7.5" height="5" rx="1.5" />
    <rect x="13.5" y="11" width="7.5" height="10" rx="1.5" />
    <rect x="3" y="14.5" width="7.5" height="6.5" rx="1.5" />
  </Icon>
);

export const IconAgents = (p: IconProps) => (
  <Icon {...p}>
    <rect x="4" y="7" width="16" height="12" rx="3" />
    <path d="M12 7V4" />
    <circle cx="12" cy="3" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="9" cy="13" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconKnowledge = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 15.5Z" />
    <path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5Z" />
  </Icon>
);

export const IconCreative = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="2.5" />
    <circle cx="8.5" cy="9.5" r="1.6" />
    <path d="m3.5 17 4.8-4.5a2 2 0 0 1 2.7 0L20.5 21" />
  </Icon>
);

export const IconAdvertising = (p: IconProps) => (
  <Icon {...p}>
    {/* A megaphone points forward, so it mirrors with the reading direction. */}
    <g data-flip-rtl>
      <path d="M4 10v4a1 1 0 0 0 1 1h2l7 4V5L7 9H5a1 1 0 0 0-1 1Z" />
      <path d="M17.5 9a4 4 0 0 1 0 6" />
      <path d="M20 6.5a7.5 7.5 0 0 1 0 11" />
    </g>
  </Icon>
);

export const IconAssets = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="13" height="13" rx="2" />
    <path d="M8 6V4.5A1.5 1.5 0 0 1 9.5 3H19.5A1.5 1.5 0 0 1 21 4.5V14.5A1.5 1.5 0 0 1 19.5 16H18" />
  </Icon>
);

export const IconCampaigns = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5Z" />
    <path d="M3 9h18" />
    <path d="M7.5 13h5" />
    <path d="M7.5 16.5h9" />
  </Icon>
);

export const IconAnalytics = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 20V10" />
    <path d="M10 20V4" />
    <path d="M16 20v-7" />
    <path d="M22 20H2" />
  </Icon>
);

export const IconActivity = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 2" />
  </Icon>
);

export const IconSettings = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-.97 1.47V21a2 2 0 1 1-4 0v-.11a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-.97H3a2 2 0 1 1 0-4h.11a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 .97-1.47V3a2 2 0 1 1 4 0v.11a1.6 1.6 0 0 0 .97 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47.97H21a2 2 0 1 1 0 4h-.11a1.6 1.6 0 0 0-1.47.97Z" />
  </Icon>
);

export const IconMenu = (p: IconProps) => (
  <Icon {...p} className={p.className ?? 'size-5'}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Icon>
);

export const IconClose = (p: IconProps) => (
  <Icon {...p} className={p.className ?? 'size-5'}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconSend = (p: IconProps) => (
  <Icon {...p} data-flip-rtl>
    <path d="M4 12 20 4l-3 8 3 8Z" />
    <path d="M17 12H8" />
  </Icon>
);

export const IconPlus = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconChevron = (p: IconProps) => (
  <Icon {...p} data-flip-rtl>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const IconCheck = (p: IconProps) => (
  <Icon {...p}>
    <path d="m5 12.5 4.5 4.5L19 7" />
  </Icon>
);

export const IconAlert = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 3.5 22 20H2Z" />
    <path d="M12 10v4.5" />
    <circle cx="12" cy="17.2" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconDocument = (p: IconProps) => (
  <Icon {...p}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5" />
  </Icon>
);

export const IconGlobe = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z" />
  </Icon>
);

export const IconImage = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m3.5 17.5 4.6-4.3a2 2 0 0 1 2.7 0l5.2 4.8" />
  </Icon>
);

export const IconVideo = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="6" width="13" height="12" rx="2.5" />
    <path d="m16 10.5 5-3v9l-5-3Z" data-flip-rtl />
  </Icon>
);

export const IconDownload = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 4v11" />
    <path d="m7.5 11 4.5 4.5L16.5 11" />
    <path d="M5 19h14" />
  </Icon>
);

export const IconTrash = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 6.5h16" />
    <path d="M9 6.5V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v1.5" />
    <path d="M6.5 6.5 7.4 19a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9l.9-12.5" />
  </Icon>
);

export const IconCopy = (p: IconProps) => (
  <Icon {...p}>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
  </Icon>
);

export const IconRefresh = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 11a8 8 0 1 0-.9 4.6" />
    <path d="M20 5v6h-6" />
  </Icon>
);

export const IconSearch = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const IconThumbUp = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 20V10l4.5-6.5a1.8 1.8 0 0 1 3 1.9L13.5 9H19a2 2 0 0 1 2 2.4l-1.4 7A2 2 0 0 1 17.6 20Z" />
    <rect x="3" y="10" width="4" height="10" rx="1.2" />
  </Icon>
);

export const IconThumbDown = (p: IconProps) => (
  <Icon {...p}>
    <path d="M7 4v10l4.5 6.5a1.8 1.8 0 0 0 3-1.9L13.5 15H19a2 2 0 0 0 2-2.4l-1.4-7A2 2 0 0 0 17.6 4Z" />
    <rect x="3" y="4" width="4" height="10" rx="1.2" />
  </Icon>
);

export const IconSun = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2M12 19.5v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2.5 12h2M19.5 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
  </Icon>
);

export const IconMoon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z" />
  </Icon>
);

export const IconInbox = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 13h5l1.5 3h5L16 13h5" />
    <path d="M5.4 5h13.2a2 2 0 0 1 1.9 1.4L22 13v4.5a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 2 17.5V13l1.5-6.6A2 2 0 0 1 5.4 5Z" />
  </Icon>
);
