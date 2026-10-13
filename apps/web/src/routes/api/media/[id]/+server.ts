import { requireUser } from '@hearth/core/auth';
import { idSchema } from '@hearth/core/common';
import { ownedImage } from '@hearth/core/images';
import { serveObject } from '@hearth/core/media';
import type { RequestHandler } from '@sveltejs/kit';

import { failure } from '#lib/server/http.ts';

export const GET: RequestHandler<{ id: string }> = async ({
  request,
  locals,
  params,
  url,
}) => {
  try {
    const image = await ownedImage(
      locals.env.DB,
      requireUser(locals.user),
      idSchema.parse(params.id),
    );
    // Serve GIF originals even if an older maintenance run created a still preview.
    const preview =
      image.mime !== 'image/gif' &&
      !url.searchParams.has('download') &&
      url.searchParams.has('preview') &&
      image.previewKey;
    return serveObject(
      locals.env.BUCKET,
      preview || image.objectKey,
      request,
      preview ? 'image/webp' : image.mime,
      image.filename,
      true,
    );
  } catch (error) {
    return failure(error, locals.env.ENVIRONMENT);
  }
};
export const HEAD = GET;
