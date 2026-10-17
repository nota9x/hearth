import { parseArgs } from 'node:util';

import type { ArgsDef } from 'citty';

// Citty accepts unknown options and keeps only the last repeated string value.
// Validate declared options strictly, retaining repeated delivery hostnames.
export function validateOptions(rawArguments: string[], definitions: ArgsDef) {
  const options: Record<
    string,
    { type: 'string' | 'boolean'; multiple?: boolean }
  > = {};
  for (const [name, definition] of Object.entries(definitions)) {
    if (definition.type === 'positional') continue;
    const option = {
      type:
        definition.type === 'boolean'
          ? ('boolean' as const)
          : ('string' as const),
      multiple: true,
    };
    options[name] = option;
    for (const alias of [
      ('alias' in definition ? definition.alias : []) ?? [],
    ].flat())
      options[alias] = option;
  }
  const normalized = rawArguments.map((argument) => {
    return argument.startsWith('--no-') &&
      options[argument.slice(5)]?.type === 'boolean'
      ? `--${argument.slice(5)}`
      : argument;
  });
  const result = parseArgs({
    args: normalized,
    options,
    allowPositionals: true,
  });
  if (
    result.positionals.length > 0 &&
    Object.values(definitions).every(
      (definition) => definition.type !== 'positional',
    )
  )
    throw new Error(`Unexpected positional argument: ${result.positionals[0]}`);
  return result.values;
}

export function reportError(error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode ||= 1;
}
