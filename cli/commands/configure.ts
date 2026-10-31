import { writeFile } from 'node:fs/promises';

import { defineCommand } from 'citty';

import { reportError, validateOptions } from '../options.ts';
import { renderProduction } from '../production-config.ts';

const argumentsDefinition = {
  application: {
    type: 'string',
    required: true,
    description: 'Application hostname.',
  },
  delivery: {
    type: 'string',
    description: 'Delivery hostname; repeat for additional hostnames.',
  },
  database: { type: 'string', required: true, description: 'D1 database ID.' },
  bucket: { type: 'string', required: true, description: 'R2 bucket name.' },
  turnstile: {
    type: 'string',
    required: true,
    description: 'Turnstile site key.',
  },
} as const;
export default defineCommand({
  meta: {
    name: 'configure',
    description:
      'Write production configuration without overwriting existing files.',
  },
  args: argumentsDefinition,
  async run({ rawArgs, args: values }) {
    try {
      const repeated = validateOptions(rawArgs, argumentsDefinition);
      const outputs = await renderProduction({
        application: values.application ?? '',
        delivery: (repeated.delivery ?? []) as string[],
        databaseId: values.database ?? '',
        bucket: values.bucket ?? '',
        turnstile: values.turnstile ?? '',
      });
      for (const output of outputs) {
        await writeFile(output.path, output.content, { flag: 'wx' });
        console.log(`Created ${output.path}`);
      }
      console.log(
        'Add delivery hostnames in Hearth, validate them, and select a primary domain after deploying.',
      );
    } catch (error) {
      reportError(error);
    }
  },
});
