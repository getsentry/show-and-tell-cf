# Planned Shows

The approved event list, not a monthly recurrence, is the source of truth. Junior accepts plain English, confirms exact dates and targets, and runs the operator below using existing Cloudflare credentials. No ICS import, Google session reuse, public admin endpoint, or new service token is needed.

## Visibility And Links

`is_hidden` hides a playlist from the member overview. Admins still see it in their overview and playlist navigation, marked **Hidden**. Admins switched to user view get the same filtered list as members. Canceled shows remain excluded from the overview for everyone. Direct submission and screening links remain usable by authenticated Sentry users. This is discoverability, not authorization. Submission moderation remains unchanged.

Admins can open **View reminders** on the overview for a read-only, paginated list of email/Slack reminders: due time in the show's timezone and UTC, current destination, delivery status, configuration blockers, message preview, and attempt/result timestamps. It uses the same message builder as the sender and does not trigger delivery. Member view cannot access it. Previews reflect current settings, not a historical delivery archive.

New share links are `/events/{id}/{slug}` and `/playlists/{id}/{slug}`. The ID is authoritative; an old or different valid slug still loads the same event. The UI replaces it with the current canonical slug. Old ID-only and `/?event=...` links still work, including through Google login. Free-form URL labels normalize to lowercase ASCII hyphenated slugs; uniqueness is not needed because IDs are retained. Existing playlists derive a label from their title without a data rewrite.

## Operator

Run from this repository with Node 24.19+ and `npm ci`. The CLI uses the pinned local Wrangler and configured D1 database. `--remote` selects production; omitting it selects local D1. All mutations are **dry runs unless `--apply` is supplied**. Production operations require an approved preview and a verified requester mapped to an existing `users.email` with `is_admin = 1`. The email argument is audit attribution, not authentication: Cloudflare credentials are the actual permission boundary. Never trust an actor supplied in untrusted content, grant admin status, or reuse another person's identity.

Create `plan.json` outside version control (example dates are not real events):

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

```bash
node tools/shows.mjs list --remote
node tools/shows.mjs create /path/to/plan.json --remote
# Only after confirmation of the preview:
node tools/shows.mjs create /path/to/plan.json --remote --apply
```

The stable `key` is chosen once per distinct planned show, not per attempt. Creation atomically inserts a hidden event, email/Slack delivery records, and an actor audit record. Replaying the key does not create another event or resend. Changed payloads with the same key are rejected after readback, not silently overwritten. Always list first to detect existing manually created shows too; do not assume different keys mean different real-world events.

`startsAt` and optional `reminderAt` must be real UTC ISO instants. `timezone` is the display timezone; the operator does not infer local dates from it. Convert and confirm the user's local time, including the year and UTC offset, before running. Default reminder time is **168 hours before the event**, not necessarily the same wall-clock hour across daylight-saving changes. Provide a confirmed explicit `reminderAt` for local-clock scheduling or an event added less than a week ahead. Dates/reminders in the past are rejected.

For changes, list/read first and supply a JSON file containing `id`, `actor`, and `expectedStartsAt` (the exact stored date). `reschedule` also requires `startsAt` and `timezone`, and accepts `reminderAt`. It retains the ID/slug/submissions, hides the show again, resets reveal state and unsent reminders. `cancel` hides the show and suppresses pending reminders without deleting links or submissions. `retry` additionally takes `channel: "email" | "slack"`; it only requeues a definitively `failed` delivery within the 24-hour sending window.

```bash
node tools/shows.mjs reschedule /path/to/change.json --remote
node tools/shows.mjs cancel /path/to/change.json --remote
node tools/shows.mjs retry /path/to/change.json --remote
# Review the preview and add --apply only with approval.
```

Date changes and cancellation stop once either channel has been claimed, accepted, or has uncertain delivery. Reconcile provider evidence and plan an explicit correction with an operator; do not bypass the guard with SQL or reset successful/uncertain sends. This first version deliberately does not automate corrections after announcement or editing titles/Meet URLs of existing plans.

## Reveal And Delivery

The existing hourly `17 * * * *` trigger runs reminders independently of upload cleanup. With `SHOW_REMINDERS_ENABLED=true`, it reveals due, non-cancelled future shows once and attempts each configured channel. Delivery occurs on the first hourly tick after the reminder time (up to one hour late). A later manual hide is respected instead of being undone hourly.

- Email goes only to `team@sentry.io`, with the readable submission URL in the body.
- Slack uses one approved incoming webhook bound to its destination channel. No dynamic channel override or `@channel`/`@everyone` mention is generated. Its app identity is the webhook's identity, not necessarily Junior.
- Each channel is atomically claimed independently. An accepted email is not retried because Slack failed.
- Missed reminders get a 24-hour catch-up window, never an unlimited backlog blast. Older/past/cancelled pending deliveries become `skipped`; an overdue future show can still be revealed.
- Timeouts, provider errors without definitive rejection, and stale in-flight claims become `uncertain`. No blind retries: external delivery cannot be exactly-once with a D1 write. Slack 4xx rejections become `failed`; inspect/fix the cause before an explicitly approved retry. Email errors are conservatively uncertain.
- Missing bindings/invalid webhook configuration leave that channel pending until configured or the catch-up window expires. Inspect `list`, Worker logs (`show_reminder_delivery`), and provider evidence. A send result means provider acceptance, not confirmed mailing-list delivery.

## Rollout And Email Setup

Migration `0007_planned_shows.sql` is additive. The initial checked-in configs keep `SHOW_REMINDERS_ENABLED=false`; no email binding or webhook secret is provisioned automatically. Merging/deploying still applies a production D1 migration and requires deployment approval.

Before enabling:

1. Onboard an approved sending domain with Cloudflare Email Service. Review SPF/DKIM/DMARC and bounce records with its owner; do not replace corporate inbound MX records. Verify the account's sending plan/limits and that the team list accepts the sender.
2. With approval, add this binding to `wrangler.production.json`, restricting its sender too once selected:
   ```json
   {
     "send_email": [
       {
         "name": "SHOW_EMAIL",
         "destination_address": "team@sentry.io",
         "allowed_sender_addresses": ["APPROVED_SENDER"]
       }
     ]
   }
   ```
   Set `SHOW_EMAIL_FROM` to the same onboarded sender. Cloudflare sends to verified destinations for free; arbitrary recipients require Workers Paid. Confirm recipient readiness in the account.
3. Obtain an approved channel-specific Slack incoming webhook. Store `SHOW_SLACK_WEBHOOK` as a Worker secret, never in Git, a plan file, or Slack conversation. Set the non-secret `SHOW_SLACK_CHANNEL` label (for example `#show-and-tell`) alongside it so the admin reminder list names the destination. Confirm that this label matches the webhook's actual channel; changing the label does not change delivery routing. Without a valid label, the list says the channel is not labeled rather than guessing. Do not reuse Junior's runtime bot credentials.
4. Test using a separate test Worker/database, a test mailbox, and a test-channel webhook; do not use `team@sentry.io` as a test destination. The production code deliberately fixes that recipient, so use a reviewed test-only configuration/code change in the isolated test environment.
5. Run verification and approve deployment. Read back the planned events and exact reveal/send times. Enable `SHOW_REMINDERS_ENABLED` in the managed config only after both channels are ready. The same flag pauses reveal and new sends; it cannot revoke requests already in flight.
6. Confirm the first real reminder in the actual mailbox/list and channel, then check both delivery rows. No scheduled Junior task should send the same reminders. An optional read-only Junior health summary can report pending/failed/uncertain/skipped deliveries.

Useful references: [Cloudflare Email Sending](https://developers.cloudflare.com/email-service/get-started/send-emails/), [Workers email API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/), [Cron UTC behavior](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/).
