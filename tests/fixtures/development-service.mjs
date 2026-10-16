/* eslint-disable unicorn/no-process-exit -- Disposable CLI fixture exercises exit codes and output drainage. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const component = process.argv[2];
const scenario = process.env.HEARTH_DEV_TEST_SCENARIO;
const port = Number(process.argv[process.argv.lastIndexOf('--port') + 1]);
const server = createServer((_request, response) => response.end('ready'));
console.log(`booting ${component}`);
console.error(`diagnostic ${component}`);
if (scenario === 'hang' && component === 'web') {
  spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { createServer } from 'node:net'; createServer().listen(0, '127.0.0.1', function () { console.log('descendant port ' + this.address().port); });",
    ],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
}
process.on('SIGTERM', () => {
  if (scenario === 'hang' && component === 'web') return;
  server.close(() =>
    process.stderr.write(`final diagnostic ${component}`, () =>
      process.exit(0),
    ),
  );
});
setTimeout(
  () => {
    if (scenario === 'failure' && component === 'delivery') {
      process.stderr.write('startup failure detail', () => process.exit(7));
      return;
    }
    if (scenario === 'timeout' && component === 'web') return;
    server.listen(port, '127.0.0.1', () =>
      process.send?.(JSON.stringify({ event: 'DEV_SERVER_READY', port })),
    );
    if (scenario === 'late-exit' && component === 'delivery')
      setTimeout(() => process.exit(7), 1000);
  },
  1000 + { web: 350, delivery: 20, maintenance: 150 }[component],
);
