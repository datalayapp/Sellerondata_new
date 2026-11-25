import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceAround,
  ArrowUpDown,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Copy,
  Crosshair,
  Ellipsis,
  Eye,
  FileDown,
  FilePlus,
  Flag,
  Globe,
  Grid3x3,
  Hand,
  Image,
  Info,
  Keyboard,
  LayoutGrid,
  Link2Off,
  List,
  Lock,
  LockOpen,
  type LucideIcon,
  Maximize,
  MessageSquare,
  Minus,
  MousePointer2,
  Monitor,
  Move,
  OctagonAlert,
  PanelLeft,
  PanelRight,
  Paperclip,
  Pencil,
  Plus,
  Printer,
  Redo2,
  RefreshCw,
  RotateCcw,
  Ruler,
  Search,
  Send,
  Sparkles,
  SquareDashed,
  Stamp,
  Tag,
  Trash2,
  TriangleAlert,
  Type,
  Undo2,
  Upload,
  X,
  ZoomIn,
} from "lucide-react";
import { cx } from "../cx.ts";
import { CUSTOM_ICONS, type IconName } from "./paths.ts";

export { ICON_NAMES, type IconName } from "./paths.ts";

/** Lucide karşılıkları (plan §3.3: "lucide karşılığı olanlar lucide'den"). Özel çizimler (kesim, kayıt, şekiller, ayar bölümleri) paths.ts'te. */
const LUCIDE: Record<Exclude<IconName, keyof typeof CUSTOM_ICONS>, LucideIcon> = {
  chev: ChevronDown,
  left: ChevronLeft,
  right: ChevronRight,
  check: Check,
  dots: Ellipsis,
  up: Upload,
  move: Move,
  print: Printer,
  cursor: MousePointer2,
  hand: Hand,
  zin: ZoomIn,
  minus: Minus,
  plus: Plus,
  type: Type,
  align: AlignStartVertical,
  grid: Grid3x3,
  bldg: Building2,
  spark: Sparkles,
  send: Send,
  fit: Maximize,
  ruler: Ruler,
  undo: Undo2,
  redo: Redo2,
  reset: RotateCcw,
  ah: AlignCenterVertical,
  av: AlignCenterHorizontal,
  cross: Crosshair,
  trash: Trash2,
  copy: Copy,
  unlink: Link2Off,
  search: Search,
  sort: ArrowUpDown,
  file: FileDown,
  filep: FilePlus,
  stamp: Stamp,
  lock: Lock,
  layout: LayoutGrid,
  refresh: RefreshCw,
  kbd: Keyboard,
  x: X,
  pen: Pencil,
  img: Image,
  clip: Paperclip,
  flag: Flag,
  warn: TriangleAlert,
  err: OctagonAlert,
  okc: CircleCheck,
  marq: SquareDashed,
  dl: AlignStartVertical,
  dr: AlignEndVertical,
  dt: AlignStartHorizontal,
  db: AlignEndHorizontal,
  dx: AlignHorizontalSpaceAround,
  dy: AlignVerticalSpaceAround,
  msg: MessageSquare,
  eye: Eye,
  tag: Tag,
  globe: Globe,
  info: Info,
  list: List,
  unlock: LockOpen,
  pnll: PanelLeft,
  pnlr: PanelRight,
  wide: Monitor,
};

/** Maketteki çizgi kalınlığı (24 birimde). */
const STROKE = 1.8;

/** Çizgi ikon (maketin sprite adları). Süs: ekran okuyucudan gizli; adı düğme taşır. */
export function Icon({ name, size = 18, className }: { name: IconName; size?: 18 | 15 | 12; className?: string }) {
  const custom = (CUSTOM_ICONS as Partial<Record<IconName, string>>)[name];
  if (custom) {
    return (
      <svg
        className={cx("tz-icon", className)}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        aria-hidden="true"
        focusable="false"
        data-icon={name}
        // Çizimler bu paketin kendi sabitleri (paths.ts); dışarıdan metin girmez.
        dangerouslySetInnerHTML={{ __html: custom }}
      />
    );
  }
  const L = LUCIDE[name as keyof typeof LUCIDE];
  return <L className={cx("tz-icon", className)} size={size} strokeWidth={STROKE} aria-hidden="true" focusable="false" data-icon={name} />;
}
