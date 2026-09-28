import { defineConfig } from 'drizzle-kit';

// `drizzle-kit generate` only diffs the schema file and needs no live database.
// Migrations are applied with `pnpm db:migrate` (src/migrate.ts), which validates env first.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './migrations',
  strict: true,
  verbose: true,
});
