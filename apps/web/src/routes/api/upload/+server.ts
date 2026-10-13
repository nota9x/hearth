import { requireUser } from '@hearth/core/auth';
import { rateLimit } from '@hearth/core/security';
import { upload } from '@hearth/core/upload';
import type { RequestHandler } from '@sveltejs/kit';
import { waitUntil } from 'cloudflare:workers';

import { failure } from '#lib/server/http.ts';

export const POST: RequestHandler = async ({ request, locals }) => {
  try {
    const user = requireUser(locals.user);
    await rateLimit(locals.env.UPLOAD_LIMIT, user.id);
    const task = upload(request, user, locals.env);
    // Give abort/cleanup a bounded grace period if the client disconnects.
    // eslint-disable-next-line unicorn/prefer-await -- Register without delaying the HTTP response/error path.
    waitUntil(task.catch(() => {}));
    return Response.json(await task, { status: 201 });
  } catch (error) {
    return failure(error, locals.env.ENVIRONMENT);
  }
};
