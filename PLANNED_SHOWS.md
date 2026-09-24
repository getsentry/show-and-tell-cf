# Planned Shows

Operating guide for [Show & Tell](https://showandtell.sentry.new). The approved list of individual shows is the schedule, including special events. Junior accepts plain English, confirms dates and email delivery, and uses `tools/shows.mjs` to manage them.

## Visibility And Links

Hidden playlists are omitted from the member overview. Admins see them marked **Hidden**, unless switched to member view. Canceled shows are omitted from everyone's overview. Direct links remain available to signed-in Sentry users; hiding a playlist affects discoverability, not access.

Share `/events/{id}/{slug}` for submissions and `/playlists/{id}/{slug}` for screening. The ID identifies the show; the readable slug is cosmetic. Old slugs, ID-only links and `/?event=...` links continue to work through sign-in.

## Create A Planned Show

Run commands from this repository with its supported Node version and dependencies installed (`npm ci`). The CLI uses local Wrangler and the D1 target in `wrangler.production.json` for `--remote`, or local D1 when that flag is omitted.

List existing planned shows first. Check the app overview for manually created playlists so that the same real-world show is not created twice.

```bash
node tools/shows.mjs list --remote
```

Prepare a JSON plan outside version control. This example is illustrative, not a scheduled event:

```json
{
  "key": "show-2030-10-special",
  "actor": "VERIFIED_ADMIN@sentry.io",
  "title": "October Show & Tell",
  "slug": "october-show-and-tell",
  "startsAt": "2030-10-08T16:00:00Z",
  "timezone": "America/Los_Angeles",
  "meetingUrl": "https://meet.google.com/abc-defg-hij",
  "description": "Monthly demos"
}
```

- `actor` is the verified requester's email and must belong to an existing app admin. It records attribution; Cloudflare credentials authorize database access.
- Choose `key` once per show and reuse it for retries. Replaying an identical plan does not create another event or resend reminders; conflicting content is rejected.
- `startsAt` and optional `reminderAt` are explicit future UTC ISO timestamps. `timezone` controls display, not input conversion. Confirm the local date, year and UTC offset before applying.
- The default reminder is 168 hours before the show. Use an explicit `reminderAt` for a different cadence, DST wall-clock alignment, or a show added less than a week ahead.
- `slug`, `description` and `meetingUrl` are optional. The operator normalizes the URL label and validates Google Meet links.

Preview the plan, confirm it, then apply:

```bash
node tools/shows.mjs create /path/to/plan.json --remote
node tools/shows.mjs create /path/to/plan.json --remote --apply
```

Creation writes a hidden show, an email delivery record and an audit record together. Verify the returned records and share the submission link. All mutation commands are dry runs unless `--apply` is supplied. After a timeout, read back state before repeating a mutation.

## Reschedule, Cancel Or Retry

Read the existing show and prepare a change containing `id`, `actor`, and `expectedStartsAt` using the exact stored date.

- `reschedule` also requires `startsAt` and `timezone`, with optional `reminderAt`. It preserves the ID, slug and submissions, hides the show again, and resets reveal state and unsent reminders.
- `cancel` hides the show and suppresses pending reminders without deleting its submissions or links.
- `retry` also requires `channel: "email"`. It requeues only a definitively failed delivery within the 24-hour sending window.

```bash
node tools/shows.mjs reschedule /path/to/change.json --remote
node tools/shows.mjs cancel /path/to/change.json --remote
node tools/shows.mjs retry /path/to/change.json --remote
# Confirm the preview, then repeat the chosen command with --apply.
```

Date changes and cancellation are blocked once a delivery is in flight, accepted or uncertain. Reconcile delivery and coordinate an explicit correction rather than resetting successful/uncertain sends. The operator does not support title/Meet URL edits or automated post-announcement corrections.

## Reveal And Delivery

Cloudflare's hourly cron owns reveal and email delivery. With `SHOW_REMINDERS_ENABLED=true`, the first tick after the reminder time reveals the upcoming show once and attempts email delivery. This can be up to one hour after the requested time. A later manual hide is respected.

Email goes to `team@sentry.io` with the submission link in the body. The app does not send Slack reminders and requires no Slack app, token or webhook. People can ask Junior about shows in Slack; do not schedule duplicate reminder sends there.

Each email reminder is claimed atomically to avoid duplicate sends. Pending reminders have a 24-hour catch-up window. Older, past or canceled deliveries become `skipped`; an overdue future show can still be revealed.

## Reminder Status And Troubleshooting

Admins open **View reminders** to see scheduled times, destinations, HTML/plain-text previews, email status, configuration blockers and attempt/result timestamps. Opening the list or a preview does not send anything. Member view cannot access it. Previews use current settings rather than archived sent content.

- `pending`: awaiting its time or required configuration.
- `sending`: a worker has claimed the delivery.
- `sent`: the provider accepted it. Confirm actual receipt when needed; acceptance alone does not prove mailing-list delivery.
- `failed`: rendering failed before sending, or the provider definitively rejected the request. Correct the cause and confirm a targeted retry.
- `uncertain`: a timeout, ambiguous provider error or stale in-flight claim. Reconcile provider evidence before retrying because the original may have arrived.
- `skipped`: outside the catch-up window, past or canceled.

Use the CLI list, scoped Worker logs (`show_reminder_delivery` and failure diagnostics), and provider evidence to investigate. Do not expose sender secrets or raw provider errors in reports.

### Configuration Reference

Read current configuration when investigating a delivery blocker; these are not deployment prerequisites to recheck before every event operation.

- `SHOW_REMINDERS_ENABLED`: controls automatic reveal and new sends. Turning it off does not revoke requests already in flight.
- `APP_ORIGIN`: HTTPS base URL for submission links.
- `SHOW_EMAIL` and `SHOW_EMAIL_FROM`: Cloudflare email binding and onboarded sender for the team mailing list.

Use the approved infrastructure workflow for configuration changes. Keep the team list protected from external posting: a Sentry From address alone does not establish Workspace-internal delivery. IT should approve the sender/relay or an authenticated forwarding route. A successful personal test does not prove the team list will accept that sender.

## Send A Test Email

In **View reminders**, click **Send test to me** on a show’s reminder card. It sends the static email through the same `SHOW_EMAIL` binding and `SHOW_EMAIL_FROM` sender, with a `[TEST]` subject prefix, only to the signed-in admin's Sentry address. Recipient overrides are not supported. Member view cannot send tests.

Tests work independently of `SHOW_REMINDERS_ENABLED` and do not reveal a show or modify scheduled delivery records. They have a separate attempt ledger. Rechecking the same attempt never resends; distinct attempts are limited to one per admin per minute. For uncertain results, check your inbox before explicitly starting another test.

The email binding must permit the admin's test address in addition to the scheduled recipient. If it is restricted to `team@sentry.io`, use an approved recipient allowlist including the test admin rather than removing all destination restrictions. A provider error can be ambiguous; the UI does not display raw provider details or retry automatically. Provider acceptance is not confirmed inbox delivery.

## Email Copy

Edit `src/shared/email-template.ts` to change the email copy or layout. There is no editor or database template. Scheduled delivery, previews and personal tests use the same HTML/plain-text renderer.

The email includes the submission link, linked newcomer guide, help contacts, and DST-correct San Francisco, New York and Vienna start times. Demos are under five minutes; there is no submission deadline. After changing the copy, send yourself a test email and inspect it in your mail client.

## Implementation Map

- `tools/shows.mjs`: event operations and preview/apply workflow.
- `src/worker/services/show-reminders.ts`: reveal, delivery and status handling.
- `src/shared/email-template.ts`: static email copy and HTML/plain-text rendering.
- `src/worker/routes/reminders.ts`: admin status and personal test-email API.
- `src/app/ReminderList.tsx` and `src/app/TestEmailButton.tsx`: admin interface.

Historical Slack delivery rows are retained for audit but are not shown as active reminders. Unsent Slack work is retired, and the scheduler and operator only send/retry email. Historical accepted or uncertain deliveries still protect against silently changing an announced show.
