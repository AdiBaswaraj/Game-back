const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

let supabase;

if (!url || !key) {
  supabase = new Proxy(
    {},
    {
      get() {
        throw new Error(
          'Supabase is not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)'
        );
      },
    }
  );
} else {
  supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = supabase;
