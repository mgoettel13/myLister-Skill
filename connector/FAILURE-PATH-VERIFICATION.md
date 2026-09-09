# Failure-Path Verification

2026-09-09. The connector now returns fixed status-specific error guidance instead
of forwarding API error bodies. A regression test first failed on the old code
because a synthetic private debug marker appeared in the tool response, then
passed after the fix. This demonstrates the exposure path; it is not a claim that
real production secrets were observed leaking.

## Local Evidence

`npm test`: 31 passed, zero failed, one optional Mongo test skipped.

- Statuses 400, 401, 402, 403, 404, 409, 413, 415, 422, 429, 500, 502 and 503
  return status guidance without debug text, submitted content or unrelated secrets.
- Only 401 triggers OAuth reauthorization metadata. Permission denial, rate limiting
  and server errors do not falsely request a new grant.
- Error body streams are cancelled without consuming potentially sensitive data.
- A real loopback HTTP upstream and real MCP HTTP server demonstrate one request per
  call through 503/429/403/401 failures and successful reads after recovery.
- The upstream accepts a synthetic write then closes the socket. The connector
  reports an ambiguous failure and does not retry; the upstream records exactly one write.
- A 256-byte binary response survives the HTTP/MCP/base64 round trip byte-for-byte.
- Unknown tools and invalid schemas never reach the upstream.
- Disconnect blocks the affected test account before any upstream request; the
  other synthetic account continues using its own dedicated key.
- A clock-controlled test refreshes one second before the 30-day connection limit,
  receives a one-second access lifetime, then rejects access/refresh at the boundary
  even while the connection record is still active and cleanup has not run.

## Scope Limits

These are real local HTTP transports with an in-memory grant store and controlled
upstream fixtures, not a deployed API outage or an S3 storage test. They do not
prove Mongo restart recovery, actual file delivery/storage, natural 30-day expiry,
email delivery or browser UX. Earlier staging lifecycle evidence remains in
[STAGING-VERIFICATION.md](STAGING-VERIFICATION.md); remaining deployment and
submission gates remain in [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md).

No production data was mutated and no real email, reminder or OAuth account was
created by these tests. Test credentials are synthetic and loopback-only.
