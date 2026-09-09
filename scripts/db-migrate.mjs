/**
 * Applies db/*.sql in filename order, tracking what has run.
 *
 * Migrations are plain SQL rather than an ORM's generated files: the schema is
 * small, and being able to read exactly what will hit the database matters more
 * than tooling here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from '@neondatabase/serverless';

// The HTTP driver (neon()) sends one statement per request, so a migration file
// with several statements cannot run as one transaction. Pool speaks real
// Postgres over a websocket and can.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const sql = async (strings, ...values) => {
  const text = strings.reduce((acc, s, i) => acc + s + (i < values.length ? `$${i + 1}` : ''), '');
  return (await pool.query(text, values)).rows;
};

await sql`create table if not exists _migrations (
  name text primary key,
  applied_at timestamptz not null default now()
)`;

const applied = new Set((await sql`select name from _migrations`).map((r) => r.name));
const files = readdirSync('db').filter((f) => f.endsWith('.sql')).sort();

let ran = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`  skip  ${file}`);
    continue;
  }
  const text = readFileSync(join('db', file), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(text);
    await client.query('insert into _migrations (name) values ($1)', [file]);
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    console.error(`
Failed on ${file}:
  ${e.message}
`);
    process.exit(1);
  } finally {
    client.release();
  }
  console.log(`  apply ${file}`);
  ran++;
}

console.log(ran ? `\n${ran} migration(s) applied.` : '\nUp to date.');
