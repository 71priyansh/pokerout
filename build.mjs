// Build step for PokerOut (runs on Vercel, or locally with `npm run build`).
// 1) Writes config.json with the PUBLIC Supabase URL + anon key from env vars.
// 2) Stamps the site URL into the Open Graph tags in index.html.
// Never put the Supabase service_role key here — it must not reach the browser.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';

// If files were uploaded flat (no folders), put them where the app expects them.
const DS = '_ds/organic-2b16b2ba-9c60-4425-a3e5-afe815227d75';
const place = { 'assets': ['apple-touch-icon.png','icon-192.png','icon-512.png','icon-maskable-512.png','og.png','pokerout-logo.jpg'], [DS]: ['styles.css','_ds_bundle.js'] };
for (const [dir, files] of Object.entries(place)) {
  mkdirSync(dir, { recursive: true });
  for (const f of files) {
    const dest = dir + '/' + f;
    if (!existsSync(dest) && existsSync(f)) { copyFileSync(f, dest); console.log('placed', dest); }
    if (!existsSync(dest)) console.warn('⚠  missing ' + f);
  }
}

const env = process.env;
const supabaseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('\n⚠  SUPABASE_URL / SUPABASE_ANON_KEY are not set — the app will run in single-device preview mode.\n');
} else if (/service_role/.test(Buffer.from((supabaseAnonKey.split('.')[1] || ''), 'base64').toString())) {
  console.error('\n✖  SUPABASE_ANON_KEY looks like a service_role key. Use the anon/public key instead.\n');
  process.exit(1);
}
writeFileSync('config.json', JSON.stringify({ supabaseUrl, supabaseAnonKey }, null, 2));

const site = (env.SITE_URL || (env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + env.VERCEL_PROJECT_PRODUCTION_URL : '')).replace(/\/$/, '');
let html = readFileSync('index.html', 'utf8');
html = html.replace(/__SITE_URL__/g, site);
writeFileSync('index.html', html);

console.log('✓ PokerOut build ready', site ? `(${site})` : '(relative URLs)');
