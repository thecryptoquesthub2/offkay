# Offkay MVP

A working student-housing MVP with a direct account gate and four app tabs:

- Home
- Explore
- Messages
- Profile

It includes tenant and landlord roles, sign-up/sign-in, landlord-only property publishing with photo uploads, university filtering, approximate map mode, saved homes, roommate matching, messaging, inspection requests, private safety reports, split-payment booking, curated themes, and Paystack checkout payments with server-side verification (a demo confirmation flow runs when no Paystack key is configured).

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

## Demo accounts

- Tenant: `tenant@demo.test` / `demo1234`
- Landlord: `landlord@demo.test` / `demo1234`

## Data storage

Set `MONGODB_URI` in the environment and all app state (users, sessions, listings, messages, bookings) persists to MongoDB Atlas; each collection is stored separately with stable natural keys. Without it, the app falls back to a local JSON file in `data/`, which is used by tests and local runs.

## Payments

Payments run through Paystack checkout. Set `PAYSTACK_SECRET_KEY` in the environment to enable it; without a key the app falls back to a clearly-labeled demo confirmation flow. The flow is: create booking → initialize transaction server-side → Paystack hosted checkout → `/payment-callback.html` verifies the transaction server-side (amount-checked) → booking marked paid. A signed webhook (`POST /api/payments/webhook`) is also supported — point it at `https://your-domain/api/payments/webhook` in the Paystack dashboard as a backup confirmation path.

## Vercel deployment

The repository includes a Vercel serverless adapter for the API. Because serverless instances have an ephemeral filesystem, set these environment variables in Vercel (Project → Settings → Environment Variables) and redeploy:

- `MONGODB_URI` — MongoDB Atlas connection string (required for persistence; without it every cold start re-seeds a fresh database)
- `PAYSTACK_SECRET_KEY` — enables real Paystack checkout (test or live key)

### Health check / DB diagnostics

Open `https://your-vercel-url/api/health` in a browser (or `curl` it). It is public and reveals no secrets: it reports the storage mode, whether payments are enabled, and — if the Atlas connection fails — the exact driver error code (for example `ETIMEDOUT`, `ENOTFOUND`, or `bad auth`) with the matching fix hint. Use it to confirm network access, credentials, and the cluster hostname before retesting sign-in.
