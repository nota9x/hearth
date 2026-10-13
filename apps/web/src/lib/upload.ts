import { z } from 'zod';

import { ActionError } from './client';

const resultSchema = z.object({
  id: z.string(),
  url: z.url().nullable(),
  sharingWarning: z.string().nullable(),
});
export type UploadResult = z.infer<typeof resultSchema>;

export interface TransferProgress {
  loaded: number;
  total: number;
}
export class UploadRateLimit extends Error {
  constructor() {
    super('Upload rate limit reached. Waiting before retrying.');
  }
}

// XHR measures request-body bytes, including multipart framing, not R2/D1 progress.
export function uploadImage(
  file: File,
  key: string,
  signal: AbortSignal,
  progress: (value: TransferProgress) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'));
      return;
    }
    const xhr = new XMLHttpRequest();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let stalled = false;
    let settled = false;
    const abort = () => xhr.abort();
    const cleanup = () => {
      settled = true;
      clearTimeout(idleTimer);
      signal.removeEventListener('abort', abort);
    };
    const activity = () => {
      if (settled) return;
      clearTimeout(idleTimer);
      // Bound inactivity, not total duration: slow transfers may keep making progress.
      idleTimer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, 120_000);
    };
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.upload.addEventListener('progress', (event) => {
      if (settled) return;
      activity();
      if (event.lengthComputable && event.total > 0)
        progress({
          loaded: Math.min(event.loaded, event.total),
          total: event.total,
        });
    });
    xhr.addEventListener('load', () => {
      cleanup();
      if (xhr.status === 429) {
        reject(new UploadRateLimit());
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(resultSchema.parse(JSON.parse(xhr.responseText)));
        } catch {
          reject(
            new Error(
              'The saved upload response could not be read. Retry safely to check its outcome.',
            ),
          );
        }
      } else {
        try {
          const result = z
            .object({
              error: z.object({
                message: z.string(),
                code: z.string().optional(),
              }),
            })
            .parse(JSON.parse(xhr.responseText));
          const message =
            result.error.code === 'QUOTA_EXCEEDED'
              ? 'Not enough storage in your quota for this image. Delete some images or ask an administrator to increase your quota.'
              : result.error.code === 'GLOBAL_STORAGE_LIMIT_EXCEEDED'
                ? 'Not enough instance storage for this image. Please try again later or contact an administrator.'
                : result.error.message;
          reject(new ActionError(message, xhr.status, result.error.code));
        } catch {
          reject(new Error('Upload failed. Please try again.'));
        }
      }
    });
    xhr.addEventListener('error', () => {
      cleanup();
      reject(new Error('Connection lost. Retry safely to check the upload.'));
    });
    xhr.addEventListener('abort', () => {
      cleanup();
      if (stalled) {
        reject(
          new Error(
            'Upload stalled for two minutes. Retry safely to check the upload.',
          ),
        );
        return;
      }
      reject(
        new DOMException(
          'Transfer stopped. The server may already have saved this image.',
          'AbortError',
        ),
      );
    });
    xhr.addEventListener('timeout', () => {
      cleanup();
      reject(new Error('Upload timed out. Retry safely to check the upload.'));
    });
    signal.addEventListener('abort', abort, { once: true });
    try {
      const form = new FormData();
      form.append('file', file);
      activity();
      xhr.send(form);
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('Upload failed.'));
    }
  });
}
