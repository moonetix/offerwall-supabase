// Test vectors. By default they are signed here with the documented formulas.
// Set MOONETIX_GEN_CMD to a command that prints {"postback": url, "wall": url} for the arguments
// <template> <tx> <user> <reward> <status> <secret> <salt> <app_id> to test against another signer,
// for example the Moonetix postback code itself.

import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

// Obviously fake values. Never put real keys in tests.
export const APP = 'demoapp0000000000000001'
export const KEY = 'test_postback_key_not_secret'
export const SALT = 'test_link_salt_not_secret'
export const TEMPLATE =
  'https://example.supabase.co/functions/v1/moonetix-postback?tx={transaction_id}&user={user_id}&reward={reward}&status={status}&event={event_id}&offer={offer_name}&hash={hash}'

export function gen(tx: string, user: string, reward: string, status: 1 | 2, secret = KEY): { postback: string; wall: string } {
  const cmd = process.env.MOONETIX_GEN_CMD
  if (cmd) {
    const [bin, ...pre] = cmd.split(' ')
    const out = execFileSync(bin, [...pre, TEMPLATE, tx, user, reward, String(status), secret, SALT, APP], { encoding: 'utf8' })
    return JSON.parse(out)
  }
  const hash = crypto.createHmac('sha256', secret).update(`${tx}:${user}:${reward}:${status}`).digest('hex')
  const vars: Record<string, string> = {
    transaction_id: tx, user_id: user, reward, status: String(status), event_id: 'e1', offer_name: 'Demo offer', hash,
  }
  const postback = TEMPLATE.replace(/\{(\w+)\}/g, (_, k: string) => encodeURIComponent(vars[k] ?? ''))
  const wall = `https://wall.moonetix.com/${APP}?user_id=${encodeURIComponent(user)}&hash=${crypto.createHmac('sha256', SALT).update(user).digest('hex')}`
  return { postback, wall }
}
