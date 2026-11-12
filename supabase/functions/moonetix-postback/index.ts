// Supabase Edge Function: receives Moonetix postbacks (credits and reversals).
// verify_jwt is off for this function in supabase/config.toml. The HMAC is the access check.
// Postback URL for your Moonetix dashboard (Postback page):
// https://<project-ref>.supabase.co/functions/v1/moonetix-postback?tx={transaction_id}&user={user_id}&reward={reward}&status={status}&hash={hash}

import { withSupabase } from 'npm:@supabase/server@1.9.2'
import { handlePostback } from '../_shared/postback.ts'

export default {
  fetch: withSupabase({ auth: 'none', cors: 'disabled' }, (req, ctx) =>
    handlePostback(req, {
      postbackKey: Deno.env.get('MOONETIX_POSTBACK_KEY'),
      creditTestPostbacks: Deno.env.get('MOONETIX_CREDIT_TEST_POSTBACKS') === 'true',
      // supabaseAdmin uses your secret key (service_role), the only role allowed to run the function.
      rpc: (fn, args) => ctx.supabaseAdmin.rpc(fn, args),
    })),
}
