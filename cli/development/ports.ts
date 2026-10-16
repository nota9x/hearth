import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { root } from '../project';

export async function portAvailable(port: number) {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

type ProcessInfo = { pid: number; parent: number; command: string | null };
function isService(command: string | null) {
  const file = path.join(root, 'cli/development/tool-process.mjs');
  return (
    command?.includes(pathToFileURL(file).href) ||
    command?.replaceAll('\\', '/').includes(file.replaceAll('\\', '/'))
  );
}
function isLauncher(command: string | null, owned: boolean) {
  const normalized = (command ?? '').replaceAll('\\', '/');
  return (
    (normalized.includes(`${root.replaceAll('\\', '/')}/scripts/cli.mjs`) ||
      (owned &&
        /(?:^|[\s"])(?:\.\.\/)*scripts\/cli\.mjs[\s"]/.test(normalized))) &&
    /\s(?:dev|preview)(?:\s|$)/.test(normalized)
  );
}

export async function findDevelopmentServer(
  port: number,
): Promise<number | undefined> {
  if (process.platform === 'win32') {
    const [{ stdout: sockets }, { stdout: processes }] = await Promise.all([
      execa('netstat', ['-ano', '-p', 'tcp'], { windowsHide: true }),
      execa(
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
      let owned = false;
      while (entry) {
        owned ||= Boolean(isService(entry.command));
        if (isLauncher(entry.command, owned)) return entry.pid;
        const parent = list.find(
          (candidate) => candidate.pid === entry?.parent,
        );
        entry = parent;
      }
    }
    return;
  }
  const { stdout: sockets } = await execa('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]);
  for (const listener of sockets.trim().split(/\s+/)) {
    let pid = Number(listener);
    let owned = false;
    while (pid > 1) {
      const { stdout } = await execa('ps', [
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
      owned ||= Boolean(isService(match[2]));
      if (isLauncher(match[2], owned)) return pid;
      const parent = Number(match[1]);
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
    await execa('taskkill', ['/PID', String(pid), '/T', '/F'], {
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
