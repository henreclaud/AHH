# Security Notes

This file tracks the security posture of the AAH volunteer app and the items
that still need a human decision.

## Hardening already in place (code)

- **Rate limiting** (`express-rate-limit`)
  - Login (`/api/admin/login`, `/api/staff/login`): 10 attempts / 15 min / IP.
    Blunts password brute-forcing.
  - Public write/lookup endpoints (signup, cancel, lookup-by-email,
    check-in/out): 30 requests / min / IP. Blunts signup-ID guessing and
    PII enumeration on `/api/signups?email=`.
- **Security headers** (`helmet`): no MIME sniffing, no framing/clickjacking,
  HSTS, referrer policy. CSP is intentionally off because the pages use inline
  `style=` attributes; turning CSP on would require removing those first.
- **Unguessable signup IDs**: generated with `crypto.randomInt` (CSPRNG),
  not `Math.random`. Prevents guessing an ID to cancel someone else's signup.
- **Spreadsheet formula-injection guard** (`sanitizeForSheet` in google.js):
  user-supplied text written to the sheet with `USER_ENTERED` (signup name/email,
  shift notes) is prefixed with `'` when it starts with `= + - @`, so a name like
  `=HYPERLINK(...)` can't run as a formula in staff's account. Covered by
  `test/sheet-injection.test.js`. (Other write paths already use `RAW`, which is
  injection-safe.)
- **Constant-time password comparison** (`crypto.timingSafeEqual`).
- **Auth tokens**: 32-byte random hex, in-memory, expire on every deploy.
- **Body size cap**: JSON limited to 64 kb.
- `trust proxy = 1` so rate limiting keys on the real client IP behind Render.

## Manual actions still required (cannot be done in code)

1. **(Optional) Rotate the GitHub token.** A personal access token used to be
   stored in plaintext in the git remote URL (`.git/config`). It was **never
   committed and never appears in git history** — `.git/config` is local-only,
   so it was not publicly exposed. It has since been moved out of the remote URL
   and into the macOS keychain (via a one-time `git push`). Revoking the old
   token at <https://github.com/settings/tokens> is good hygiene but only
   necessary if this machine itself was ever compromised.

2. **Strengthen the app passwords.** They live in the `pwd` tab of the Google
   Sheet. The current values are short (e.g. a 3-character admin password). Even
   with rate limiting, use long, random passwords. Update them in the sheet —
   no code change needed.

## Known accepted trade-offs

- **Passwords stored in plaintext in the Sheet.** This is intentional so staff
  can change them without a deploy. The mitigation is a strong password + rate
  limiting + the sheet's own access controls. If stronger protection is wanted,
  move to hashed passwords or environment variables (loses the edit-in-sheet
  convenience).
- **`/api/signups?email=` is unauthenticated.** The public cancel page needs to
  look up signups by email. Rate limiting mitigates enumeration; a full fix
  would require an email-verification step before showing results.
