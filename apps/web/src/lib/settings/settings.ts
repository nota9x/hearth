import { getContext } from 'svelte';

import { action } from '#lib/client.ts';
import { dashboard } from '#lib/dashboard.ts';

export const settingsContext = Symbol('settings');
export interface SettingsState {
  update: (id: string, state: { dirty: boolean; pending: boolean }) => void;
  remove: (id: string) => void;
}
export function settingsState() {
  return getContext<SettingsState>(settingsContext);
}

export async function saveSettings(
  name: string,
  input: Record<string, unknown>,
  committed: () => void,
) {
  await action(name, input);
  committed();
  try {
    await dashboard.refresh(true);
  } catch {
    return 'Saved, but the latest settings could not be refreshed. Reload to check them.';
  }
}
