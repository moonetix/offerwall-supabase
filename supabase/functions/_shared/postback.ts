// The postback handler without any Supabase import, so it can be tested with a stand-in database.
// moonetix-postback/index.ts wires it to the real database through supabase-js rpc().

import { AMOUNT_RE, UUID_RE, readPostback, validHash } from './moonetix.ts'

export type RpcResult = { data: unknown; error: { message: string } | null }
export type Rpc = (fn: 'moonetix_apply_event', args: {
  p_tx: string
  p_user: string
  p_reward: string
  p_status: number
}) => PromiseLike<RpcResult>

export type Deps = {
  postbackKey: string | undefined
  creditTestPostbacks: boolean
  rpc: Rpc
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
}

const reply = (status: number) => new Response(null, { status })

export async function handlePostback(req: Request, deps: Deps): Promise<Response> {
  const log = deps.log ?? ((level, message, data) => console[level](message, data ?? ''))
  if (req.method !== 'GET') return reply(405)

  // 1. Hash first, on the values exactly as they arrived.
  const p = readPostback(new URL(req.url).searchParams)
  if (!p) return reply(403)
  if (!deps.postbackKey) {
    // Fail closed: 500 makes Moonetix retry once the secret is set.
    log('error', 'moonetix: MOONETIX_POSTBACK_KEY is not set')
    return reply(500)
  }
  if (!(await validHash(p, deps.postbackKey))) return reply(403)

  // 2. Signed values that make no sense: a retry would not fix them.
  if ((p.status !== '1' && p.status !== '2') || !AMOUNT_RE.test(p.reward) || p.tx === '' || p.tx.length > 255) {
    log('warn', 'moonetix: postback with unexpected values', { tx: p.tx, status: p.status, reward: p.reward })
    return reply(400)
  }

  // 3. Dashboard tests have a transaction ID that starts with test_. Logged only, unless you opt in.
  if (p.tx.startsWith('test_') && !deps.creditTestPostbacks) {
    log('info', 'moonetix: test postback (not credited)', { tx: p.tx, status: p.status, user: p.user })
    return reply(200)
  }

  // 4. Our user IDs are Supabase Auth UUIDs. Anything else is not one of our users.
  if (!UUID_RE.test(p.user)) {
    log('warn', 'moonetix: postback for a user ID that is not a UUID, ignored', { tx: p.tx, user: p.user })
    return reply(200)
  }

  // 5. One rpc() call is one database transaction. 2xx only after it committed.
  const { data, error } = await deps.rpc('moonetix_apply_event', {
    p_tx: p.tx,
    p_user: p.user,
    p_reward: p.reward, // a string, so the numeric column gets it without floating point
    p_status: Number(p.status),
  })
  if (error) {
    log('error', 'moonetix: postback failed', { tx: p.tx, error: error.message })
    return reply(500)
  }
  log('info', 'moonetix: postback', { tx: p.tx, status: p.status, result: data })
  return reply(200)
}
