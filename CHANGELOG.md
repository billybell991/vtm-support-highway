# VTM Support Highway â€” Changelog

All notable changes to the extension are recorded here. The latest section is
mirrored to the install page at <http://10.10.51.43/highway/>.

## v1.4.16 — 2026-06-30

- Fixed client mapping: Zendesk org names now resolve to the exact Jira Client value via a confirmed lookup table (CRMS picklist codes and on-prem SUP labels), instead of fuzzy word-matching that produced junk labels.
- Bigger popup window and larger Original Submittal / Description fields.
- Removed the redundant helper text under the Description label.


## v1.4.15 — 2026-06-05

- Fix client field mapping: add token-based fuzzy match so Zendesk org names like PrimeCorp map to Jira short codes like PRIME_BC


## v1.4.14 — 2026-06-05

- Fix client field mapping: add token-based fuzzy match so Zendesk org names like 'PrimeCorp (BC)' correctly map to Jira short codes like 'PRIME_BC'


## v1.4.12 — 2026-06-04

- Add URMS (US RMS) to Project Key dropdown; auto-default Project Key to URMS when ZD VRM/EJU Product field is US RMS (uses hardcoded field ID 46648241536531 — same direct-lookup pattern as Sherlock)


## v1.4.11 — 2026-06-03

- _Release notes pending._

## v1.4.10 — 2026-06-03

- Fix JQL illegal escape: remove backslashes from bracket escaping in v3 search/jql


## v1.4.9 — 2026-06-03

- Migrate Jira Cloud clone search to /rest/api/3/search/jql


## v1.4.8 — 2026-06-03

- Migrate Jira Cloud clone search from /rest/api/2/search (410 removed) to /rest/api/3/search/jql -- on-prem Jira Server stays on v2


## v1.4.7 — 2026-06-03

- Shared Jira Cloud API token now injected at build time from secrets.local.json -- token no longer stored in git (public repo safety)


## v1.4.6 — 2026-06-03

- Shared Jira Cloud API token now injected at build time from secrets.local.json — token no longer stored in git (public repo safety)


## v1.4.5 — 2026-06-03

- Fix missing comma in settings.js causing service worker crash; add startup log and build-time syntax gate


## v1.4.4 — 2026-06-02

- Remove ZD prefix from Jira ticket title when cloning from Zendesk


## v1.4.3 â€” 2026-06-01

- Pre-configure Jira Cloud API token as shared team default â€” no token setup required for new users.
- Jira Cloud API Token field in Settings is now directly editable (fixes MV3 CSP issue that blocked the pencil-unlock button).


## v1.4.2 â€” 2026-05-27

- **Fix: Jira Cloud create fails when the project priority scheme was changed.**
  Priorities are now resolved against the live `createmeta` allowed values with
  synonym matching (Medium â†” Normal, Critical â†” Highest â†” Blocker, P1/P2/P3 â€¦).
  When the requested priority doesn't exist on the current scheme, a sensible
  fallback in the middle of the list is used; if Jira still rejects the field,
  the create is retried once without it so the issue is created with the
  project's default priority rather than failing.
- Same logic applied to `updateJiraTicket` via `editmeta`.
- Wire format now prefers `{ id }` over `{ name }` so admin renames don't break
  future calls.

## v1.4.1 â€” 2026-05-27

- **Fix: Zendesk clone buttons no longer require a tab refresh after navigating
  to a ticket.** Content script now matches all of `/agent/*` and hooks
  `history.pushState` / `replaceState` / `popstate` plus a 1.5 s interval safety
  net so the buttons inject on the very first SPA navigation to a ticket.

## v1.4.0 â€” baseline

- Initial public install via the Sherlock install host: clone Zendesk â†’ Jira
  Cloud (Support Defect) and Zendesk â†’ On-Prem Jira (Tech Request) with
  cross-linked comments, Jira-side back-link banner, Aha! lookups, and auto-
  online Zendesk agent status.
