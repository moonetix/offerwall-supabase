// Pure logic: link signing, hash check, parameter parsing, and the handler with a recorded rpc().
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWallLink, hmacHex, readPostback, sameHash, validHash } from '../supabase/functions/_shared/moonetix.ts'
import { handlePostback, type Rpc } from '../supabase/functions/_shared/postback.ts'
import { APP, KEY, SALT, gen } from './vectors.ts'

const UID = '0b5e1c2a-7d4f-4e8a-9c3b-2f1d6a8e4b70'

test('wall link matches the Moonetix link for the same user ID', async () => {
  for (const user of [UID, '42', 'a.b_c@d:e+f-g']) {
    assert.equal(await buildWallLink(APP, SALT, user), gen('tx', user, '1', 1).wall)
  }
  assert.equal(await buildWallLink(APP, SALT, UID, { sub1: 'supabase', sub2: 'bad value' }), gen('tx', UID, '1', 1).wall + '&sub1=supabase')
})

test('wall link refuses bad user IDs and missing keys', async () => {
  await assert.rejects(buildWallLink(APP, SALT, ''))
  await assert.rejects(buildWallLink(APP, SALT, 'a b'))
  await assert.rejects(buildWallLink(APP, '', UID))
})

test('Web Crypto HMAC equals the documented HMAC-SHA256 hex', async () => {
  assert.equal(await hmacHex(KEY, 'tx_1001:42:150:1'), new URL(gen('tx_1001', '42', '150', 1).postback).searchParams.get('hash'))
})

test('sameHash compares in full and does not throw on other lengths', () => {
  assert.equal(sameHash('abc', 'abc'), true)
  assert.equal(sameHash('abc', 'abd'), false)
  assert.equal(sameHash('ab', 'abc'), false)
  assert.equal(sameHash('', ''), true)
})

test('real postbacks pass, tampered ones fail', async () => {
  const url = gen('tx_1001', UID, '150', 1).postback
  const ok = readPostback(new URL(url).searchParams)
  assert.ok(ok && (await validHash(ok, KEY)))
  for (const [reward, status] of [['0.375', 1], ['0.75', 2], ['1.23456', 1]] as const) {
    const p = readPostback(new URL(gen('tx_d', UID, reward, status).postback).searchParams)
    assert.ok(p && (await validHash(p, KEY)), reward)
  }
  const bad = [
    url.replace('reward=150', 'reward=1500'),
    url.replace('status=1', 'status=2'),
    url.replace('tx=tx_1001', 'tx=tx_1002'),
    url.replace(/hash=([0-9a-f]+)/, (_, h: string) => 'hash=' + h.toUpperCase()),
    url.replace(/hash=[0-9a-f]+/, 'hash=abc'),
    gen('tx_1001', UID, '150', 1, 'other_key').postback,
  ]
  for (const u of bad) {
    const p = readPostback(new URL(u).searchParams)
    assert.ok(p)
    assert.equal(await validHash(p, KEY), false, u)
  }
})

test('missing and repeated parameters are refused', () => {
  const url = gen('tx_1001', UID, '150', 1).postback
  assert.equal(readPostback(new URL(url.replace(/&hash=[0-9a-f]+/, '')).searchParams), null)
  assert.equal(readPostback(new URL(url + '&tx=x').searchParams), null)
})

function recorder(result: { data?: unknown; error?: { message: string } | null } = { data: 'credited' }) {
  const calls: Parameters<Rpc>[1][] = []
  const rpc: Rpc = async (_fn, args) => {
    calls.push(args)
    return { data: result.data ?? null, error: result.error ?? null }
  }
  return { calls, rpc }
}
const quiet = () => {}
async function run(url: string, opts: Partial<{ key: string | undefined; tests: boolean; method: string; rpc: Rpc }> = {}) {
  const r = opts.rpc ? { calls: [], rpc: opts.rpc } : recorder()
  const res = await handlePostback(new Request(url, { method: opts.method ?? 'GET' }), {
    postbackKey: 'key' in opts ? opts.key : KEY,
    creditTestPostbacks: opts.tests ?? false,
    rpc: r.rpc,
    log: quiet,
  })
  return { status: res.status, calls: r.calls }
}

test('handler: a valid credit calls rpc once with the values as strings', async () => {
  const r = await run(gen('tx_1', UID, '0.375', 1).postback)
  assert.equal(r.status, 200)
  assert.deepEqual(r.calls, [{ p_tx: 'tx_1', p_user: UID, p_reward: '0.375', p_status: 1 }])
})

test('handler: refusals never reach the database', async () => {
  const url = gen('tx_1', UID, '150', 1).postback
  assert.deepEqual(await run(url, { method: 'POST' }), { status: 405, calls: [] })
  assert.deepEqual(await run(url.replace('reward=150', 'reward=151')), { status: 403, calls: [] })
  assert.deepEqual(await run(url + '&tx=tx_2'), { status: 403, calls: [] })
  assert.deepEqual(await run(url.replace(/hash=[0-9a-f]+/, 'hash=1')), { status: 403, calls: [] })
  assert.deepEqual(await run(url, { key: undefined }), { status: 500, calls: [] })
  assert.deepEqual(await run(url, { key: 'another_key' }), { status: 403, calls: [] })
})

test('handler: signed but unusable values', async () => {
  assert.equal((await run(gen('tx_1', UID, '150', 3 as 1).postback)).status, 400)
  assert.deepEqual(await run(gen('tx_1', 'test_user', '150', 1).postback), { status: 200, calls: [] })
})

test('handler: test_ postbacks are logged only, unless crediting tests is turned on', async () => {
  const url = gen('test_abc', UID, '10', 1).postback
  assert.deepEqual(await run(url), { status: 200, calls: [] })
  assert.equal((await run(url, { tests: true })).calls.length, 1)
})

test('handler: a database error answers 500 so Moonetix retries', async () => {
  const r = recorder({ error: { message: 'connection refused' } })
  assert.equal((await run(gen('tx_9', UID, '5', 1).postback, { rpc: r.rpc })).status, 500)
})
