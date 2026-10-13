import type AdminSections from './AdminSections.svelte';
import type AdminTabs from './AdminTabs.svelte';
import type DomainManagement from './DomainManagement.svelte';

export interface AdminActions {
  run: (
    name: string,
    input: Record<string, unknown>,
    message?: string,
  ) => Promise<Record<string, unknown> | null>;
  manualRefresh: () => Promise<void>;
}

export interface AdminComponents {
  Sections: typeof AdminSections;
  Tabs: typeof AdminTabs;
  Domains: typeof DomainManagement;
}
