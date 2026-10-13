import { notify } from './notifications';

export async function copyText(text: string, message = 'Link copied') {
  try {
    await navigator.clipboard.writeText(text);
    notify.success(message);
    return true;
  } catch {
    notify.error('Copy failed. Select and copy the text.');
    return false;
  }
}
