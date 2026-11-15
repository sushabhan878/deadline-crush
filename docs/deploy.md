# Deploy a judging instance

The [Render Blueprint](../render.yaml) builds the web UI and serves it from the same origin as the API. It runs the background worker in the web service container and uses managed PostgreSQL. The provided Dockerfile installs Poppler and runs the app as a non-root user. A free Render service can sleep, and its free database expires. [Render free-tier limits](https://render.com/docs/free)

1. In Cloudflare, create a private R2 bucket in the Standard storage class. Create an **Object Read & Write** API token scoped to that bucket. Enter the bucket's S3 endpoint as `S3_ENDPOINT` and its name and key pair as `S3_BUCKET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY`. The Blueprint supplies `S3_REGION=auto`. For `S3_ENDPOINT`, use the HTTPS S3 API endpoint shown by Cloudflare, such as `https://<account-id>.r2.cloudflarestorage.com`. [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/) · [Token permissions](https://developers.cloudflare.com/r2/api/tokens/)
2. In Render, create a Blueprint from this GitHub repository. Supply an event join code, a future ISO UTC deadline, and a private organizer login. Share the join code with judges privately. Bootstrapping is idempotent and preserves an existing deadline or organizer account.
3. Add the exact Render app origin to the [R2 CORS policy](#r2-cors-policy). An optional lifecycle rule can abort incomplete multipart uploads after one day. [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
4. Open `/api/healthz` and the in-app Status page. Create a test team, save project details, upload a ZIP with a README, and confirm the accepted receipt and preview. Sign in as organizer and export CSV. Use the resulting service URL in the hackathon submission.

## R2 CORS policy

In the bucket's **Settings → CORS Policy**, add the rule below. For local verification, add `http://localhost:5173` to `AllowedOrigins` and use that exact origin as `WEB_ORIGIN`. [Cloudflare CORS instructions](https://developers.cloudflare.com/r2/buckets/cors/)

```json
[
  {
    "AllowedOrigins": ["https://YOUR-SERVICE.onrender.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

## Verify R2 locally before deploying

Use a dedicated private test bucket and an empty, migrated test database. The test writes fixture objects and database rows. Save the settings below in `.env.r2`, which Git ignores. Keep the real keys in this file or your secret store.

```dotenv
DATABASE_URL=postgres://dc:dc@localhost:5433/dc_r2_test
S3_ENDPOINT=https://YOUR-ACCOUNT-ID.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=YOUR-TEST-BUCKET
S3_ACCESS_KEY=YOUR-BUCKET-SCOPED-ACCESS-KEY
S3_SECRET_KEY=YOUR-BUCKET-SCOPED-SECRET-KEY
WEB_ORIGIN=http://localhost:5173
TEST_R2=1
TEST_LARGE=1
```

```sh
node --env-file=.env.r2 --import tsx scripts/migrate.ts
node --env-file=.env.r2 --import tsx scripts/integration.ts
```

The R2 run exercises the app's presigned multipart uploads, storage-confirmed resume, 100 MiB limit, and download and preview paths. It also checks CORS preflight and `ETag` exposure, denial of unsigned and expired URLs, and worker recovery after a process kill. The PDF check uses `pdftoppm`.
