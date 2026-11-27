# Jack’s Wishlists

Run `npm start` with Node.js 22.12 or later, then visit `http://127.0.0.1:3000`. Local accounts and carts are saved in `.wishlist-data/`. Each browser tab has its own sign-in session, which lasts up to 12 hours. Accounts and carts persist across sessions.

Passwords require at least four characters, with no app-imposed maximum. Existing PINs still work as passwords.

If port 3000 is busy, open that URL first to see whether the wishlist is already running. If another app is using it, run `$env:PORT = '3001'; npm start` in PowerShell and open `http://127.0.0.1:3001`.

## Add a wishlist

Add an entry to [wishlists.json](wishlists.json), then restart the local server or redeploy to Vercel. Each list has a unique URL-safe `id`, a `title`, and an array of `categories`. The list can also include an `occasion` label, cover `image`, and `sizing` guide. Categories have their own `id`, `title`, and `items`. Each item needs a globally unique, stable `id` and a `title`. Use a numeric `price` or `null` if the price is unavailable. Set `priority` to `top`, `high`, `regular`, or `low`. Images are optional for categories and items. Put any new WebP or JPEG files in `images/` and use lowercase filenames. The home page, category navigation, and page routes update from the catalogue.

## Deploy to Vercel

1. Create a Neon Postgres database for the wishlist, for example through the [Vercel Marketplace integration](https://vercel.com/marketplace/neon). Run [db/001_wishlist.sql](db/001_wishlist.sql) in the database’s SQL editor. This schema can be applied again safely.
2. Import this repository as a Vercel project using the root directory. [vercel.json](vercel.json) sets the build command, static output directory, and Node functions. Vercel serves both the frontend and the API on the same HTTPS site.
3. Use the `NEON_DATABASE_URL` variable created by the Neon integration, or set `DATABASE_URL` manually. Add a sensitive environment variable named `WISHLIST_PASSWORD_SECRET`. Generate its value with `node -p "require('node:crypto').randomBytes(32).toString('base64url')"`. Keep that value stable across redeployments because the server uses it to verify passwords. Use a separate database for preview deployments if you enable them.
4. Deploy, then open the Vercel URL and create a wishlist account. The Postgres database starts fresh. Existing localhost and ChatGPT Sites accounts and carts stay in their original databases.

The hosted catalogue checks for shared cart changes about every two seconds while the tab is visible. Passwords have a four-character minimum. Vercel’s request size limit also applies to sign-in requests.

### Self-hosting the Node version

Run a single Node process with a persistent volume behind an HTTPS reverse proxy. Set `NODE_ENV=production`, `WISHLIST_ORIGIN` to the public HTTPS origin without a trailing slash, `WISHLIST_DB` to the database file on that volume, and `WISHLIST_PIN_SECRET` to a stable random 32-byte secret encoded as base64url. Keep the secret in the host’s secret store and back up the database and secret separately. The server binds to loopback on port 3000 by default. Set `PORT` to change it.

Have the proxy overwrite `X-Forwarded-Proto` with the actual request scheme and `X-Wishlist-Client-IP` with the actual client address. Disable response buffering and compression for `/api/cart/live` so updates reach browsers immediately. The site uses a server and persistent storage, so a static-only host cannot run it.
