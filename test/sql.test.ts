// Runs the migration on PGlite (PostgreSQL compiled to WebAssembly) and checks the crediting
// function, the grants and Row Level Security. Then it replays signed postbacks through the
// real handler, with rpc() going to that database as service_role.
// Run: npm install && npm run test:sql
// Limit: PGlite has one connection, so parallel calls are serialized. The advisory lock and the
// unique key are what protect a multi-connection server.

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { handlePostback, type Rpc } from '../supabase/functions/_shared/postback.ts'
import { KEY, gen } from './vectors.ts'

const MIGRATION = new URL('../supabase/migrations/20261111000000_moonetix_rewards.sql', import.meta.url)
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const NOBODY = '33333333-3333-4333-8333-333333333333'

// The parts of a Supabase database the migration relies on.
const SUPABASE_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public, auth to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`

let db: PGlite

before(async () => {
  db = new PGlite()
  await db.exec(SUPABASE_STUB)
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@example.com')`)
  await db.exec(fs.readFileSync(MIGRATION, 'utf8'))
  await db.exec(`insert into auth.users (id, email) values ('${B}', 'b@example.com')`)
})

async function apply(tx: string, user: string, reward: string, status: 1 | 2): Promise<string> {
  const r = await db.query<{ r: string }>(
    'select public.moonetix_apply_event($1, $2::uuid, $3::numeric, $4::smallint) as r', [tx, user, reward, status])
  return r.rows[0].r
}
async function coins(user: string): Promise<string> {
  const r = await db.query<{ coins: string }>('select coins::text as coins from public.wallets where user_id = $1', [user])
  return r.rows[0]?.coins ?? 'none'
}
async function asRole<T>(role: string, sub: string | null, fn: () => Promise<T>): Promise<T> {
  await db.exec(`set role ${role}`)
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub ?? ''])
  try {
    return await fn()
  } finally {
    await db.exec('reset role')
  }
}

test('wallets exist for users created before and after the migration', async () => {
  assert.equal(await coins(A), '0.000000')
  assert.equal(await coins(B), '0.000000')
})

test('credit, repeat, reversal, repeated reversal', async () => {
  assert.equal(await apply('tx_1', A, '150', 1), 'credited')
  assert.equal(await apply('tx_1', A, '150', 1), 'duplicate')
  assert.equal(await coins(A), '150.000000')
  assert.equal(await apply('tx_1', A, '150', 2), 'reversed')
  assert.equal(await apply('tx_1', A, '150', 2), 'duplicate')
  assert.equal(await coins(A), '0.000000')
})

test('decimals are exact', async () => {
  await apply('tx_d1', B, '0.1', 1)
  await apply('tx_d2', B, '0.2', 1)
  await apply('tx_d3', B, '1.23456', 1)
  assert.equal(await coins(B), '1.534560')
})

test('reversal before credit records a zero row and blocks the late credit', async () => {
  assert.equal(await apply('tx_r', A, '50', 2), 'not_credited')
  assert.equal(await apply('tx_r', A, '50', 1), 'duplicate')
  assert.equal(await coins(A), '0.000000')
})

test('a reversal uses the stored user and amount', async () => {
  await apply('tx_s', A, '100', 1)
  assert.equal(await apply('tx_s', B, '999', 2), 'reversed')
  assert.equal(await coins(A), '0.000000')
  assert.equal(await coins(B), '1.534560')
})

test('unknown users and negative rewards change nothing', async () => {
  assert.equal(await apply('tx_u', NOBODY, '10', 1), 'unknown_user')
  const rows = await db.query(`select 1 from public.coin_ledger where transaction_id = 'tx_u'`)
  assert.equal(rows.rows.length, 0)
  await assert.rejects(apply('tx_n', A, '-5', 1), /zero or positive/)
})

test('20 copies at once credit once', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => apply('tx_p', A, '315', 1)))
  assert.equal(results.filter((r) => r === 'credited').length, 1)
  assert.equal(await coins(A), '315.000000')
})

test('the unique key refuses a second credit row even without the function', async () => {
  await assert.rejects(db.query(`insert into public.coin_ledger (user_id, transaction_id, status, amount) values ('${A}', 'tx_p', 1, 1)`), /duplicate key/)
})

test('RLS: a user reads only their own wallet and ledger', async () => {
  const wallets = await asRole('authenticated', A, () => db.query<{ user_id: string }>('select user_id from public.wallets'))
  assert.deepEqual(wallets.rows.map((r) => r.user_id), [A])
  const ledger = await asRole('authenticated', A, () => db.query<{ user_id: string }>('select distinct user_id from public.coin_ledger'))
  assert.deepEqual(ledger.rows.map((r) => r.user_id), [A])
  const anon = await asRole('anon', null, () => db.query('select * from public.wallets'))
  assert.equal(anon.rows.length, 0)
})

test('grants: clients cannot write balances or run the crediting function', async () => {
  for (const role of ['authenticated', 'anon']) {
    await assert.rejects(asRole(role, A, () => db.query(`update public.wallets set coins = 1000000 where user_id = '${A}'`)), /permission denied/)
    await assert.rejects(asRole(role, A, () => db.query(`insert into public.coin_ledger (user_id, transaction_id, status, amount) values ('${A}', 'x', 1, 1)`)), /permission denied/)
    await assert.rejects(asRole(role, A, () => apply('tx_hack', A, '1000', 1)), /permission denied/)
  }
  assert.equal(await asRole('service_role', null, () => apply('tx_sr', B, '1', 1)), 'credited')
})

// The real handler, with rpc() running the function as service_role, like supabaseAdmin does.
const rpc: Rpc = async (_fn, args) => {
  try {
    const data = await asRole('service_role', null, () => apply(args.p_tx, args.p_user, args.p_reward, args.p_status as 1 | 2))
    return { data, error: null }
  } catch (err) {
    return { data: null, error: { message: (err as Error).message } }
  }
}
async function deliver(url: string): Promise<number> {
  const res = await handlePostback(new Request(url), { postbackKey: KEY, creditTestPostbacks: false, rpc, log: () => {} })
  return res.status
}

test('signed postbacks through the handler into PostgreSQL', async () => {
  const start = await coins(B)
  assert.equal(start, '2.534560')
  assert.equal(await deliver(gen('tx_h1', B, '0.375', 1).postback), 200)
  assert.equal(await deliver(gen('tx_h1', B, '0.375', 1).postback), 200)
  assert.equal(await coins(B), '2.909560')
  assert.equal(await deliver(gen('tx_h1', B, '0.375', 1).postback.replace('reward=0.375', 'reward=375')), 403)
  assert.equal(await deliver(gen('tx_h1', B, '0.375', 2).postback), 200)
  assert.equal(await coins(B), '2.534560')
  assert.equal(await deliver(gen('test_x', B, '5', 1).postback), 200)
  assert.equal(await coins(B), '2.534560')
  const codes = await Promise.all(Array.from({ length: 10 }, () => deliver(gen('tx_h2', B, '7', 1).postback)))
  assert.deepEqual([...new Set(codes)], [200])
  assert.equal(await coins(B), '9.534560')
})
