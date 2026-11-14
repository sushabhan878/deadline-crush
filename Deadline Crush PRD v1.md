# Deadline Crush: Product Requirements Document (v1)

**Goal:** a hackathon submission system where 2,000 teams submit in the last 10 minutes, nothing is lost, and the deadline is enforced fairly by the server. **How to use this PRD:** each feature has an ID (F-xx), requirements, acceptance criteria (AC) and tests. Build in the order of Section 17. Refine one feature at a time.

---

## 1. Product summary

| Item | Value |
| --- | --- |
| Users | Participants (team members), Organizers, Admin |
| Scale | 2,000 teams, 100 MB max file, \~60% of submissions in the final 3 minutes |
| Core promises | (1) No acknowledged submission is ever lost. (2) The server clock decides the deadline. (3) Every version is kept. (4) Every check runs effectively once. |
| Judging order | Nothing lost and fair deadline, then design decisions, then code/tests/UX |

### Non-goals (v1)

Multi-tenant billing, team formation, judging/scoring, code execution of submissions, mobile native apps.

### Success metrics

- 0 lost submissions in the reconciliation run (2,000/2,000)
- p95 API latency under 300 ms during the spike
- 30+ automated tests in CI, including worker-kill and deadline-boundary tests
- Queue drains within 5 minutes after the deadline in the load test

---

## 2. Personas and roles

- **Participant:** member of exactly one team in a hackathon. Can create/edit submission, upload, view own team's status and files.
- **Organizer:** manages hackathon config, views dashboard, exports CSV, views any team's submission, overrides nothing about the deadline (no silent overrides; see F-18).
- **System (worker):** background checks, reaper, reconciler.

---

## 3. System architecture

```
Browser (React) ──REST──> API (NestJS) ──> Postgres (state, queue, audit)
   │                         │  └── SSE <── LISTEN/NOTIFY
   │                         └── S3 API (sign, list parts, complete, head)
   └── PUT parts (signed URL) ──────────────> R2 / MinIO (private bucket)

Worker (Node) ──> Postgres (SKIP LOCKED jobs) ──> S3 (ranged reads, previews)
Reaper / Reconciler (inside worker process, separate loops)
```

**Principles**

1. The API never streams file bytes.
2. Postgres is the single source of truth and the queue, so job and state commit atomically.
3. All time decisions use the DB clock (`now()`), never client or app clocks.
4. Delivery is at-least-once; effects are idempotent.
5. Versions are immutable.

### Tech stack

NestJS + TypeScript, Postgres 16, `@aws-sdk/client-s3` + presigner, React + Vite + TypeScript, zod (shared schemas), k6, Docker Compose, GitHub Actions, Caddy (HTTPS), Resend/Brevo (email).

---

## 4. Domain model and data schema

### Tables

**users**: id uuid pk, email unique, name, password_hash, role (`participant|organizer|admin`), created_at

**hackathons**: id, name, starts_at, deadline_at, grace_seconds (default 300), max_file_bytes (default 104857600), allowed_types text\[\] (`pdf`,`zip`), max_links (default 5), created_at

**teams**: id, hackathon_id, name, created_at. UNIQUE(hackathon_id, name)

**team_members**: team_id, user_id, role (`leader|member`). UNIQUE(user_id, hackathon_id) via denormalized hackathon_id column

**submissions**: id, team_id UNIQUE, current_title, current_description, current_links jsonb, updated_at

**metadata_versions**: id, submission_id, version_no, title, description, links jsonb, created_at, in_time bool. UNIQUE(submission_id, version_no)

**file_versions**

- id uuid pk, submission_id, version_no, idempotency_key
- status: `uploading | uploaded | checking | accepted | needs_fix | aborted | expired`
- s3_key, s3_upload_id, part_size, total_parts
- declared_size, actual_size, declared_filename, sha256, detected_mime
- started_at, completed_at, finalized_at
- started_in_time bool, completed_in_grace bool, counts bool (derived: eligible to count)
- failure_summary text
- UNIQUE(submission_id, version_no), UNIQUE(submission_id, idempotency_key)

**upload_parts**: version_id, part_no, etag, size, uploaded_at. PK(version_id, part_no)

**jobs**: id bigserial, version_id, kind (`check_version`), state (`queued|running|done|failed`), attempts, max_attempts (default 5), locked_by, lease_expires_at, run_after, last_error, created_at. UNIQUE(version_id, kind)

**check_results**: version_id, check_name (`type|archive|links|preview|hash`), status (`pass|fail|skipped`), detail jsonb, finished_at. UNIQUE(version_id, check_name)

**late_attempts**: id, team_id, user_id, action (`start_upload|complete_upload|edit_metadata`), server_time, deadline_at, delta_ms, reason, ip

**audit_events**: id bigserial, hackathon_id, team_id nullable, actor_id, type, payload jsonb, created_at. (Feeds SSE and the organizer feed.)

**receipts**: version_id pk, sha256, emailed_at, email_status

### State machine (file_versions)

```
uploading -> uploaded -> checking -> accepted
                                  -> needs_fix
uploading -> aborted | expired (no completion by deadline+grace)
```

All transitions go through one `transition(versionId, from, to, tx)` function that checks the current status in the `UPDATE ... WHERE status = from` clause. A zero-row update means the transition was lost to a concurrent actor; handle it as a no-op.

### Indexes

file_versions(submission_id, version_no desc), file_versions(status), jobs(state, run_after), jobs(lease_expires_at) where state='running', audit_events(team_id, id), audit_events(hackathon_id, id).

---

## 5. Deadline and grace policy (normative)

1. All comparisons use `now()` inside the DB transaction.
2. A **file version starts** when `POST /versions` commits. A start is allowed only if `now() < deadline_at`.
3. A started version may **complete** until `deadline_at + grace_seconds`. Completed after that: rejected, status `expired`, logged in late_attempts.
4. **Metadata edits** (title, description, links) are allowed only before `deadline_at`. Every edit creates a metadata version.
5. **Which file counts:** the highest `version_no` with status `accepted` and `counts = true`. If the newest in-time version is `needs_fix`, the latest earlier accepted version counts and the dashboard shows `fallback_used = true`.
6. Signed URL expiry = `min(15 min, deadline_at + grace − now)`. No signed URL can work after the cutoff.
7. If checks are still running at the deadline, the version keeps its in-time flag. Checking time is not the team's fault.
8. Every rejected action writes a late_attempts row with `delta_ms` (how late).
9. Policy values live on the hackathon row and are shown to participants in the UI as a live countdown driven by server time (see F-03).

**Clock abstraction:** a `Clock` interface (`now()` reading DB time) injected everywhere, with a test implementation that can set time, so boundary tests are deterministic. For SQL-level checks pass the test time as a parameter in test mode only.

---

## 6. Features

### F-01 Authentication and sessions

- Email + password (argon2id), JWT access token (15 min) + refresh cookie, or server sessions.
- Organizer accounts seeded; participant signup requires a hackathon join code.
- **AC:** invalid tokens return 401; passwords never logged; login rate-limited (10/min/IP+email).
- **Tests:** login success/failure, expired token, rate limit.

### F-02 Teams and membership

- Participant creates or joins a team (simple v1: organizer pre-seeds teams, or team created with invite code). Team members can submit. Leader role optional in v1.
- **AC:** user belongs to one team per hackathon; membership guard exists as one reusable NestJS guard `TeamMemberGuard`.

### F-03 Server time and countdown

- `GET /time` returns `{serverNow, deadlineAt, graceEndsAt, phase}` where phase is `open | grace | closed`.
- UI computes offset = serverNow − clientNow once and refreshes every 30s; it displays "closes in mm:ss" using the offset. The UI never decides acceptance, only displays.
- **AC:** with the client clock 10 minutes wrong, the countdown still matches the server.

### F-04 Submission metadata (project details and links)

- Fields: title (3-120 chars), description (up to 5,000 chars), up to N links (https only, max 2,048 chars each), optional demo-video link.
- Edits create metadata versions; viewable history.
- **AC:** edit after deadline returns 403 `DEADLINE_PASSED` and writes late_attempts. Concurrent edits: last write wins with version_no increment, no lost version (use `SELECT ... FOR UPDATE` on the submission row).

### F-05 Start upload (multipart)

`POST /submissions/:id/versions` body `{filename, size, contentType}` with header `Idempotency-Key`.

1. Validate: size 1..max_file_bytes, extension in allowed list (advisory only, content is checked later), filename sanitized.
2. In a transaction: check deadline, lock submission row, compute next version_no, insert version (`uploading`), call S3 `CreateMultipartUpload`, store `s3_upload_id`, write audit event.
3. Return `{versionId, partSize: 8 MiB, totalParts, expiresAt}`.

- Same Idempotency-Key returns the same response (no second version).
- Limit: max 1 active `uploading` version per team; starting a new one aborts the old one (S3 `AbortMultipartUpload`).
- **AC:** double click yields one version; start after deadline is rejected and logged; S3 failure leaves no orphan DB row (create DB row after S3 call, or compensate on failure).

### F-06 Sign parts

`POST /versions/:id/parts/sign` body `{partNumbers: number[]}` (max 20 per call).

- Returns presigned `UploadPart` URLs. Expiry per policy item 6.
- Rejects if version is not `uploading` or deadline+grace has passed.
- **AC:** URL for a part beyond `totalParts` is refused; expired URLs fail at storage level (test with MinIO).

### F-07 Resumable upload (client)

- Chunking: 8 MiB parts, 3-4 parallel, retry with exponential backoff and jitter (max 6 tries per part), per-part progress.
- Persist `{versionId, fileFingerprint(name,size,lastModified)}` in localStorage. On reload or reconnect, call `GET /versions/:id/parts` and upload only missing parts.
- Pause automatically on `offline` event, resume on `online`.
- **AC:** kill network at 50%, restore, finishes without re-uploading finished parts; closing and reopening the tab resumes if the same file is reselected.

### F-08 List parts and reconcile

`GET /versions/:id/parts` calls S3 `ListParts`, upserts `upload_parts`, returns `{uploaded: [{n, etag, size}], missing: [n]}` (handle pagination for >1000 parts, not needed at 13 parts but implement the loop).

### F-09 Complete upload

`POST /versions/:id/complete` body `{parts: [{n, etag}]}`.

1. Lock version row. If status is already `uploaded|checking|accepted|needs_fix`, return the stored result (idempotent).
2. Check `now() < deadline_at + grace`; otherwise mark `expired`, abort multipart, log late attempt, return 409 `GRACE_EXPIRED`.
3. Compare provided parts with S3 `ListParts` (count, etags, sizes; all parts except last equal part size).
4. `CompleteMultipartUpload`, then `HeadObject`: confirm size == declared size and ≤ max. Mismatch: delete object, mark `needs_fix` (`SIZE_MISMATCH`).
5. One transaction: status `uploaded`, set completed_at/counts flags, insert job row (ON CONFLICT DO NOTHING), write audit event, `pg_notify`.
6. Respond `{status: "uploaded", receiptId}`. Only respond after the commit. **Acknowledged means durable.**

- **Crash window:** S3 completed but DB commit failed. Reconciler (F-16) finds the object without an `uploaded` row and repairs it. The client retry of `/complete` also repairs it, because step 1 handles a completed S3 upload.
- **AC:** 50 parallel `/complete` calls produce one job and one transition.

### F-10 Background job queue

- Worker claims jobs: `UPDATE jobs SET state='running', locked_by=$w, lease_expires_at=now()+interval '60s', attempts=attempts+1 WHERE id IN (SELECT id FROM jobs WHERE state='queued' AND run_after<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $n) RETURNING *`.
- Heartbeat every 20s extends lease. Reaper (every 15s) requeues `running` jobs with expired lease (attempts \< max_attempts) with backoff, otherwise marks version `needs_fix` (`CHECK_INFRA_FAILURE`) and job `failed`.
- Worker concurrency configurable (default 4). Graceful shutdown finishes or releases current jobs.
- **AC:** two workers never process the same job simultaneously (except after lease expiry; effects idempotent).

### F-11 Check pipeline

Version moves `uploaded → checking` when a worker claims the job. Checks run in this order; each writes `check_results` with `INSERT ... ON CONFLICT (version_id, check_name) DO UPDATE`.

1. **Type by content (`type`)**: ranged GET of first 4 KB, detect via magic bytes. Allowed: PDF (`%PDF-`), ZIP (`PK\x03\x04`). Reject if detected type is not allowed, or if declared extension disagrees with detected type (`TYPE_MISMATCH`). Store `detected_mime`.
2. **Archive safety (`archive`)** for ZIP: read the central directory only (ranged reads of the tail). Limits (configurable): max entries 10,000; total declared uncompressed 1 GiB; per-entry 500 MiB; overall ratio 100:1; per-entry ratio 200:1; no encrypted entries; no path traversal (`..`, absolute, drive letters); no nested archive beyond depth 1; no symlinks. Then stream-read the README and the sample of entries with a **byte-counting limit that aborts when actual output exceeds the declared size or limit** (declared sizes can lie). Reject overlapping or inconsistent local/central headers.
3. **Links (`links`)**: for each link: https only; DNS resolve; block loopback, private, link-local, CGNAT, metadata (169.254.169.254), IPv6 equivalents; connect to the resolved IP with Host/SNI header; HEAD then GET fallback; 5s timeout; max 3 redirects (re-validate each hop); accept 2xx/3xx; read at most 64 KB of the body. Record status code and latency. A link failure makes the version `needs_fix` (`LINK_UNREACHABLE`) with the failing URL listed.
4. **Preview (`preview`)**: PDF first page rendered to PNG (≤ 1200 px wide) via `pdftoppm`/mupdf with a 20s timeout and memory limit; ZIP: README.md/README.txt (first 20 KB, plain text, escaped). Stored at `previews/{versionId}.png|txt` (deterministic key, overwrites are idempotent). Preview failure is a warning for ZIP without README (`skipped`), but a failure for an unrenderable PDF.
5. **Hash (`hash`)**: stream full object from S3 and compute SHA-256 (also verifies readability). Store on the version.

Final: all `pass` → `accepted`; any `fail` → `needs_fix` with `failure_summary` listing human-readable reasons and fix hints. Job `done`. All in one transaction with the audit event and notify. Receipt email is queued after accept (F-17).

- **AC:** every check has fixtures (see Section 12); a check crashing mid-way is retried without duplicate rows.

### F-12 Live status (SSE)

- `GET /teams/:id/events` (SSE) and `GET /hackathons/:id/events` (organizers).
- Events come from `audit_events` insert + `pg_notify('events', id)`. A single API-side LISTEN connection fans out to subscribers. Support `Last-Event-ID` replay (select audit_events where id > last, limit 500).
- Heartbeat comment every 15s. Client auto-reconnects; polling fallback `GET /teams/:id/status` every 5s if SSE fails 3 times.
- Event types: `version.started`, `upload.progress` (client-reported, optional, not persisted), `version.uploaded`, `version.checking`, `check.completed`, `version.accepted`, `version.needs_fix`, `version.expired`, `metadata.updated`.
- **AC:** status changes visible within 2s without refresh; reconnect with Last-Event-ID loses no events; non-members get 403.

### F-13 Participant UI

Screens:

1. **Login / join**
2. **Team submission page:** countdown banner (server time), metadata form with autosave draft and explicit "Save version", upload card (drag-drop, progress per part and overall, pause/resume, cancel), **status timeline** (Uploading → Uploaded → Checking → Accepted / Needs fix, per-check results with reasons and fix hints), **version history** (all versions, hash, size, status, "counts" badge, in-time badge), preview panel, download of own file (signed URL 60s).
3. **Receipt view:** hash, server timestamp, version number, "this version currently counts" indicator.

- States: offline banner, deadline passed, grace period banner ("uploads started earlier can still finish until HH:MM:SS"), error states with retry.
- Accessibility: keyboard navigable, ARIA live region for status updates, color not the only status signal.
- **AC:** full flow works on a phone viewport; screen reader announces status changes.

### F-14 Organizer dashboard

- Live tiles: teams total, with submission, by status (uploading, checking, accepted, needs fix), late attempts count, failed checks by reason (bar), queue depth, oldest queued job age, active workers.
- Table: team, current counting version, status, in-time, fallback_used, size, hash, last activity; filters and search; click-through to detail (versions, check results, late attempts, audit trail).
- Live updates via the organizer SSE channel.
- **CSV export** `GET /hackathons/:id/export.csv`: streamed (cursor, not full load), columns: team_id, team_name, title, links, counting_version, status, in_time, fallback_used, sha256, size_bytes, submitted_at (server), late_attempts. Neutralize cells starting with `= + - @` (prefix `'`). Also `late-attempts.csv`.
- **AC:** export of 2,000 rows streams in under 3s; formula injection fixture passes.

### F-15 Organizer status page (bonus)

`GET /status`: API, DB, storage, worker heartbeat, queue lag, error rate; simple page with traffic-light indicators.

### F-16 Reaper and reconciler (safety net)

Loops in the worker process:

- **Reaper:** expired job leases (F-10).
- **Upload reconciler** (every 60s): (a) versions `uploading` past deadline+grace → `expired`, abort multipart; (b) S3 objects whose multipart is completed but DB still `uploading` → run the complete-repair; (c) stale `uploaded` versions without a job → create the job; (d) `checking` versions whose job is `failed` → `needs_fix`.
- **Storage orphan report:** objects without a DB version (reported, not auto-deleted).
- Bucket lifecycle rule aborts incomplete multipart uploads after 1 day.

### F-17 Receipt email (bonus)

After `accepted`: send email with team, version, server timestamp, file size and SHA-256. Idempotent via `receipts.emailed_at`. Retries with backoff; failure never affects submission status.

### F-18 Audit log and fairness transparency

- Every state change, edit, late attempt and organizer view/export writes an audit event.
- No organizer endpoint can alter a version's in-time flags. Fairness rule exists in code, not in policy only.

### F-19 Rate limits and abuse controls

- Per-user: sign endpoint 60/min, start upload 10/min, complete 20/min. Per-IP global limit with generous burst. Per-team: max 1 active upload, max 50 versions per hackathon.
- Limits must be sized so that the final-minute spike by legitimate teams is not throttled (load test checks 429 count = 0 for normal behaviour).

### F-20 Security hardening

- Private bucket; no public ACLs; keys `h/{hackathonId}/t/{teamId}/v/{uuid}`; previews under a separate prefix.
- Download URLs only after membership check; 60s expiry; `Content-Disposition: attachment`.
- CORS on the bucket limited to the app origin, exposes `ETag`.
- Input validation on every route via zod; reject unknown fields.
- Helmet, strict CORS on the API, no stack traces to clients, structured logs without secrets.
- Worker runs previews in a restricted subprocess (timeout, memory limit, no network).
- Never extract archives to disk; never execute content.

---

## 7. API surface (v1)

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| POST | /auth/login, /auth/signup, /auth/refresh | public |  |
| GET | /time | any | server time and phase |
| GET | /me | auth | user + team |
| GET/PUT | /submissions/:id/metadata | member | PUT is versioned, deadline-gated |
| GET | /submissions/:id/versions | member | history |
| POST | /submissions/:id/versions | member | start upload, idempotent |
| POST | /versions/:id/parts/sign | member |  |
| GET | /versions/:id/parts | member | resume |
| POST | /versions/:id/complete | member | idempotent |
| POST | /versions/:id/abort | member |  |
| GET | /versions/:id | member | status + check results |
| GET | /versions/:id/download | member | 60s signed URL |
| GET | /versions/:id/preview | member | signed URL |
| GET | /teams/:id/events | member | SSE |
| GET | /hackathons/:id/dashboard | organizer | tiles |
| GET | /hackathons/:id/submissions | organizer | table, paginated |
| GET | /hackathons/:id/events | organizer | SSE |
| GET | /hackathons/:id/export.csv | organizer | streamed |
| GET | /status | public | health summary |

Error format: `{code, message, details?, requestId}`. Codes include `DEADLINE_PASSED`, `GRACE_EXPIRED`, `NOT_A_MEMBER`, `INVALID_PARTS`, `SIZE_MISMATCH`, `RATE_LIMITED`, `VERSION_STATE_CONFLICT`.

---

## 8. Non-functional requirements

| Area | Requirement |
| --- | --- |
| Performance | p95 under 300 ms for all JSON API endpoints during spike; SSE connection capacity 2,500 concurrent |
| Durability | Acknowledged submission survives API/worker crash, restart, DB failover with the DB's own durability guarantees |
| Availability | API restarts do not lose in-flight uploads (state in DB/S3) |
| Scalability | API stateless, horizontally scalable; workers scale by count |
| Observability | Structured JSON logs with requestId, `/metrics` (Prometheus): request latency, queue depth, job duration, check failures, lease expirations |
| Security | See F-20 |
| Accessibility | Keyboard-only flow, ARIA live status, contrast AA |
| Portability | `docker compose up` brings everything (Postgres, MinIO, API, worker, web) |

---

## 9. Concurrency and consistency rules

- Version number allocation: lock the submission row (`FOR UPDATE`) inside the start transaction.
- All status changes: `UPDATE ... WHERE id=$1 AND status=$expected`.
- Job creation: unique `(version_id, kind)`.
- Check results: unique `(version_id, check_name)` with upsert.
- Previews: deterministic key.
- Hash: deterministic result.
- Receipt: unique per version.
- Idempotency keys stored per submission for start; `/complete` is idempotent by state.

---

## 10. Failure-mode matrix (must be tested or reasoned in the design doc)

| Failure | Expected behaviour |
| --- | --- |
| Browser drops mid-part | Part retried; resume lists parts |
| Laptop offline for 10 min | Resume on reconnect if within grace; else expired and logged |
| Double click Start | One version |
| Double click Complete | One transition, one job |
| S3 complete succeeds, DB commit fails | Retry of complete or reconciler repairs |
| Worker crashes mid-check | Lease expires, job retried, one result per check |
| Worker crashes after writing result, before final status | Retry upserts, final status written once |
| API crash mid-request | Idempotent retry |
| DB restart | Connections re-established; no partial states |
| Link check target hangs | Timeout, `needs_fix` with reason |
| Zip lies about sizes | Streaming counter aborts |
| SSE connection drops | Reconnect with Last-Event-ID |
| Email provider down | Retried, no effect on status |

---

## 11. Load test spec

- **Tool:** k6.
- **Scenario:** 2,000 virtual teams. Arrival: 15% in minutes 1-5, 25% in minutes 6-7, 60% in the last 3 minutes. Each team: login, GET /time, PUT metadata, start upload, sign parts, upload (mock storage PUTs to MinIO), complete, poll status/SSE. 5% double-click, 3% retry on simulated failure, 2% resubmit a second version.
- **File sizes:** 90% small (1-5 MB), 8% medium (20-50 MB), 2% full 100 MB. State this mix in the report. A separate smaller test uploads 100 real 100 MB files.
- **Thresholds:** p95 \< 300 ms on API routes (storage PUT time reported separately), error rate \< 1% excluding intended rejections, 0 unexpected 429.
- **Reconciliation script** (`scripts/reconcile.ts`): reads the k6 acknowledged log (JSON lines: team, version, sha256 client-side) and checks each in DB (exists, status terminal, `counts` as expected), in S3 (object exists, size), and sha256 equals. Output `acknowledged=2000 found=2000 lost=0 hash_mismatch=0`.
- **Chaos variant:** during the test, kill -9 one worker twice, restart the API once; run reconciliation again.
- **Report artifacts:** HTML/markdown with latency percentiles per endpoint, throughput graph, queue depth over time, drain time, DB CPU, and reconcile output. CI stores the smaller smoke version.

---

## 12. Test plan (target 35+)

**Deadline (8):** start at T−1s ok; start at T+1s rejected+logged; complete at T+grace−1s ok; complete at T+grace+1s rejected; metadata edit at T+1s rejected; signed URL expiry capped; countdown independent of client clock; policy with grace=0. **Upload (8):** resume after dropped part; duplicate start idempotent; duplicate complete idempotent; wrong ETag rejected; missing part rejected; size mismatch; oversize declared rejected; abort cleans multipart. **Versions (4):** immutable history; latest accepted counts; fallback when newest `needs_fix`; edit after deadline blocked. **Checks (8):** PDF accepted; exe renamed .pdf rejected; zip bomb (high ratio) rejected; zip with lying header aborted by counter; zip-slip rejected; encrypted zip rejected; link 404 flagged; SSRF to 127.0.0.1 / 169.254.169.254 / DNS rebinding blocked; preview generated for PDF and zip README. **Exactly-once (5):** kill worker mid-job (real process kill), one result per check; lease expiry and reaper; max attempts → needs_fix; duplicate job insert ignored; concurrent claim by 10 workers yields single owner. **Authz (4):** non-member 403 on files, previews, status, SSE; team A cannot touch team B version; organizer-only routes; expired token. **Realtime (2):** event delivered; Last-Event-ID replay. **Concurrency (2):** 50 parallel complete; 100 parallel starts with different keys leave one active upload. **CSV (1):** formula-injection neutralized.

CI (GitHub Actions): services Postgres + MinIO; jobs: lint+typecheck, unit, integration, e2e (compose), k6 smoke (artifact upload).

---

## 12a. Repo structure

```
/apps/api        NestJS (modules: auth, hackathons, submissions, uploads, versions, events, dashboard, export, status)
/apps/worker     job loop, checks, reaper, reconciler, mailer
/apps/web        React + Vite
/packages/shared zod schemas, types, error codes, clock
/infra           docker-compose.yml, Caddyfile, minio-init, bucket lifecycle + CORS
/loadtest        k6 scripts, reconcile script, report template
/scripts         seed (hackathon, 2,000 teams/users), fixtures generator (zip bomb, ssrf)
/docs            design.md, policy.md, runbook.md
```

---

## 13. Deployment

- One VM with Docker Compose (API, worker, Postgres, Caddy). R2 for storage in prod. Frontend on Pages/Vercel or served by Caddy.
- Seeded **demo hackathon** with a deadline set a few minutes ahead on demand (organizer button "reset demo deadline: +5 min"), plus a few demo teams and logins on the README.
- Env/secrets via `.env`; `.env.example` committed. Verify free-tier limits before committing to a provider.

---

## 14. Deliverables checklist

- [ ] GitHub repo with README (one-command start, architecture diagram, test instructions)
- [ ] Live URL + demo credentials
- [ ] Load-test report + reconciliation output
- [ ] 1-page design doc (upload flow, deadline and grace policy, exactly-once, trade-offs, one more week)
- [ ] Walkthrough video ≤ 5 min (forced disconnect and resume, deadline boundary demo, kill the worker live, dashboard, load-test result)
- [ ] 35+ tests green in CI badge

---

## 15. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Free tier cannot absorb load test | Run heavy test locally/VM, report honestly, deploy a lighter demo |
| R2 multipart quirks (equal part sizes) | Fixed part size, tested against R2 early |
| Zip parsing complexity | Use a vetted central-directory reader; fuzz with fixtures |
| Scope creep in UI | UI after correctness proofs; polish last |
| Worker hosting on free tier | Single VM |
| SSE connection count | Single LISTEN connection, per-team fan-out, load-test with 2,500 clients |

---

## 16. Open questions to decide while refining

1. Grace length: 5 min vs scaled by file size?
2. Fallback rule: confirm latest accepted in-time counts.
3. Can a team change links after deadline during grace? (Current: no.)
4. Max versions per team? Retention of old files after the event?
5. Postgres queue vs Redis: confirm Postgres for the atomicity story.
6. Do needs_fix versions count at all if no accepted version exists? (Proposed: team shown as "no valid submission", organizer sees the last attempt.)
7. Virus scanning (ClamAV) in v1 or later?

---

## 17. Build order for v1 (milestones)

**M1 Foundation:** repo, Compose (Postgres, MinIO), schema/migrations, auth, Clock, CI skeleton, seed script. **M2 Upload path:** F-03, F-04, F-05, F-06, F-08, F-09 with deadline tests and idempotency tests. **M3 Queue and checks:** F-10, F-11 (type, hash first; then archive, links, preview), F-16 reaper. Worker-kill test. **M4 Live and UI:** F-12, F-13 (upload with resume, timeline). **M5 Organizer:** F-14 dashboard and CSV, F-18 audit views. **M6 Hardening:** F-19, F-20, SSRF/zip-bomb fixtures, authz tests, metrics. **M7 Proof:** k6 scenario, reconcile script, chaos run, fix findings. **M8 Ship:** deploy, demo hackathon, F-17 receipt, F-15 status page, design doc, video.

Rule: do not start a milestone until the previous milestone's tests are green.