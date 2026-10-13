export function instanceName(value?: string | null) {
  return value?.trim() || 'hearth';
}
export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const brandStyles = `
.brand-mark{display:inline-flex;align-items:baseline;gap:var(--brand-gap,11px);min-width:0;max-width:100%;font-family:'Bitter Variable',Georgia,serif;font-weight:700;letter-spacing:-.06em}
.brand-mark__flame{display:block;width:.93em;height:.815em;flex-shrink:0;transform:translateY(.035em);color:var(--accent)}
.brand-mark__wordmark{min-width:0;overflow-wrap:anywhere}
.brand-mark__dot{color:var(--accent)}
`;

// Lucide Flame, ISC License. Copyright (c) 2026 Lucide Icons and Contributors.
// Permission to use, copy, modify, and/or distribute this software for any
// purpose with or without fee is hereby granted, provided that the above
// copyright notice and this permission notice appear in all copies.
// THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
// WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
// MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
// ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
// WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
// ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
// OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
const flame =
  '<svg class="brand-mark__flame" viewBox="0 2 24 21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3q1 4 4 6.5t3 5.5a1 1 0 0 1-14 0 5 5 0 0 1 1-3 1 1 0 0 0 5 0c0-2-1.5-3-1.5-5q0-2 2.5-4" /></svg>';

export function renderBrand(name?: string | null) {
  return `<span class="brand-mark">${flame}<span class="brand-mark__wordmark"><span class="brand-mark__name">${escapeHtml(instanceName(name))}</span><span class="brand-mark__dot" aria-hidden="true">.</span></span></span>`;
}
