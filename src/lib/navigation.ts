export type NavigationIcon =
  | 'home'
  | 'image'
  | 'video'
  | 'jobs'
  | 'library'
  | 'models'
  | 'presets'
  | 'settings'
  | 'diagnostics';

export interface NavigationItem {
  label: string;
  href: string;
  icon: NavigationIcon;
  description: string;
}

export interface NavigationGroup {
  label: string;
  items: readonly NavigationItem[];
}

const dashboard: NavigationItem = {
  label: 'Dashboard',
  href: '/',
  icon: 'home',
  description: 'Account, jobs, storage and recent generations'
};

const imageStudio: NavigationItem = {
  label: 'Image Studio',
  href: '/studio/image',
  icon: 'image',
  description: 'Create and transform images'
};

const videoStudio: NavigationItem = {
  label: 'Video Studio',
  href: '/studio/video',
  icon: 'video',
  description: 'Create and transform video'
};

const jobs: NavigationItem = {
  label: 'Jobs',
  href: '/jobs',
  icon: 'jobs',
  description: 'Durable generation queue and history'
};

const gallery: NavigationItem = {
  label: 'Gallery',
  href: '/gallery',
  icon: 'library',
  description: 'Verified local images and videos'
};

const models: NavigationItem = {
  label: 'Models',
  href: '/models',
  icon: 'models',
  description: 'Audited model catalogue'
};

const presets: NavigationItem = {
  label: 'Presets',
  href: '/presets',
  icon: 'presets',
  description: 'Reusable generation configurations'
};

const settings: NavigationItem = {
  label: 'Settings',
  href: '/settings',
  icon: 'settings',
  description: 'Credentials, storage and application preferences'
};

export const navigationGroups: readonly NavigationGroup[] = [
  { label: 'Home', items: [dashboard] },
  { label: 'Create', items: [imageStudio, videoStudio] },
  { label: 'Manage', items: [jobs, gallery] },
  { label: 'Discover', items: [models, presets] }
];

export const mobileNavigation = [dashboard, imageStudio, videoStudio, jobs, gallery] as const;
export const moreNavigation = [models, presets, settings] as const;

export const settingsNavigation = [
  settings,
  {
    label: 'Diagnostics',
    href: '/settings/diagnostics',
    icon: 'diagnostics',
    description: 'Redacted health and version report'
  }
] as const satisfies readonly NavigationItem[];

const routeTitles = new Map<string, string>([
  ['/', 'Dashboard'],
  ['/studio/image', 'Image Studio'],
  ['/studio/video', 'Video Studio'],
  ['/jobs', 'Jobs'],
  ['/gallery', 'Gallery'],
  ['/models', 'Models'],
  ['/presets', 'Presets'],
  ['/settings', 'Settings'],
  ['/settings/diagnostics', 'Diagnostics']
]);

export function getRouteTitle(pathname: string): string {
  return routeTitles.get(pathname) ?? 'Poyo Local Studio';
}

export function isPathActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function isStudioPath(pathname: string): boolean {
  return pathname === '/studio/image' || pathname === '/studio/video';
}
