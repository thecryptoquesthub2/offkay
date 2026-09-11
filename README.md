# Offkay MVP

A working student-housing MVP with a direct account gate and four app tabs:

- Home
- Explore
- Messages
- Profile

It includes tenant and landlord roles, sign-up/sign-in, landlord-only property publishing with photo uploads, university filtering, approximate map mode, saved homes, roommate matching, messaging, inspection requests, private safety reports, split-payment booking, curated themes, and Paystack checkout payments with server-side verification (a demo confirmation flow runs when no Paystack key is configured).

## Run locally

Requires Node.js 20 or newer. No package installation is needed.

```powershell
node server.js
```

Open `http://127.0.0.1:4173` on the computer.

For mobile access, connect the phone and computer to the same Wi-Fi network, then open `http://YOUR-COMPUTER-IP:4173` on the phone. The server listens on the local network by default.

## Tests

The API is covered by an end-to-end smoke test that boots a disposable server on port 4599 with an isolated temp database:

```powershell
npm test
```

## Demo accounts

- Tenant: `tenant@demo.test` / `demo1234`
- Landlord: `landlord@demo.test` / `demo1234`

## Launch boundary

The data store is a local JSON file for immediate MVP operation. Before public deployment, move users, listings, conversations, and bookings to a managed database.

## Payments

Payments run through Paystack checkout. Set `PAYSTACK_SECRET_KEY` in the environment to enable it; without a key the app falls back to a clearly-labeled demo confirmation flow. The flow is: create booking → initialize transaction server-side → Paystack hosted checkout → `/payment-callback.html` verifies the transaction server-side (amount-checked) → booking marked paid. A signed webhook (`POST /api/payments/webhook`) is also supported — point it at `https://your-domain/api/payments/webhook` in the Paystack dashboard as a backup confirmation path.

## Vercel preview

The repository includes a Vercel serverless adapter for the API. Vercel's filesystem is read-only, so the deployed build starts with the seeded data but cannot retain newly created accounts, listings, messages, or bookings between function instances. Use a managed database before public launch.
