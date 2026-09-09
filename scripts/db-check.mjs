/** Confirms DATABASE_URL reaches the Neon branch. Run: node --env-file=.env.local scripts/db-check.mjs */
import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL);
const [row] = await sql`select version(), current_database() as db`;
const [{ count }] = await sql`select count(*)::int as count from information_schema.tables where table_schema='public'`;

console.log('connected');
console.log('  ', row.version.split(',')[0]);
console.log('   database:', row.db);
console.log('   public tables:', count);
