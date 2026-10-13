import { httpErrorContent } from '@hearth/core/http-error';
import type { HandleClientError } from '@sveltejs/kit/hooks';

export const handleError: HandleClientError = ({ error, kind }) => {
  const status = kind === 'unknown' ? 500 : error.status;
  return { status, message: httpErrorContent(status).heading };
};
