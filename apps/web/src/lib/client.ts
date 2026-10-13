import { z } from 'zod';

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function action<Result = Record<string, unknown>>(
  name: string,
  input: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(
      'The server returned an unexpected response. Check the site address and try again.',
      { cause: error },
    );
  }
  if (!response.ok) {
    const result = z
      .object({
        error: z.object({ message: z.string(), code: z.string().optional() }),
      })
      .safeParse(data);
    throw new ActionError(
      result.success
        ? result.data.error.message
        : 'The request failed. Please try again.',
      response.status,
      result.success ? result.data.error.code : undefined,
    );
  }
  return z.record(z.string(), z.unknown()).parse(data) as Result;
}
export function downloadConfig(config: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = 'Hearth.sxcu';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
