import type { AuditAction } from '@hearth/core/audit-search';
import type { LucideIcon } from '@lucide/svelte';
import ArrowRight from '@lucide/svelte/icons/arrow-right';
import CirclePause from '@lucide/svelte/icons/circle-pause';
import CirclePlay from '@lucide/svelte/icons/circle-play';
import CirclePlus from '@lucide/svelte/icons/circle-plus';
import CircleX from '@lucide/svelte/icons/circle-x';
import DatabaseCheck from '@lucide/svelte/icons/database-check';
import DatabasePlus from '@lucide/svelte/icons/database-plus';
import Expand from '@lucide/svelte/icons/expand';
import FileDown from '@lucide/svelte/icons/file-down';
import Globe from '@lucide/svelte/icons/globe';
import GlobeCheck from '@lucide/svelte/icons/globe-check';
import GlobeLock from '@lucide/svelte/icons/globe-lock';
import GlobeX from '@lucide/svelte/icons/globe-x';
import HardDrive from '@lucide/svelte/icons/hard-drive';
import ImageMinus from '@lucide/svelte/icons/image-minus';
import ImageUp from '@lucide/svelte/icons/image-up';
import KeyRound from '@lucide/svelte/icons/key-round';
import Link from '@lucide/svelte/icons/link';
import ListCheck from '@lucide/svelte/icons/list-check';
import ListChecks from '@lucide/svelte/icons/list-checks';
import LogIn from '@lucide/svelte/icons/log-in';
import LogOut from '@lucide/svelte/icons/log-out';
import RefreshCw from '@lucide/svelte/icons/refresh-cw';
import RotateCcwKey from '@lucide/svelte/icons/rotate-ccw-key';
import ScanEye from '@lucide/svelte/icons/scan-eye';
import Settings from '@lucide/svelte/icons/settings';
import Shield from '@lucide/svelte/icons/shield';
import ShieldBan from '@lucide/svelte/icons/shield-ban';
import ShieldUser from '@lucide/svelte/icons/shield-user';
import SkipForward from '@lucide/svelte/icons/skip-forward';
import Star from '@lucide/svelte/icons/star';
import Timer from '@lucide/svelte/icons/timer';
import Unlink from '@lucide/svelte/icons/unlink';
import UserRoundCheck from '@lucide/svelte/icons/user-round-check';
import UserRoundMinus from '@lucide/svelte/icons/user-round-minus';
import UserRoundPen from '@lucide/svelte/icons/user-round-pen';
import UserRoundPlus from '@lucide/svelte/icons/user-round-plus';
import UserRoundX from '@lucide/svelte/icons/user-round-x';

const auditIcons = {
  'onboarding.progress': ArrowRight,
  'onboarding.completed': ListCheck,
  'onboarding.skipped': SkipForward,
  'onboarding.upload_started': ScanEye,
  'onboarding.upload_skipped': SkipForward,
  'user.created': UserRoundPlus,
  'user.updated': UserRoundPen,
  'user.display_name_policy': UserRoundPen,
  'settings.display_name_policy': Settings,
  'user.active': UserRoundCheck,
  'user.disabled': UserRoundX,
  'user.deleted': UserRoundMinus,
  'user.preferences': Settings,
  'user.delivery_preference': Globe,
  'credential.reset': KeyRound,
  'credential.rotated': RotateCcwKey,
  'auth.access_denied': ShieldBan,
  'auth.login': LogIn,
  'auth.logout': LogOut,
  'auth.login_failed': CircleX,
  'credential.config_exported': FileDown,
  'image.uploaded': ImageUp,
  'image.deleted': ImageMinus,
  'image.retention': Timer,
  'image.expiry': Timer,
  'domain.created': CirclePlus,
  'domain.updated': Settings,
  'domain.deleted': GlobeX,
  'domain.primary': Star,
  'domain.enabled': GlobeCheck,
  'domain.disabled': GlobeLock,
  'alias.created': Link,
  'alias.deleted': Unlink,
  'alias.primary': Star,
  'alias.expiry': Timer,
  'settings.updated': Settings,
  'settings.share_slug_length': Settings,
  'share_slug.expanded': Expand,
  'settings.expiry_policy': Timer,
  'user.expiry_policy': Timer,
  'storage.reconciliation': RefreshCw,
  'maintenance.paused': CirclePause,
  'maintenance.resumed': CirclePlay,
  'storage.reconciliation_completed': DatabaseCheck,
  'storage.finding_resolved': ListChecks,
  'storage.limit_updated': HardDrive,
  'storage.initialized': DatabasePlus,
  'admin.bootstrapped': ShieldUser,
} satisfies Record<AuditAction, LucideIcon>;

export function auditIcon(action: string): LucideIcon {
  return Object.hasOwn(auditIcons, action)
    ? auditIcons[action as AuditAction]
    : Shield;
}
