/**
 * Tezgâh temel katmanı: sözleşme (ARAYUZ-PLANI §3.3). Ekranlar yalnız buradan içe aktarır:
 *   import { AppFrame, Button, Panel } from "../../tezgah/index.ts";
 * İmzalar Dalga 0'dan sonra donar; değişikliği yalnız orkestratör yapar. Çizimler (CSS ve iç yapı) T1/T2'nindir.
 */

// Çerçeve
export {
  AppFrame,
  type AppFrameProps,
  BandButton,
  type BandButtonProps,
  BandCard,
  type BandTabs,
  type Crumb,
  Crumbs,
  type FlowStep,
  FullBand,
  type NavId,
  StepChips,
  TopRow,
  WorkRow,
  type WorkRowProps,
} from "./cerceve/cerceve.tsx";

// Yerleşim
export {
  CenterColumn,
  CollapsedGroup,
  ListRow,
  type ListRowProps,
  Panel,
  type PanelProps,
  PanelSection,
  PropPair,
  PropRow,
  Rail,
  type RailItem,
  SelectionBar,
  StatusBar,
  Tabs,
  type TabItem,
  type TabsProps,
  ToolDivider,
  ToolGroup,
  ToolLabel,
  ToolSpacer,
  ToolStrip,
  Workspace,
  type WorkspaceProps,
} from "./yerlesim/yerlesim.tsx";

// Düğme ve rozet
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant, IconButton, type IconButtonProps, Kbd } from "./dugme/Button.tsx";

// Form
export {
  Checkbox,
  Field,
  NumberStepper,
  type NumberStepperProps,
  SearchField,
  type SearchFieldProps,
  Segmented,
  type SegmentedProps,
  Select,
  type SelectProps,
  Switch,
  TextArea,
  type TextAreaProps,
  TextField,
  type TextFieldProps,
} from "./form/form.tsx";

// Durum
export { type DotTone, EmptyState, IssueBadge, IssueBox, type IssueTone, ProgressBar, StatusDot, Tag } from "./durum/durum.tsx";

// Tuval (dünya birimi mm)
export { useViewport, type ViewApi, type Pt, type Rect, type View } from "./tuval/useViewport.ts";
export { Artboard, type ArtboardProps, CanvasDock, CanvasViewport, type CanvasViewportProps, CropMarks, CutPath, SelectionBox, ZoomControl } from "./tuval/Tuval.tsx";

// Katmanlar
export { type MenuItem, Menu, Popover, type PopoverProps, Tooltip, type TriggerProps } from "./katman/Popover.tsx";
export { type LeaveGuard, type LeaveGuardOptions, useLeaveGuard } from "./katman/leaveGuard.ts";
export { ConfirmProvider, type ConfirmOptions, Dialog, type DialogProps, ToastProvider, type ToastInput, useConfirm, useToast } from "./katman/Dialog.tsx";
export { useWorkDialogActive, WorkDialog, WorkDialogFooter, type WorkDialogProps } from "./katman/WorkDialog.tsx";

// İkon
export { Icon, ICON_NAMES, type IconName } from "./ikon/Icon.tsx";

// Kısayollar
export {
  type Command,
  type CommandId,
  type CommandView,
  defineCommands,
  type Scope,
  setShortcutsOpen,
  useCommand,
  useCommands,
} from "./kisayol/kayit.ts";

export { cx } from "./cx.ts";
