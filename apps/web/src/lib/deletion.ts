import type { DeleteResult } from '@hearth/core/images';
import { writable } from 'svelte/store';

import { action } from './client';
import { dashboard } from './dashboard';
import type { NotificationItem } from './notifications';
import { notify } from './notifications';

export function createDeletion(actionName: string, noun: string) {
  const imageDeletion = writable({
    pending: [] as string[],
    removed: [] as string[],
  });
  const operation = {
    owner: undefined as string | null | undefined,
    generation: 0,
  };
  const pending = new Set<string>();
  const removed = new Set<string>();
  function publish() {
    imageDeletion.set({ pending: [...pending], removed: [...removed] });
  }

  function setDeletionOwner(value: string | null) {
    if (operation.owner === value) return;
    operation.owner = value;
    operation.generation++;
    pending.clear();
    removed.clear();
    publish();
  }

  function reconcileDeletedImages(visibleIds: string[]) {
    let changed = false;
    for (const imageId of removed)
      if (!visibleIds.includes(imageId)) {
        removed.delete(imageId);
        changed = true;
      }
    if (changed) publish();
  }

  async function deleteSelectedImages(
    ids: string[],
    filenames: Readonly<Record<string, string>> = {},
  ) {
    const snapshot = [...new Set(ids)].filter(
      (imageId) => !pending.has(imageId) && !removed.has(imageId),
    );
    if (snapshot.length === 0) return;
    const generation = operation.generation;
    for (const imageId of snapshot) pending.add(imageId);
    publish();
    let stopping = false;
    const notice = notify.live(
      `0 of ${snapshot.length} deleted`,
      () => {
        stopping = true;
        for (const item of items)
          if (item.state === 'pending') {
            item.state = 'cancelled';
            item.status = 'Not deleted';
          }
        update(
          'loading',
          `Finishing the current deletion batch. Remaining ${noun} will be kept.`,
        );
      },
      {
        cancellation: {
          title: 'Cancel deletion?',
          message: `Deletion is still in progress. Cancelling will stop the remaining batches. The current batch will finish, and ${noun} already deleted cannot be restored.`,
          confirmLabel: 'Cancel Deletion',
          keepLabel: 'Keep Deleting',
        },
      },
    );
    const items: NotificationItem[] = snapshot.map((id) => ({
      id,
      name: filenames[id] ?? id,
      state: 'pending',
      status: 'Pending',
    }));
    let completed = 0;
    let failed = 0;
    function update(
      kind: 'loading' | 'success' | 'error' | 'info',
      guidance?: string,
    ) {
      const cancelled = items.filter(
        (item) => item.state === 'cancelled',
      ).length;
      notice.update({
        message: `${completed} of ${snapshot.length} deleted${failed ? ` · ${failed} failed` : ''}${cancelled ? ` · ${cancelled} cancelled` : ''}`,
        kind,
        cancellable:
          !stopping && items.some((item) => item.state === 'pending'),
        guidance,
        items: items.map((item) => ({ ...item })),
        itemsLabel: 'Deletion items',
        persistent: failed + cancelled > 0,
      });
    }
    try {
      const result: DeleteResult = {
        deletedIds: [],
        alreadyRemovedIds: [],
        failed: [],
      };
      for (let offset = 0; offset < snapshot.length; offset += 100) {
        if (stopping) break;
        const batchItems = items.slice(offset, offset + 100);
        for (const item of batchItems) {
          item.state = 'active';
          item.status = 'Deleting';
        }
        update('loading');
        const batch = await action<DeleteResult>(actionName, {
          ids: snapshot.slice(offset, offset + 100),
        });
        if (operation.generation !== generation) {
          notify.dismiss(notice.id);
          return;
        }
        result.deletedIds.push(...batch.deletedIds);
        result.alreadyRemovedIds.push(...batch.alreadyRemovedIds);
        result.failed.push(...batch.failed);
        const failures = new Map(
          batch.failed.map((failure) => [failure.id, failure.message]),
        );
        const successful = new Set([
          ...batch.deletedIds,
          ...batch.alreadyRemovedIds,
        ]);
        for (const item of batchItems) {
          if (successful.has(item.id)) {
            item.state = 'completed';
            item.status = 'Deleted';
          } else if (failures.has(item.id)) {
            item.state = 'failed';
            item.status = 'Failed';
            item.error = failures.get(item.id);
          }
        }
        completed += successful.size;
        failed += batch.failed.length;
        for (const imageId of [...batch.deletedIds, ...batch.alreadyRemovedIds])
          removed.add(imageId);
        publish();
        update('loading');
      }
      if (operation.generation !== generation) {
        notify.dismiss(notice.id);
        return;
      }
      const successful = [...result.deletedIds, ...result.alreadyRemovedIds];
      for (const imageId of successful) removed.add(imageId);
      publish();
      update(
        result.failed.length > 0 ? 'error' : stopping ? 'info' : 'success',
        stopping
          ? `Deletion cancelled. Remaining ${noun} were kept and remain selected.`
          : result.failed.length > 0
            ? `Failed ${noun} remain selected.`
            : undefined,
      );
      try {
        await dashboard.refresh(true);
        if (operation.generation === generation)
          for (const imageId of successful) removed.delete(imageId);
      } catch {
        notify.error(
          'Deletion results saved, but the dashboard could not refresh. Please use Refresh.',
        );
      }
    } catch (error) {
      if (operation.generation === generation) {
        const message =
          error instanceof Error
            ? error.message
            : 'Deletion failed. Please try again.';
        for (const item of items)
          if (item.state === 'active') {
            item.state = 'failed';
            item.status = 'Failed';
            item.error = message;
            failed++;
          }
        update('error', message);
        await Promise.allSettled([dashboard.refresh(true)]);
      } else notify.dismiss(notice.id);
    } finally {
      if (operation.generation === generation) {
        for (const imageId of snapshot) pending.delete(imageId);
        publish();
      }
    }
  }

  return {
    state: imageDeletion,
    setOwner: setDeletionOwner,
    reconcile: reconcileDeletedImages,
    remove: deleteSelectedImages,
  };
}
const deletion = createDeletion('image-delete', 'images');
export const imageDeletion = deletion.state;
export const setDeletionOwner = deletion.setOwner;
export const reconcileDeletedImages = deletion.reconcile;
export const deleteSelectedImages = deletion.remove;
export const linkDeletion = createDeletion('alias-delete', 'share links');
