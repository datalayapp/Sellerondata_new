import Svg, { Circle, Path, Rect } from 'react-native-svg';

export type IconName =
  | 'check'
  | 'plus'
  | 'minus'
  | 'back'
  | 'chev'
  | 'arrow'
  | 'warn'
  | 'camera'
  | 'flash'
  | 'scale'
  | 'scan'
  | 'box'
  | 'cloudoff'
  | 'sync'
  | 'info'
  | 'send'
  | 'clock'
  | 'ruler'
  | 'close'
  | 'keypad'
  | 'edit'
  | 'logout'
  | 'cube'
  | 'card'
  | 'hand'
  | 'trash'
  | 'gear'
  | 'image'
  | 'eye'
  | 'eyeOff'
  | 'user'
  | 'lock'
  | 'backspace'
  | 'search'
  | 'history'
  | 'undo'
  | 'home'
  | 'globe'
  | 'more'
  | 'upload';

type Props = { name: IconName; size?: number; color?: string; strokeWidth?: number };

export function Icon({ name, size = 24, color = '#101828', strokeWidth = 1.8 }: Props) {
  const p = { stroke: color, strokeWidth, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {shape(name, p)}
    </Svg>
  );
}

type P = { stroke: string; strokeWidth: number; fill: string; strokeLinecap: 'round'; strokeLinejoin: 'round' };

function shape(name: IconName, p: P) {
  switch (name) {
    case 'search':
      return (
        <>
          <Circle cx="11" cy="11" r="6.5" {...p} />
          <Path d="M16 16l4.5 4.5" {...p} />
        </>
      );
    case 'history':
      return (
        <>
          <Path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" {...p} />
          <Path d="M3.5 4v4.5H8M12 7.5V12l3 2" {...p} />
        </>
      );
    case 'undo':
      return (
        <>
          <Path d="M9 14L4 9l5-5" {...p} />
          <Path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" {...p} />
        </>
      );
    case 'more':
      return (
        <>
          <Circle cx="5.5" cy="12" r="1.2" {...p} />
          <Circle cx="12" cy="12" r="1.2" {...p} />
          <Circle cx="18.5" cy="12" r="1.2" {...p} />
        </>
      );
    case 'upload':
      return <Path d="M12 19V6M6 11l6-6 6 6" {...p} />;
    case 'home':
      return <Path d="M3.5 11L12 4l8.5 7M6 9.5V20h12V9.5M10 20v-5.5h4V20" {...p} />;
    case 'globe':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...p} />
          <Path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9c-2.6-2.6-3.9-5.6-3.9-9S9.4 5.6 12 3z" {...p} />
        </>
      );
    case 'check':
      return <Path d="M5 12.5l4.5 4.5L19 7.5" {...p} />;
    case 'plus':
      return <Path d="M12 5v14M5 12h14" {...p} />;
    case 'minus':
      return <Path d="M5 12h14" {...p} />;
    case 'back':
      return <Path d="M15 5l-7 7 7 7" {...p} />;
    case 'chev':
      return <Path d="M9 5l7 7-7 7" {...p} />;
    case 'arrow':
      return <Path d="M4 12h15M13 6l6 6-6 6" {...p} />;
    case 'warn':
      return (
        <>
          <Path d="M12 3.5L2.5 20h19z" {...p} />
          <Path d="M12 9.5v5M12 17.2v.3" {...p} />
        </>
      );
    case 'camera':
      return (
        <>
          <Path d="M3 7.5h4l2-2.5h6l2 2.5h4V19H3z" {...p} />
          <Circle cx="12" cy="13" r="3.5" {...p} />
        </>
      );
    case 'flash':
      return (
        <>
          <Path d="M7 3h10v3.5l-3 4V21h-4V10.5l-3-4z" {...p} />
          <Path d="M7 6.5h10M12 13.5v2.5" {...p} />
        </>
      );
    case 'scale':
      return (
        <>
          <Path d="M3 9h18v11H3z" {...p} />
          <Path d="M5 9l1.5-4.5h11L19 9" {...p} />
          <Circle cx="12" cy="14.5" r="2.6" {...p} />
          <Path d="M12 14.5l1.6-1.4" {...p} />
        </>
      );
    case 'scan':
      return (
        <>
          <Path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" {...p} />
          <Path d="M7.5 8v8M10.5 8v8M14 8v8M16.5 8v8" {...p} />
        </>
      );
    case 'box':
      return (
        <>
          <Path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...p} />
          <Path d="M4 7.5l8 4.5 8-4.5M12 12v9" {...p} />
        </>
      );
    case 'cloudoff':
      return (
        <>
          <Path d="M7 18.5h10.5a3.5 3.5 0 0 0 .6-6.95A5.5 5.5 0 0 0 7.6 9.6 4.5 4.5 0 0 0 7 18.5z" {...p} />
          <Path d="M3.5 3.5l17 17" {...p} />
        </>
      );
    case 'sync':
      return (
        <>
          <Path d="M19.5 12a7.5 7.5 0 0 1-13.2 4.9M4.5 12a7.5 7.5 0 0 1 13.2-4.9" {...p} />
          <Path d="M18 3.5v3.7h-3.7M6 20.5v-3.7h3.7" {...p} />
        </>
      );
    case 'info':
      return (
        <>
          <Circle cx="12" cy="12" r="9" {...p} />
          <Path d="M12 11v6M12 7.6v.3" {...p} />
        </>
      );
    case 'send':
      return (
        <>
          <Path d="M3 11.5L21 3l-6.5 18-3-7.5z" {...p} />
          <Path d="M11.5 13.5L21 3" {...p} />
        </>
      );
    case 'clock':
      return (
        <>
          <Circle cx="12" cy="12" r="8.5" {...p} />
          <Path d="M12 7.5V12l3 2" {...p} />
        </>
      );
    case 'ruler':
      return (
        <>
          <Path d="M3 15.5L15.5 3 21 8.5 8.5 21z" {...p} />
          <Path d="M7 11.5l2 2M10 8.5l1.5 1.5M12.8 5.7l2 2M9.6 14.5l1.4 1.4" {...p} />
        </>
      );
    case 'close':
      return <Path d="M6 6l12 12M18 6L6 18" {...p} />;
    case 'keypad':
      return (
        <>
          <Rect x="4" y="3" width="16" height="18" rx="2" {...p} />
          <Path d="M8 8h.01M12 8h.01M16 8h.01M8 12h.01M12 12h.01M16 12h.01M8 16h.01M12 16h.01M16 16h.01" {...p} />
        </>
      );
    case 'edit':
      return <Path d="M15.5 4.5l4 4L9 19H5v-4z" {...p} />;
    case 'logout':
      return (
        <>
          <Path d="M10 4H4v16h6" {...p} />
          <Path d="M9 12h11M16 8l4 4-4 4" {...p} />
        </>
      );
    case 'cube':
      return (
        <>
          <Path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" {...p} />
          <Path d="M4 7.5l8 4.5 8-4.5M12 12v9" {...p} />
          <Circle cx="12" cy="12" r="1.2" {...p} />
        </>
      );
    case 'card':
      return (
        <>
          <Rect x="3" y="5" width="18" height="14" rx="2" {...p} />
          <Rect x="7" y="8.5" width="7" height="7" {...p} />
          <Path d="M17 9v6" {...p} />
        </>
      );
    case 'hand':
      return (
        <>
          <Path d="M4 20h16" {...p} />
          <Path d="M6 16l4-10 4 10M7.6 12h4.8" {...p} />
          <Path d="M17 8v8" {...p} />
        </>
      );
    case 'trash':
      return (
        <>
          <Path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" {...p} />
        </>
      );
    case 'image':
      return (
        <>
          <Rect x="3" y="5" width="18" height="14" rx="2" {...p} />
          <Path d="M3 17l5-5 4 4 3-3 6 6" {...p} />
          <Circle cx="15.5" cy="9.5" r="1.5" {...p} />
        </>
      );
    case 'eye':
      return (
        <>
          <Path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" {...p} />
          <Circle cx="12" cy="12" r="3" {...p} />
        </>
      );
    case 'eyeOff':
      return (
        <>
          <Path d="M9.9 5.8A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.6 3.4M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 18.5 12 18.5c1.9 0 3.5-.6 4.9-1.5" {...p} />
          <Path d="M3.5 3.5l17 17M9.9 9.9a3 3 0 0 0 4.2 4.2" {...p} />
        </>
      );
    case 'user':
      return (
        <>
          <Circle cx="12" cy="8.5" r="4" {...p} />
          <Path d="M4 20.5c1.2-3.8 4.3-5.5 8-5.5s6.8 1.7 8 5.5" {...p} />
        </>
      );
    case 'lock':
      return (
        <>
          <Rect x="4.5" y="10.5" width="15" height="10" rx="2" {...p} />
          <Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" {...p} />
        </>
      );
    case 'backspace':
      return (
        <>
          <Path d="M8.5 5H20a1.5 1.5 0 0 1 1.5 1.5v11A1.5 1.5 0 0 1 20 19H8.5L2.5 12z" {...p} />
          <Path d="M11 9.5l5 5M16 9.5l-5 5" {...p} />
        </>
      );
    case 'gear':
      return (
        <>
          <Circle cx="12" cy="12" r="3" {...p} />
          <Path
            d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"
            {...p}
          />
        </>
      );
  }
}
