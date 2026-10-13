import { requireUser } from '@hearth/core/auth';
import type { RequestHandler } from '@sveltejs/kit';

import { failure } from '#lib/server/http.ts';

export const GET: RequestHandler = ({ locals }) => {
  try {
    const user = requireUser(locals.user);
    return Response.json(
      {
        status: user.onboardingUploadStatus,
        imageId: user.onboardingUploadImageId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return failure(error, locals.env.ENVIRONMENT);
  }
};
