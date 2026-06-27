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
- **Constant-time password comparison** (`crypto.timingSafeEqual`).
- **Auth tokens**: 32-byte random hex, in-memory, expire on every deploy.
- **Body size cap**: JSON limited to 64 kb.
- `trust proxy = 1` so rate limiting keys on the real client IP behind Render.

## Manual actions still required (cannot be done in code)

1. **Rotate the leaked GitHub token.** A personal access token was previously
   embedded in the git remote URL. It has been removed from the remote, but the
   leaked value must be **revoked** at <https://github.com/settings/tokens> and
   replaced. After rotating, run `git push` once from a terminal — git will
   prompt for the new token and store it in the macOS keychain.

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
