'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const { openPostgresStore } = require('../lib/postgres-store');

test('PostgreSQL imports once, serializes writers and rolls back failures', {skip: process.env.TEST_POSTGRES !== '1'}, async t => {
  const url = process.env.LESSREPEAT_DATABASE_URL;
  assert.ok(url, 'LESSREPEAT_DATABASE_URL is required');
  const schema = 'lessrepeat_test_' + crypto.randomBytes(8).toString('hex');
  const first = await openPostgresStore(url, {items: [], count: 0}, schema);
  const second = await openPostgresStore(url, {items: ['must-not-import'], count: 99}, schema);
  t.after(async () => {
    await first.close(); await second.close();
    const pool = new Pool({connectionString: url});
    // Delete only the isolated, randomly named schema created by this test.
    await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end();
  });
  await first.transaction(d => {d.items.push('imported');});
  await Promise.all(Array.from({length: 20}, (_, i) => (i % 2 ? first : second).transaction(d => {d.count++;})));
  assert.deepEqual(await second.read(), {items: ['imported'], count: 20});
  await assert.rejects(first.transaction(d => {d.items.push('rollback'); throw new Error('planned failure');}), /planned failure/);
  assert.deepEqual(await first.read(), {items: ['imported'], count: 20});
  const restarted = await openPostgresStore(url, () => {throw new Error('The old JSON file must not be reread');}, schema);
  try {
    await restarted.transaction(d => {assert.equal(d.count,20);d.items.push({caller_name:'రవి शर्मा',reason:'NEET course जानकारी',callback_number:'0987654321',consent:false});});
    assert.deepEqual((await second.read()).items[1],{caller_name:'రవి शर्मा',reason:'NEET course जानकारी',callback_number:'0987654321',consent:false});
  } finally {await restarted.close();}
});
