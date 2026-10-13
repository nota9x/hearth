export function filename(value: string) {
  return (
    [...value.split(/[\\/]/).at(-1)!]
      .filter(
        (character) =>
          character.codePointAt(0)! >= 32 && character.codePointAt(0) !== 127,
      )
      .slice(0, 240)
      .join('') || 'image'
  );
}
export function downloadFilename(value: string) {
  let name = filename(value)
    .replaceAll(/[<>:"|?*\uD800-\uDFFF]/gu, '_')
    .replace(/[. ]+$/, '');
  if (!name || name === '.') name = 'image';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  return name;
}

export function archiveFilenames(names: string[]) {
  const used = new Set(['download-errors.txt']);
  return names.map((value) => {
    const name = downloadFilename(value);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    let unique = name;
    let number = 2;
    while (used.has(unique.normalize('NFC').toLowerCase()))
      unique = `${stem} (${number++})${extension}`;
    used.add(unique.normalize('NFC').toLowerCase());
    return unique;
  });
}
export async function serveObject(
  bucket: R2Bucket,
  key: string,
  request: Request,
  mime: string,
  name: string,
  privateResponse = false,
) {
  const object = await bucket.get(key, {
    onlyIf: request.headers,
    range: request.headers.has('range') ? request.headers : undefined,
  });
  if (!object)
    return new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  const headers = new Headers({
    'Content-Type': mime,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': privateResponse
      ? 'private, no-store'
      : 'public, max-age=0, must-revalidate',
    ETag: object.httpEtag,
    'Accept-Ranges': 'bytes',
    'Content-Disposition': `${new URL(request.url).searchParams.has('download') ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(downloadFilename(name)).replaceAll(/['()*]/g, (character) => `%${character.codePointAt(0)!.toString(16).toUpperCase()}`)}`,
  });
  if (!('body' in object))
    return new Response(null, {
      status:
        request.headers.has('if-match') ||
        request.headers.has('if-unmodified-since')
          ? 412
          : 304,
      headers,
    });
  let status = 200;
  if (
    request.headers.has('range') &&
    object.range &&
    'offset' in object.range &&
    typeof object.range.offset === 'number' &&
    'length' in object.range &&
    typeof object.range.length === 'number'
  ) {
    status = 206;
    headers.set(
      'Content-Range',
      `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`,
    );
    headers.set('Content-Length', String(object.range.length));
  } else headers.set('Content-Length', String(object.size));
  return new Response(request.method === 'HEAD' ? null : object.body, {
    status,
    headers,
  });
}
