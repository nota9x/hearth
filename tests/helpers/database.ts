import { readdir, readFile } from 'node:fs/promises';

async function migrationStatements(file: string) {
  const source = await readFile(`drizzle/${file}`, 'utf8');
  const statements =
    file === '0001_invariants.sql'
      ? source
          .split(/^CREATE TRIGGER /m)
          .slice(1)
          .map((statement) => 'CREATE TRIGGER ' + statement)
      : source.split('--> statement-breakpoint');
  return statements.filter((statement) => statement.trim());
}

export async function applyMigration(binding: D1Database, file: string) {
  const statements = await migrationStatements(file);
  await binding.batch(
    statements.map((statement) => binding.prepare(statement)),
  );
}

export async function migrateDatabase(binding: D1Database, through?: string) {
  const entries = await readdir('drizzle');
  const files = entries.filter((file) => file.endsWith('.sql'));
  files.sort((a, b) => a.localeCompare(b));
  const statements: string[] = [];
  for (const file of files) {
    statements.push(...(await migrationStatements(file)));
    if (file === through) break;
  }
  await binding.batch(
    statements.map((statement) => binding.prepare(statement)),
  );
}
