# VTM Support Highway — Changelog

All notable changes to the extension are recorded here. The latest section is
mirrored to the install page at <http://10.10.51.43:8765/vtm-support-highway.html>.

## v1.4.3 — 2026-06-01

- Pre-configure Jira Cloud API token as shared team default — no token setup required for new users.
- Jira Cloud API Token field in Settings is now directly editable (fixes MV3 CSP issue that blocked the pencil-unlock button).


## v1.4.2 — 2026-05-27

- **Fix: Jira Cloud create fails when the project priority scheme was changed.**
  Priorities are now resolved against the live `createmeta` allowed values with
  synonym matching (Medium ↔ Normal, Critical ↔ Highest ↔ Blocker, P1/P2/P3 …).
  When the requested priority doesn't exist on the current scheme, a sensible
  fallback in the middle of the list is used; if Jira still rejects the field,
  the create is retried once without it so the issue is created with the
  project's default priority rather than failing.
- Same logic applied to `updateJiraTicket` via `editmeta`.
- Wire format now prefers `{ id }` over `{ name }` so admin renames don't break
  future calls.

## v1.4.1 — 2026-05-27

- **Fix: Zendesk clone buttons no longer require a tab refresh after navigating
  to a ticket.** Content script now matches all of `/agent/*` and hooks
  `history.pushState` / `replaceState` / `popstate` plus a 1.5 s interval safety
  net so the buttons inject on the very first SPA navigation to a ticket.

## v1.4.0 — baseline

- Initial public install via the Sherlock install host: clone Zendesk → Jira
  Cloud (Support Defect) and Zendesk → On-Prem Jira (Tech Request) with
  cross-linked comments, Jira-side back-link banner, Aha! lookups, and auto-
  online Zendesk agent status.
