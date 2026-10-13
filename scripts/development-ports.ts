import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { projects, root } from './development-config';

const run = promisify(execFile);

export async function portAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

type ProcessInfo = { pid: number; parent: number; command: string };
function isService(command: string) {
  return command
    .replaceAll('\\', '/')
    .includes(
      path.join(root, 'scripts/development-service.ts').replaceAll('\\', '/'),
    );
}

function isWrangler(command: string) {
  const normalized = command.replaceAll('\\', '/');
  return (
    normalized.includes(`${root.replaceAll('\\', '/')}/node_modules/`) &&
    /\sdev(?:\s|$)/.test(normalized) &&
    Object.values(projects).some((directory) =>
      normalized.includes(`${directory}/wrangler.jsonc`),
    )
  );
}

export async function findDevelopmentServer(
  port: number,
): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const [{ stdout: sockets }, { stdout: processes }] = await Promise.all([
      run('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }),
      run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name = 'workerd.exe'\" | Select-Object @{n='pid';e={$_.ProcessId}}, @{n='parent';e={$_.ParentProcessId}}, @{n='command';e={$_.CommandLine}} | ConvertTo-Json -Compress",
        ],
        { windowsHide: true },
      ),
    ]);
    const listeners = new Set(
      sockets
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/))
        .filter(
          (fields) =>
            fields[3] === 'LISTENING' && fields[1].endsWith(`:${port}`),
        )
        .map((fields) => Number(fields[4])),
    );
    const parsed = processes
      ? (JSON.parse(processes) as ProcessInfo | ProcessInfo[])
      : [];
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const listener of listeners) {
      let entry = list.find((candidate) => candidate.pid === listener);
      while (entry) {
        if (isWrangler(entry.command)) return entry.pid;
        const parent = list.find(
          (candidate) => candidate.pid === entry?.parent,
        );
        if (
          parent &&
          isService(entry.command) &&
          /scripts[\\/](?:development|preview)\.ts(?:[\s"]|$)/.test(
            parent.command,
          )
        )
          return parent.pid;
        entry = parent;
      }
    }
    return;
  }
  const { stdout: sockets } = await run('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]);
  for (const listener of sockets.trim().split(/\s+/)) {
    let pid = Number(listener);
    while (pid > 1) {
      const { stdout } = await run('ps', [
        '-p',
        String(pid),
        '-o',
        'ppid=,args=',
      ]);
      const match = /^\s*(\d+)\s+(.+)$/m.exec(stdout);
      if (!match) {
        pid = 0;
        continue;
      }
      if (isWrangler(match[2])) return pid;
      const parent = Number(match[1]);
      if (isService(match[2])) {
        const { stdout: command } = await run('ps', [
          '-p',
          String(parent),
          '-o',
          'args=',
        ]);
        if (/scripts\/(?:development|preview)\.ts(?:\s|$)/.test(command))
          return parent;
      }
      pid = parent;
    }
  }
}

export async function stopDevelopmentServer(pid: number, port: number) {
  if (await portAvailable(port)) return;
  if ((await findDevelopmentServer(port)) !== pid)
    throw new Error(
      `The owner of port ${port} changed. Restart the local server.`,
    );
  if (process.platform === 'win32')
    await run('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
    });
  else process.kill(pid, 'SIGTERM');
  const deadline = performance.now() + 17_000;
  while (performance.now() < deadline) {
    if (await portAvailable(port)) return;
    await delay(200);
  }
  throw new Error(
    `Port ${port} is still occupied after stopping the local server.`,
  );
}
