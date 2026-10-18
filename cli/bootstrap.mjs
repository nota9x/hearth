import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(
  await readFile(path.join(root, 'package.json'), 'utf8'),
);
const major = Number(process.versions.node.split('.', 1)[0]);
if (major !== 24 && major < 26) {
  console.error(
    `Hearth requires Node 24 or 26+. Install Node 24, then rerun pnpm run cli. Current: ${process.version}`,
  );
  process.exitCode = 1;
} else {
  process.chdir(root);
  const dependencies = [
    'citty',
    '@clack/prompts',
    'execa',
    'tsx/esm/api',
    'wrangler',
    'typescript',
    'zod',
  ];
  const missing = [];
  for (const name of dependencies) {
    try {
      import.meta.resolve(name);
      const expected = manifest.devDependencies[name];
      if (expected && /^\d+\.\d+\.\d+$/.test(expected)) {
        const installed = JSON.parse(
          await readFile(
            path.join(root, 'node_modules', name, 'package.json'),
            'utf8',
          ),
        );
        if (installed.version !== expected) missing.push(`${name}@${expected}`);
      }
    } catch {
      missing.push(name);
    }
  }
  let ready = missing.length === 0;
  while (!ready && process.stdin.isTTY) {
    const prompt = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answer;
    try {
      answer = await prompt.question(
        `Hearth dependencies are missing (${missing.join(', ')}). Install the locked dependencies with ${manifest.packageManager}? [Y/n] `,
      );
    } finally {
      prompt.close();
    }
    if (answer.trim() && answer.trim().toLowerCase() !== 'y') break;
    const manager = process.env.npm_execpath;
    if (!manager) {
      console.error(
        'Run pnpm install --frozen-lockfile, then rerun your Hearth command.',
      );
      break;
    }
    let status;
    try {
      const { execa } = await import('execa');
      const result = await execa(manager, ['install', '--frozen-lockfile'], {
        stdio: 'inherit',
        reject: false,
      });
      status = result.exitCode;
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      status = await new Promise((resolve, reject) => {
        const script = /\.[cm]?js$/i.test(manager);
        const child = spawn(
          script ? process.execPath : manager,
          [...(script ? [manager] : []), 'install', '--frozen-lockfile'],
          { stdio: 'inherit', shell: false },
        );
        child.once('error', reject);
        child.once('exit', resolve);
      });
    }
    ready = status === 0;
    if (!ready)
      console.error(
        'Installation failed. Correct the package-manager error, then retry here. Supply-chain policies remain enabled.',
      );
  }
  if (ready) {
    const { register } = await import('tsx/esm/api');
    register();
    await import('./index.ts');
  } else {
    console.error(
      'Dependencies are required. Run pnpm install --frozen-lockfile, then rerun your Hearth command.',
    );
    process.exitCode = 1;
  }
}
