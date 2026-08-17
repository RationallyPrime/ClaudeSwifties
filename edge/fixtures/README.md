# Sanitized provider fixtures

The Codex fixtures preserve the response structure captured from
`codex app-server` 0.147.0 on 2026-08-15 and agree with its locally generated
`GetAccountResponse` and `GetAccountRateLimitsResponse` schemas. The Claude
auth fixture preserves the keys captured from `claude auth status --json`
2.1.220 on the same date; its status-line fixture is the repository's sanitized
contract specimen. Grok fixtures preserve the documented `_x.ai/auth/info` and
`_x.ai/billing` shapes because no Grok profile is installed on this station.

Identifying strings, balances, percentages, and timestamps are synthetic. The
files contain no provider credential or live account identifier. Real provider
smoke tests remain an explicit terminal gate rather than a claim made by these
fixtures.
