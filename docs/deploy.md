# Deploy a judging instance

The [Render Blueprint](../render.yaml) builds the web UI and serves it from the same origin as the API. It runs the background worker in the web service container and uses managed PostgreSQL. The provided Dockerfile installs Poppler and runs the app as a non-root user. A free Render service can sleep, and its free database expires. [Render free-tier limits](https://render.com/docs/free)

1. Create a private R2 bucket and a bucket-scoped S3 read/write credential. Use the R2 S3 endpoint as `S3_ENDPOINT`, and enter the bucket name, access key and secret in Render. Keep public bucket access disabled. [R2 S3 setup](https://developers.cloudflare.com/r2/get-started/s3/)
2. In Render, create a Blueprint from this GitHub repository. Supply an event join code, a future ISO UTC deadline, and a private organizer login. Share the join code with judges privately. Bootstrapping is idempotent and preserves an existing deadline or organizer account.
3. Add the exact Render app origin to the bucket's browser CORS policy. Set `AllowedMethods` to `PUT`, `GET`, and `HEAD`, `AllowedHeaders` to `*`, and `ExposeHeaders` to `ETag`. Configure an object-store lifecycle rule to clean up abandoned multipart uploads after one day. [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)
4. Open `/api/healthz` and the in-app Status page. Create a test team, save project details, upload a ZIP with a README, and confirm the accepted receipt and preview. Sign in as organizer and export CSV. Use the resulting service URL in the hackathon submission.
