// Moonetix helpers built on Web Crypto. No imports, so the same file runs in Deno
// (Supabase Edge Functions) and in Node.js for the tests.
// Formats: https://docs.moonetix.com/offerwall-link and https://docs.moonetix.com/postbacks

export const WALL_BASE = 'https://wall.moonetix.com/'
export const USER_ID_RE = /^[A-Za-z0-9._@:+-]{1,100}$/
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SUB_ID_RE = /^[A-Za-z0-9._~:@+-]{1,100}$/
// Rewards are whole numbers or have a few decimals. The database column keeps 6.
export const AMOUNT_RE = /^\d{1,15}(?:\.\d{1,6})?$/

const encoder = new TextEncoder()

/** Reads a required secret. Throws when it is missing, so nothing is signed with an empty key. */
export function env(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not set`)
  return value
}

/** HMAC-SHA256 as lowercase hex. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison. Different lengths return false; equal lengths are compared in full. */
export function sameHash(given: string, expected: string): boolean {
  const a = encoder.encode(given)
  const b = encoder.encode(expected)
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export type SubIds = Partial<Record<'sub1' | 'sub2' | 'sub3' | 'sub4' | 'sub5', string>>

/** Builds the signed offerwall link for one user ID. Server side only. */
export async function buildWallLink(appId: string, linkSalt: string, userId: string, subs: SubIds = {}): Promise<string> {
  if (!appId || !linkSalt) throw new Error('MOONETIX_APP_ID and MOONETIX_LINK_SALT must be set')
  if (!USER_ID_RE.test(userId)) throw new Error('user ID not accepted by the offerwall')
  const hash = await hmacHex(linkSalt, userId)
  let url = `${WALL_BASE}${encodeURIComponent(appId)}?user_id=${encodeURIComponent(userId)}&hash=${hash}`
  for (const [key, value] of Object.entries(subs)) {
    if (/^sub[1-5]$/.test(key) && typeof value === 'string' && SUB_ID_RE.test(value)) {
      url += `&${key}=${encodeURIComponent(value)}`
    }
  }
  return url
}

export type Postback = { tx: string; user: string; reward: string; status: string; hash: string }
const KEYS = ['tx', 'user', 'reward', 'status', 'hash'] as const

/** Each signed parameter must arrive exactly once. ?tx=a&tx=b returns null. */
export function readPostback(sp: URLSearchParams): Postback | null {
  const p = {} as Postback
  for (const key of KEYS) {
    const values = sp.getAll(key)
    if (values.length !== 1) return null
    p[key] = values[0]
  }
  return p
}

/** The hash covers transaction_id:user_id:reward:status, exactly as received. */
export async function validHash(p: Postback, postbackKey: string): Promise<boolean> {
  const expected = await hmacHex(postbackKey, `${p.tx}:${p.user}:${p.reward}:${p.status}`)
  return sameHash(p.hash, expected)
}
