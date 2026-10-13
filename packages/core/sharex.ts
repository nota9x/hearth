import { z } from 'zod';

import { parseKey } from './crypto';
import { appUrl } from './public-urls';

export const sxcuSchema = z.object({
  Version: z.literal('21.0.0'),
  Name: z.string(),
  DestinationType: z.literal('ImageUploader, FileUploader'),
  RequestMethod: z.literal('POST'),
  RequestURL: z.url(),
  Headers: z.object({ Authorization: z.string() }),
  Body: z.literal('MultipartFormData'),
  FileFormName: z.literal('file'),
  URL: z.literal('{json:url}'),
  DeletionURL: z.literal('{json:deleteUrl}'),
  ErrorMessage: z.literal('{json:error.message}'),
});
export function sharexConfig(origin: string, key: string) {
  parseKey(key);
  return sxcuSchema.parse({
    Version: '21.0.0',
    Name: 'Hearth',
    DestinationType: 'ImageUploader, FileUploader',
    RequestMethod: 'POST',
    RequestURL: appUrl({ APP_ORIGIN: origin }, '/api/v1/images'),
    Headers: { Authorization: `Bearer ${key}` },
    Body: 'MultipartFormData',
    FileFormName: 'file',
    URL: '{json:url}',
    DeletionURL: '{json:deleteUrl}',
    ErrorMessage: '{json:error.message}',
  });
}
