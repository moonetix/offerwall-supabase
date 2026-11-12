// Supabase Edge Function: returns the signed offerwall link of the signed-in user.
// The user ID comes from the verified JWT, never from the request.
// From your app: const { data } = await supabase.functions.invoke('offerwall-link')

import { withSupabase } from 'npm:@supabase/server@1.9.2'
import { buildWallLink, env } from '../_shared/moonetix.ts'

export default {
  fetch: withSupabase({ auth: 'user' }, async (_req, ctx) => {
    const url = await buildWallLink(env('MOONETIX_APP_ID'), env('MOONETIX_LINK_SALT'), ctx.userClaims!.id, { sub1: 'supabase' })
    return Response.json({ url }, { headers: { 'Cache-Control': 'private, no-store' } })
  }),
}
