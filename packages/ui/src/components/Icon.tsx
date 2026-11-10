import type { SVGProps } from 'react';

const STROKE = {
  volume: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M15.5 9a4 4 0 0 1 0 6 M18 6.5a7.5 7.5 0 0 1 0 11',
  volumeMute: 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z M16 9.5l5 5 M21 9.5l-5 5',
  home: 'M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z',
  album: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z',
  artist: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
  track:
    'M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M9 18V6l11-2v12 M20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z M9 10l11-2',
  folder:
    'M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l2 2.2H19a1.5 1.5 0 0 1 1.5 1.5v9.3a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18z',
  playlist:
    'M4 6.5h11 M4 11.5h11 M4 16.5h6 M18.5 19a2 2 0 1 1-4 0 2 2 0 0 1 4 0z M18.5 19v-8l2.5-.8',
  queue: 'M4 6.5h16 M4 12h16 M4 17.5h10',
  settings: 'M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 4.5v5 M9 14.5v5',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  plus: 'M12 5v14 M5 12h14',
  close: 'M6 6l12 12 M18 6 6 18',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  warning: 'M12 4 2.8 19.5h18.4z M12 10v4.5 M12 17.2v.3',
  info: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18z M12 11v5.5 M12 7.8v.4',
  chevronLeft: 'M14.5 6 8.5 12l6 6',
  chevronRight: 'M9.5 6l6 6-6 6',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronUp: 'M6 14.5l6-6 6 6',
  trash: 'M5 7h14 M10 7V5h4v2 M7 7l1 12.5h8L17 7',
  edit: 'M4 20h4L19 9l-4-4L4 16z M13 7l4 4',
  copy: 'M8.5 8.5h11v11h-11z M5 15.5v-11h11',
  mini: 'M3.5 5.5h17v13h-17z M12 12h6v4.5h-6z',
  expand: 'M9 4H4v5 M15 4h5v5 M9 20H4v-5 M15 20h5v-5',
  refresh: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3 M19.5 4.5v4h-4',
  panel: 'M3.5 5h17v14h-17z M14.5 5v14',
  remote: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M11 18h2',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  wave: 'M3 12c2-6 4-6 6 0s4 6 6 0 4-6 6 0',
  pin: 'M9 4h6l-1 6 3 3H7l3-3z M12 13v7',
  external: 'M14 4h6v6 M20 4l-9 9 M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  library: 'M5 4v16 M10 4v16 M14.5 4.5l5 15',
  plug: 'M9 3v5 M15 3v5 M6.5 8h11v3a5.5 5.5 0 0 1-11 0z M12 16.5V21',
} as const satisfies Record<string, string>;

const FILL = {
  play: 'M7 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L8.5 4.64A1 1 0 0 0 7 5.5z',
  pause: 'M7 5h3.4v14H7z M13.6 5H17v14h-3.4z',
  stop: 'M6.5 6.5h11v11h-11z',
  next: 'M5.5 6.2v11.6a.8.8 0 0 0 1.24.66L15 13v4.8h2.5V6.2H15V11L6.74 5.54a.8.8 0 0 0-1.24.66z',
  previous: 'M18.5 6.2v11.6a.8.8 0 0 1-1.24.66L9 13v4.8H6.5V6.2H9V11l8.26-5.46a.8.8 0 0 1 1.24.66z',
  more: 'M6 10.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z M12 10.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z M18 10.4a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 0 1 0-3.2z',
  drag: 'M9 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M15 5.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M9 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M15 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M9 15.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z M15 15.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  dot: 'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
} as const satisfies Record<string, string>;

export type IconName = keyof typeof STROKE | keyof typeof FILL;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Accessible label; when omitted the icon is decorative (aria-hidden). */
  label?: string;
}

export function Icon({ name, size = 18, label, className, ...rest }: IconProps) {
  const fill = (FILL as Record<string, string>)[name];
  const stroke = (STROKE as Record<string, string>)[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`hq-icon${className ? ` ${className}` : ''}`}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    >
      {fill ? (
        <path d={fill} fill="currentColor" />
      ) : (
        <path
          d={stroke ?? ''}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
