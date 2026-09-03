'use strict';

// A transactional collection store preserves existing IDs and JSON shapes during
// migration. A transaction-wide lock serializes read/modify/write across replicas.
const { Pool } = require('pg');

async function openPostgresStore(connectionString, initialState, schema = 'lessrepeat') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid storage schema');
  const pool = new Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000 });
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.collections (name text PRIMARY KEY, payload jsonb NOT NULL)`);
  } catch (error) { await pool.end(); throw error; }
  async function transaction(change) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
      const rows = (await client.query(`SELECT name, payload FROM ${schema}.collections`)).rows;
      const state = rows.length ? Object.fromEntries(rows.map(row => [row.name, row.payload])) : (typeof initialState === 'function' ? initialState() : structuredClone(initialState));
      const result = change(state);
      if (result && typeof result.then === 'function') throw new Error('Storage mutations must be synchronous');
      for (const [name, payload] of Object.entries(state)) {
        await client.query(`INSERT INTO ${schema}.collections(name,payload) VALUES($1,$2::jsonb) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload`, [name, JSON.stringify(payload)]);
      }
      await client.query('COMMIT');
      return { state, result };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  return {
    transaction,
    async read() {
      const rows = (await pool.query(`SELECT name,payload FROM ${schema}.collections`)).rows;
      return rows.length ? Object.fromEntries(rows.map(row => [row.name, row.payload])) : null;
    },
    close: () => pool.end(),
  };
}
module.exports = { openPostgresStore };
