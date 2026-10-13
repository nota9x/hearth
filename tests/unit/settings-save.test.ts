import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveSettings } from '../../apps/web/src/lib/settings/settings';

const { mutation, refresh } = vi.hoisted(() => ({
  mutation: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('$lib/client', () => ({ action: mutation }));
vi.mock('$lib/dashboard', () => ({ dashboard: { refresh } }));

beforeEach(() => {
  mutation.mockReset();
  refresh.mockReset();
});

describe('settings save outcomes', () => {
  it('keeps a failed mutation editable without changing the saved baseline', async () => {
    mutation.mockRejectedValue(new Error('Storage accounting is not ready.'));
    const committed = vi.fn();
    await expect(
      saveSettings('storage-limit', { limitBytes: 1000 }, committed),
    ).rejects.toThrow('Storage accounting is not ready.');
    expect(committed).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('marks a confirmed mutation saved even when its follow-up read fails', async () => {
    mutation.mockResolvedValue({});
    refresh.mockRejectedValue(new Error('Network unavailable.'));
    const committed = vi.fn();
    await expect(
      saveSettings('preferences', { displayName: 'New name' }, committed),
    ).resolves.toContain('Saved, but');
    expect(committed).toHaveBeenCalledOnce();
    expect(mutation).toHaveBeenCalledOnce();
  });
});
