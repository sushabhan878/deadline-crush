# Deadline Crush

Hack4Hack PS2 project submissions with resumable direct-to-storage uploads, a server-enforced deadline, and durable background checks.

| Submission material | Location |
| --- | --- |
| One-page design brief | [Design PDF](docs/design.pdf) |
| Load test and worker crash evidence | [Report](docs/load-test.md) · [Raw results](loadtest/verified-run.json) |
| Walkthrough | [MP4](docs/walkthrough.mp4) |
| Hosted UI preview | [Browser demo with simulated uploads](https://sushabhan878.github.io/deadline-crush/) |
| Deployment | [Render Blueprint](render.yaml) · [Setup](docs/deploy.md) |

The 10-minute local test reconciled all **2,000 teams** and **2,040 accepted versions** at **26.7 ms API p95**. The test used 235-byte ZIP fixtures. Integration testing exercised the worker kill, real multipart upload, PDF and ZIP previews, grace, membership, SSE replay, and CSV export.

## Run locally

Install Node.js 22+, Docker, and Poppler (`pdftoppm`, for PDF previews). Run these commands from the repository root.

```sh
npm ci
npm run infra
npm run migrate
npm run seed
```

In separate terminals, run `npm run api`, `npm run worker`, and `npm run web`. Open `http://localhost:5173`. Demo logins are `team1@demo.test` through `team5@demo.test` and `organizer@demo.test`, all with password `password123`. The organizer can reset the demo deadline. Sign-up uses join code `DEMO`, and teammates can join with the invite code in the workspace. `http://localhost:5173/?demo=1` runs a separate browser-only walkthrough with sample data.

Services read environment variables. See [.env.example](.env.example) for defaults. Set variables in the shell or use Node's `--env-file` option when invoking a service. The default Compose setup binds storage to loopback and uses development credentials.

## Deadline policy

- PostgreSQL wall time is sampled after the relevant row lock. New upload versions and metadata saves require time strictly before the deadline.
- The default grace period is five minutes. An existing upload can resume and request completion strictly before grace ends. The server validates that storage has every expected part and saves the manifest before asking storage to complete it. A durable manifest can finish during recovery after the cutoff. Checks can finish later.
- The highest-numbered eligible accepted file counts, together with the latest pre-deadline project details. Failed versions stay visible and an earlier accepted file can still count. Links are checked from the snapshot saved when a file requests completion. Save links before uploading to verify the links shown on the receipt's version.
- Each part URL expires in at most 15 minutes and by the grace cutoff. Completed download and preview URLs expire after 60 seconds. The original file is required when reselecting a resumed upload.

## Verify

`npm test` runs the 50 unit tests. `npm run test:integration` exercises a real API and deliberately kills a worker. Set `DATABASE_URL` and `S3_ENDPOINT` to dedicated test infrastructure, initialize the bucket with `npx tsx scripts/create-bucket.ts`, and migrate before running it. Use `TEST_LARGE=1` to exercise the exact 100 MiB limit across 13 direct PUTs. GitHub Actions runs the build, type checks, unit suite and integration suite on push and PR.

To repeat the benchmark, follow the [load-test report](docs/load-test.md). In production, keep the object bucket private and configure its browser CORS policy for your app origin.
