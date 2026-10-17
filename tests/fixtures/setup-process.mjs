import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [mode, value] = process.argv.slice(2);
if (mode === 'wait') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  await writeFile(value, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  console.log(
    JSON.stringify({
      input,
      args: process.argv.slice(2),
      diskLogs: process.env.WRANGLER_WRITE_LOGS,
      ...(mode === 'environment' && {
        apiToken: process.env.CLOUDFLARE_API_TOKEN ?? null,
        legacyToken: process.env.CF_API_TOKEN ?? null,
      }),
    }),
  );
  if (mode === 'fail') process.exitCode = 1;
}
