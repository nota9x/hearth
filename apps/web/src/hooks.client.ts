import { httpErrorContent } from '@hearth/core/http-error';
import type { HandleClientError } from '@sveltejs/kit';

export const handleError: HandleClientError = ({ status }) => ({
  message: httpErrorContent(status).heading,
});
