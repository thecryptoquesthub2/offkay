# Offkay MVP

A working student-housing MVP with a direct account gate and four app tabs:

- Home
- Explore
- Messages
- Profile

It includes tenant and landlord roles, sign-up/sign-in, landlord-only property publishing with photo uploads, university filtering, approximate map mode, saved homes, roommate matching, messaging, inspection requests, private safety reports, split-payment booking, curated themes, and Paystack checkout payments with server-side verification. With no Paystack key configured, payment confirmation runs in a clearly-labeled sandbox mode; with a live key, real Paystack checkout is used.

## Run locally

Requires Node.js 20 or newer.

```powershell
npm install
node server.js
```

Open `http://127.0.0.1:4173` on the computer.

For mobile access, connect the phone and computer to the same Wi-Fi network, then open `http://YOUR-COMPUTER-IP:4173` on the phone. The server listens on the local network by default.

## Tests

The API is covered by an end-to-end smoke test that boots a disposable server on port 4599 with an isolated temp database, and a security/stress suite on port 4598 (traversal, brute force, XSS storage, IDOR, signup races, burst traffic):

```powershell
npm test
node scripts/security-test.js
```

## Data storage

Set `MONGODB_URI` in the environment and all app state (users, sessions, listings, messages, bookings) persists to MongoDB Atlas; each collection is stored separately with stable natural keys. Without it, the app falls back to a local JSON file in `data/`, which is used by tests and local runs.

On serverless hosting (Vercel), a missing `MONGODB_URI` is refused loudly: sign-up returns `503 — Offkay is not connected to a database, so new accounts cannot be saved…` instead of reporting a success it cannot keep (the old silent path produced "invalid credentials" on the next sign-in because each instance had its own throwaway data). `GET /api/health` reports `storage: "ephemeral"` so you can detect the misconfiguration programmatically.

## Password reset

The full recovery flow is built in: **Sign in → Forgot password? → email → reset link → new password (+ confirmation) → sign in**. Reset tokens are single-use, hashed at rest, expire after 30 minutes, and completing a reset signs the account out everywhere.

Delivery uses [Resend](https://resend.com). Set these variables (locally in `.env.local`, on Vercel in Project → Settings → Environment Variables, in Freebuff in Settings → Environment):

- `RESEND_API_KEY` — enables real email delivery. Without it, the server logs the reset link to the console (dev mode) and the response is flagged `devMode: true`.
- `RESEND_FROM` — optional sender, e.g. `Offkay <reset@yourdomain.com>`. Defaults to Resend's onboarding address, which only delivers to your own account email until a domain is verified in Resend.

`POST /api/auth/forgot` always answers 200 (even for unknown emails) so the endpoint cannot be used to discover who has an account.

## Google sign-in

"Continue with Google" uses the plain OAuth 2.0 authorization-code flow against Google's endpoints (no new dependencies). Set:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` — from [console.cloud.google.com](https://console.cloud.google.com/apis/credentials) → Create Credentials → OAuth client ID (Web application). Add `https://your-domain/api/auth/google/callback` as an Authorized redirect URI (for local runs: `http://127.0.0.1:4173/api/auth/google/callback`).

Sign-in matches an existing Offkay account by the Google account's verified email and links it (keeping the password working), so Google users never create duplicate accounts. New Google users get a tenant profile seeded with their Google name/email. Without these variables the button fails with a clear "not configured" message, and CSRF is guarded by a signed state cookie.

## Payments

Payments run through Paystack checkout. Set `PAYSTACK_SECRET_KEY` in the environment to enable it; without a key the app falls back to a clearly-labeled demo confirmation flow. The flow is: create booking → initialize transaction server-side → Paystack hosted checkout → `/payment-callback.html` verifies the transaction server-side (amount-checked) → booking marked paid. A signed webhook (`POST /api/payments/webhook`) is also supported — point it at `https://your-domain/api/payments/webhook` in the Paystack dashboard as a backup confirmation path.

## Vercel deployment

The repository includes a Vercel serverless adapter for the API. Because serverless instances have an ephemeral filesystem, set these environment variables in Vercel (Project → Settings → Environment Variables) and redeploy:

- `MONGODB_URI` — MongoDB Atlas connection string (required for persistence; a fresh deployment starts with an empty database, which is intentional — no demo content is seeded)
- `PAYSTACK_SECRET_KEY` — enables real Paystack checkout (test or live key)

### Health check / DB diagnostics

Open `https://your-vercel-url/api/health` in a browser (or `curl` it). It is public and reveals no secrets: it reports the storage mode, whether payments are enabled, and — if the Atlas connection fails — the exact driver error code (for example `ETIMEDOUT`, `ENOTFOUND`, or `bad auth`) with the matching fix hint. Use it to confirm network access, credentials, and the cluster hostname before retesting sign-in.
