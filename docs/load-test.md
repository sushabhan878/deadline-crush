# Deadline Crush load test

**Result: 2,000 teams submitted in the 10-minute window. Aggregate API p95 was 26.7 ms. Zero submissions were lost.**

Run started 14 November 2026 at 22:06 IST. The Node.js load generator, Nest API, PostgreSQL 16, SeaweedFS 4.53, and worker ran on the same Windows 11 host with Docker Desktop. The generator issued one authenticated workflow per unique team, and 60% of teams arrived in the last three minutes. Test JWTs represented already signed-in teams. Each team saved metadata, started an upload, uploaded directly to object storage, finalized it, and read back its versions. The generator repeated requests with the same idempotency keys, simulated rejected/offline PUT attempts, and submitted 40 additional revisions.

## Latency

| API operation | Calls | p95 |
| --- | ---: | ---: |
| Read server time | 2,000 | 5.0 ms |
| Save project details | 2,000 | 18.9 ms |
| Start version | 2,160 | 22.9 ms |
| Sign part | 2,040 | 9.7 ms |
| List parts | 2,103 | 14.2 ms |
| Complete upload | 2,160 | 31.4 ms |
| Read versions | 2,000 | 6.3 ms |
| **All API calls** | **14,463** | **26.7 ms** |

## Durability reconciliation

| Post-run check | Observed | Expected |
| --- | ---: | ---: |
| Distinct submitting teams | 2,000 | 2,000 |
| Accepted file versions | 2,040 | 2,040 |
| Receipts with matching SHA-256 | 2,040 | 2,040 |
| Finished jobs | 2,040 | 2,040 |
| Persisted individual checks | 10,200 | 10,200 |
| Workflow failures | 0 | 0 |

The driver measures each API response through JSON decoding and records each endpoint separately. Storage PUT latency is outside the API metric. The ZIP fixture is 235 bytes. This is a control-plane throughput run with actual multipart sessions, storage, and workers. The peak storage-bandwidth case of 2,000 simultaneous maximum-size uploads remains unmeasured.

In the separate Linux integration run, the first worker received `SIGKILL` after reading the file type. The replacement finalized the same job on attempt 2. PostgreSQL held five check events, one acceptance event, and one matching hashed receipt. The same integration suite covered signed two-part uploads, ZIP README and PDF previews, cross-team access denial, grace, SSE replay, and CSV formula neutralization.

The maximum-size integration run uploaded exactly 104,857,600 bytes in 13 signed PUTs and checked that only missing parts were listed after the first PUT. The worker read back the full object and produced the expected SHA-256. The fixture intentionally contained a malformed ZIP, which the worker flagged as `needs_fix`.

## Reproduce

Start a fresh PostgreSQL database and private S3 bucket, then start the API and worker with those settings. In the driver shell, set `DATABASE_URL`, `JWT_SECRET` to the same value as the API, and `API` to the API root. Run `npm run loadtest`. `LOAD_TEAMS` and `LOAD_SECONDS` override the default 2,000 and 600. The run fails on a mismatch in team, version, receipt, job, or check counts, or when aggregate p95 is at least 300 ms. [Raw run output](../loadtest/verified-run.json)
