# PokerOut — Home Games, Simplified.

A mobile-first web app for home poker games: players join with a code, the host approves buy-ins and rebuys, and at the end PokerOut checks that the money balances, ranks the table and works out the fewest payments needed to settle.

This folder is the complete, deployable app: a static front-end hosted on **Vercel**, with a **Supabase** backend (Postgres database + realtime updates).

```
deploy/
├── index.html              the app
├── pokerout-core.js        maths + settlement engine + backend client
├── support.js              UI runtime
├── sw.js                   service worker (PWA / offline shell)
├── manifest.webmanifest    PWA manifest
├── assets/                 logo, app icons, link-preview image
├── supabase/schema.sql     database tables, security rules, server functions
├── scripts/build.mjs       writes config.json from env vars at build time
├── vercel.json             routing (/join/1234), caching, security headers
└── .env.example            the environment variables you need
```

---

## 1. Create the backend (Supabase), about 5 minutes

1. Go to **https://supabase.com** → sign in → **New project**.
   - Name: `pokerout` · Region: the one closest to your players (e.g. *Mumbai* for India) · set a database password.
2. When it's ready, open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`, and click **Run**. You should see "Success. No rows returned".
   This creates the tables (`games`, `players`, `transactions`, `final_stacks`, `settlements`), locks them with Row Level Security, and adds the server functions the app calls.
3. Open **Project Settings → API** and copy:
   - **Project URL** → this is `SUPABASE_URL`
   - **anon / public** key → this is `SUPABASE_ANON_KEY`
   - ⚠️ Do **not** copy the `service_role` key anywhere. The app never needs it.
4. Realtime: nothing to set up. PokerOut uses Realtime *broadcast* on public channels, which is on by default. If you've turned on "Private channels only" under **Realtime → Settings**, turn it off. The app also re-syncs every 5 seconds as a fallback.

## 2. Environment variables

| Variable | Required | Where it comes from |
|---|---|---|
| `SUPABASE_URL` | yes | Supabase → Project Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | yes | Supabase → Project Settings → API → `anon` `public` key |
| `SITE_URL` | optional | Your final address, e.g. `https://pokerout.app`, used for WhatsApp/iMessage link previews. On Vercel this falls back to your production URL automatically. |

These are public values. The anon key can only call PokerOut's server functions, and those check every request. The build fails if you paste a `service_role` key by mistake.

## 3. Deploy the front-end (Vercel), about 5 minutes

**Option A: GitHub (recommended, so updates deploy automatically)**
1. Put the contents of this `deploy/` folder at the root of a new GitHub repository.
2. Go to **https://vercel.com/new** → import the repo.
3. Framework preset: **Other**. Leave the build and output settings alone, because `vercel.json` sets them.
4. Under **Environment Variables**, add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (and `SITE_URL` if you have a domain) for **Production** and **Preview**.
5. Click **Deploy**. You'll get a URL like `https://pokerout.vercel.app`.

**Option B: Vercel CLI**
```bash
cd deploy
npm i -g vercel
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
vercel --prod
```

After changing environment variables, redeploy. They're baked into `config.json` at build time.

## 4. Connect your own domain (optional)

1. Buy the domain (e.g. `pokerout.app`) from any registrar.
2. Vercel → your project → **Settings → Domains** → add `pokerout.app` (and `www.pokerout.app`).
3. Add the DNS records Vercel shows you at your registrar (an `A` record to `76.76.21.21`, or a `CNAME` to `cname.vercel-dns.com`). HTTPS is issued automatically.
4. Set `SITE_URL=https://pokerout.app` and redeploy, so link previews use the new domain.

Invite links follow whatever domain the app is opened on (`https://pokerout.app/join/2461`). Nothing is hard-coded.

## 5. Install as an app (PWA)

The PWA works automatically once it's served over HTTPS, which Vercel provides.
- **Android (Chrome):** open the site → menu **⋮** → **Install app** / **Add to Home screen**.
- **iPhone (Safari):** open the site → **Share** → **Add to Home Screen**.
It opens full-screen with the PokerOut icon, and the app shell loads instantly on repeat visits. Game data always comes live from the backend.

## 6. Test the production version

Use three devices (or one normal and two private/incognito windows; each window counts as a separate phone):

1. **A (host):** open the URL → Create game → note the code; the Share sheet shows a QR code and `…/join/CODE` link.
2. **B, C:** scan the QR / open the link / type the code → enter a username → Join.
3. **A:** approve B and C. **B, C:** Buy in. **A:** approve both buy-ins → **Start game**.
4. **B:** Request rebuy (try ₹475) → **A:** approve → check every device shows the new total.
5. **A:** End session. **A, B, C:** enter final stacks that add up to the total money in.
   Try a wrong total first and confirm settlement stays locked.
6. **A:** Settle up → everyone sees the leaderboard, then View settlement → mark payments paid.
7. **Refresh every device.** Each one returns to the same game and state. Close a tab, reopen the URL, same result.

## How it works

- **No accounts.** Joining gives each device a random secret for that seat, stored in the browser. Every change goes through a server function that checks the secret and the player's role.
- **Server-enforced rules:** only the host approves players, buy-ins and rebuys; players can only enter their own stack; nothing can change after settlement; buy-ins are validated in ₹100 steps, rebuys can be any whole-rupee amount; settlement is only accepted if it exactly reproduces every player's Net P/L.
- **Live updates:** after any change, the app broadcasts a "changed" signal on the game's channel and every open phone re-fetches. A 5-second poll covers dropped connections.
- **Game codes** are 4 digits, unique among active games, and expire after 3 days. Settled games stay readable to their players.
- **Single-device preview mode:** if `config.json` is missing or empty, the app runs entirely in the browser (localStorage). Use it only for design previews. Production always uses Supabase.

## Housekeeping

- Old games: `schema.sql` ends with an optional cron job that deletes games older than 60 days (enable **Database → Extensions → pg_cron** first).
- Supabase's free tier is plenty for many home games; projects pause after a week of no activity. Upgrade or just open the dashboard to wake it.

## Updating the app

`index.html` is generated from the design file `PokerOut.dc.html`. After design changes, regenerate `deploy/index.html` and copy the latest `pokerout-core.js`, then push. Vercel redeploys automatically.
