import { execFileSync } from 'node:child_process';

// Lefthook's Windows shell loses embedded quotes when constructing its command line.
if (process.platform === 'win32') {
  const paths = execFileSync(
    'git',
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
    { encoding: 'utf8' },
  ).split('\0');
  const unsafe = paths.filter(
    (path) =>
      /\.(?:js|mjs|cjs|ts|svelte|json|jsonc|html|css|md|yml|yaml)$/.test(
        path,
      ) && /['\r\n]/.test(path),
  );
  if (unsafe.length > 0)
    throw new Error(
      `Lefthook cannot safely quote these staged paths on Windows: ${unsafe.map((path) => JSON.stringify(path)).join(', ')}. Rename them without apostrophes or line breaks before committing. No formatter has run.`,
    );
}
