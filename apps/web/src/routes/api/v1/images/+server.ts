import { authenticateKey } from '@hearth/core/auth';
import { digest } from '@hearth/core/digest';
import { rateLimit } from '@hearth/core/security';
import { upload } from '@hearth/core/upload';
import { json, type RequestHandler } from '@sveltejs/kit';

import { failure } from '$lib/server/http';

export const POST: RequestHandler = async ({ request, locals, platform }) => {
  try {
    const key =
      /^Bearer\s+(\S+)$/i.exec(
        request.headers.get('authorization') || '',
      )?.[1] || '';
    let authenticated;
    try {
      authenticated = await authenticateKey(locals.env.DB, key);
    } catch (error) {
      await rateLimit(
        locals.env.LOGIN_LIMIT,
        await digest(
          request.headers.get('cf-connecting-ip') || 'local',
          'api-attempt',
        ),
      );
      throw error;
    }
    await rateLimit(locals.env.UPLOAD_LIMIT, authenticated.user.id);
    const task = upload(request, authenticated.user, locals.env, 'bearer');
    // eslint-disable-next-line unicorn/prefer-await -- Cleanup must also run after a client disconnect.
    platform?.context.waitUntil(task.catch(() => {}));
    const result = await task;
    return json(
      result.url
        ? result
        : {
            ...result,
            error: {
              code: 'IMAGE_SAVED_WITHOUT_LINK',
              message: `Image already saved (${result.id}), but no share link could be created. ${result.sharingWarning} Do not re-upload the file; create a link from Images after configuring delivery.`,
            },
          },
      { status: result.url ? 201 : 409 },
    );
  } catch (error) {
    return failure(error, locals.env.ENVIRONMENT);
  }
};
