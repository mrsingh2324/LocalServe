# LocalServe MVP

LocalServe is a QR-based hyperlocal ordering app for solo food vendors. This repository implements the MVP from the BRD, PRD, tech-stack document, and static customer-flow prototype.

## What is included

- Customer PWA storefront at `/v/ravi-canteen`
- Vendor console at `/vendor`
- QR code generation plus visible vendor storefront URL
- Downloadable print-quality QR PNG
- Vendor shop onboarding/profile form
- Menu browsing with item photos, cart, notification contact capture, and test UPI checkout
- Human-readable 2-letter + 4-digit order code
- Live customer order tracking
- Vendor live order queue with Socket.io updates
- Mark preparing, ready, and collected
- Menu availability toggles
- Vendor dashboard with order count and revenue
- Downloadable PDF receipts for vendor orders
- Notification outbox for ready-order emails
- Express API with MVP endpoints matching the PRD
- Mongoose models for the production MongoDB data model
- Docker Compose for local MongoDB and Redis
- JWT-capable vendor auth and rate-limited onboarding endpoint
- Razorpay webhook signature verification scaffold
- Local JSON persistence fallback for orders, menu, and vendor profile

## Run locally

Install dependencies:

```bash
npm install
```

Start the API:

```bash
npm run dev:api
```

Start the web app in a second terminal:

```bash
npm run dev:web
```

Open:

- Customer storefront: `http://localhost:5173/v/ravi-canteen`
- Vendor console: `http://localhost:5173/vendor`
- API health: `http://localhost:4000/health`

Optional local infrastructure:

```bash
docker compose up -d
```

Run the API against MongoDB instead of the local JSON fallback:

```bash
npm run dev:mongo --workspace @localserve/api
```

MongoDB Atlas:

1. Create an Atlas cluster and database user.
2. Add your current IP in Atlas Network Access.
3. Put your Atlas URI in `apps/api/.env` as `MONGODB_URI`.
4. Set `USE_MONGO=true`.
5. Start the API with `npm run dev:mongo --workspace @localserve/api`.

Demo vendor logins:

- Ravi's Canteen: `+919876543210` / `demo123`
- Meera Tea Point: `+919812345670` / `demo123`

## CI/CD

GitHub Actions workflow: `.github/workflows/ci-cd.yml`.

On pull requests and pushes to `main`, CI installs dependencies, typechecks the workspaces, runs the API tests, and builds both the API and web app.

On pushes to `main`, the API is containerized with `apps/api/Dockerfile`, pushed to Google Artifact Registry, and deployed to Google Cloud Run.

Required GitHub repository secrets:

- `GCP_PROJECT_ID`
- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`
- `MONGODB_URI`
- `JWT_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`

The workflow syncs the runtime secrets into Google Secret Manager before deploying Cloud Run.

The GitHub Actions service account needs permission to push Artifact Registry images, create/update Secret Manager secrets, and deploy Cloud Run services.

Recommended GitHub repository variables:

- `GCP_REGION`, defaults to `asia-south1`
- `GAR_REPOSITORY`, defaults to `localserve`
- `CLOUD_RUN_SERVICE`, defaults to `localserve-api`
- `PUBLIC_APP_URL`, for example the Vercel production URL
- `CORS_ORIGIN`, for example the same Vercel production URL

The frontend is prepared for Vercel through `vercel.json`. In Vercel, set `VITE_API_URL` to the Cloud Run API URL.

## MVP notes

The payment provider, OTP, SendGrid, and MongoDB persistence are represented with production-shaped interfaces and test-mode behavior so the full order lifecycle can run locally without external credentials. The API currently writes runtime data to `apps/api/data/localserve.json` unless `USE_MONGO=true` is set.
