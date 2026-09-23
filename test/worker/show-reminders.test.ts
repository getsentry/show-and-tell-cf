import {env, createScheduledController} from 'cloudflare:test';
import worker from '../../src/worker';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {
  processShowReminders,
  type ReminderEnv,
} from '../../src/worker/services/show-reminders';

const now = new Date('2030-10-01T16:00:00.000Z');
const send = vi.fn(async () => ({messageId: 'email-id'}));
const slack = vi.fn(async () => new Response('ok'));
const config = (): ReminderEnv => ({
  DB: env.DB,
  APP_ORIGIN: 'https://showandtell.sentry.new',
  SHOW_REMINDERS_ENABLED: 'true',
  SHOW_EMAIL: {send},
  SHOW_EMAIL_FROM: 'shows@example.test',
  SHOW_SLACK_WEBHOOK: 'https://hooks.slack.com/services/test/test/test',
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM show_plan_audit'),
    env.DB.prepare(
      "INSERT OR IGNORE INTO users (id,email,display_name,is_admin) VALUES ('scheduler','scheduler@sentry.io','Scheduler',1)",
    ),
  ]);
  send.mockClear();
  slack.mockClear();
  vi.stubGlobal('fetch', slack);
});
afterEach(() => vi.unstubAllGlobals());
async function seed(
  id = 'show',
  reminder = now.toISOString(),
  start = '2030-10-08T16:00:00.000Z',
) {
  await env.DB.prepare(`INSERT INTO show_and_tell_events (id,title,created_by,is_hidden,starts_at,reminder_at,timezone,slug,plan_key)
    VALUES (?, 'October Show & Tell', 'scheduler', 1, ?, ?, 'America/Los_Angeles', 'october-show', ?)`)
    .bind(id, start, reminder, id)
    .run();
}
async function statuses(id = 'show') {
  return (
    await env.DB.prepare(
      'SELECT channel,status FROM show_reminders WHERE event_id = ? ORDER BY channel',
    )
      .bind(id)
      .all()
  ).results;
}
it.each([
  undefined,
  '',
  '   ',
  'not-a-url',
  'http://example.test',
  'https://user:secret@example.test',
])(
  'reports a safe configuration diagnostic for origin %s before revealing or sending',
  async (origin) => {
    await seed();
    const bindings = {...config(), APP_ORIGIN: origin};
    await expect(processShowReminders(bindings, now)).rejects.toThrow(
      'Configure an HTTPS APP_ORIGIN before enabling reminders',
    );
    await expect(
      worker.scheduled(createScheduledController(), {...bindings, VIDEOS: env.VIDEOS}),
    ).rejects.toThrow('Configure an HTTPS APP_ORIGIN before enabling reminders');
    expect(
      await env.DB.prepare(
        "SELECT is_hidden FROM show_and_tell_events WHERE id='show'",
      ).first(),
    ).toEqual({is_hidden: 1});
    expect(await statuses()).toEqual([
      {channel: 'email', status: 'pending'},
      {channel: 'slack', status: 'pending'},
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(slack).not.toHaveBeenCalled();
  },
);
it('does not require an origin while reminders are disabled', async () => {
  await expect(
    processShowReminders(
      {...config(), APP_ORIGIN: undefined, SHOW_REMINDERS_ENABLED: 'false'},
      now,
    ),
  ).resolves.toBeUndefined();
});
it('reveals a due show and sends both channels once across concurrent and repeated ticks', async () => {
  await seed();
  await Promise.all([
    processShowReminders(config(), now),
    processShowReminders(config(), now),
  ]);
  await processShowReminders(config(), now);
  expect(send).toHaveBeenCalledTimes(1);
  expect(slack).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]).toEqual([
    expect.objectContaining({
      to: 'team@sentry.io',
      text: expect.stringContaining('/events/show/october-show'),
    }),
  ]);
  expect(await statuses()).toEqual([
    {channel: 'email', status: 'sent'},
    {channel: 'slack', status: 'sent'},
  ]);
  expect(
    await env.DB.prepare(
      "SELECT is_hidden FROM show_and_tell_events WHERE id='show'",
    ).first(),
  ).toEqual({is_hidden: 0});
  // A manual hide after reveal is not overridden on every tick.
  await env.DB.prepare(
    "UPDATE show_and_tell_events SET is_hidden = 1 WHERE id='show'",
  ).run();
  await processShowReminders(config(), now);
  expect(
    await env.DB.prepare(
      "SELECT is_hidden FROM show_and_tell_events WHERE id='show'",
    ).first(),
  ).toEqual({is_hidden: 1});
});
it('does nothing when disabled and never contacts missing or unsafe delivery targets', async () => {
  await seed();
  await processShowReminders({...config(), SHOW_REMINDERS_ENABLED: 'false'}, now);
  expect(
    await env.DB.prepare(
      "SELECT is_hidden FROM show_and_tell_events WHERE id='show'",
    ).first(),
  ).toEqual({is_hidden: 1});
  await processShowReminders(
    {
      ...config(),
      SHOW_EMAIL: undefined,
      SHOW_SLACK_WEBHOOK: 'https://evil.test/services/x',
    },
    now,
  );
  expect(send).not.toHaveBeenCalled();
  expect(slack).not.toHaveBeenCalled();
  expect(await statuses()).toEqual([
    {channel: 'email', status: 'pending'},
    {channel: 'slack', status: 'pending'},
  ]);
});
it('skips cancelled, past and stale reminders while leaving future shows hidden', async () => {
  await seed('cancelled');
  await env.DB.prepare(
    "UPDATE show_and_tell_events SET cancelled_at = '2030-09-30', plan_updated_by='scheduler' WHERE id = 'cancelled'",
  ).run();
  await seed('past', '2030-09-20T16:00:00.000Z', '2030-09-27T16:00:00.000Z');
  await seed('stale', '2030-09-29T16:00:00.000Z');
  await seed('future', '2030-10-02T16:00:00.000Z');
  await processShowReminders(config(), now);
  expect(send).not.toHaveBeenCalled();
  expect(slack).not.toHaveBeenCalled();
  for (const id of ['cancelled', 'past', 'stale'])
    expect(await statuses(id)).toEqual([
      {channel: 'email', status: 'skipped'},
      {channel: 'slack', status: 'skipped'},
    ]);
  expect(
    await env.DB.prepare(
      "SELECT is_hidden FROM show_and_tell_events WHERE id='future'",
    ).first(),
  ).toEqual({is_hidden: 1});
});
it('does not retry ambiguous email acceptance and still sends Slack', async () => {
  await seed();
  send.mockRejectedValueOnce(new Error('timeout'));
  await processShowReminders(config(), now);
  await processShowReminders(config(), now);
  expect(send).toHaveBeenCalledTimes(1);
  expect(slack).toHaveBeenCalledTimes(1);
  expect(await statuses()).toEqual([
    {channel: 'email', status: 'uncertain'},
    {channel: 'slack', status: 'sent'},
  ]);
});
it('marks definitive Slack rejections failed without repeating accepted email', async () => {
  await seed();
  slack.mockResolvedValueOnce(new Response('channel_not_found', {status: 404}));
  await processShowReminders(config(), now);
  await processShowReminders(config(), now);
  expect(await statuses()).toEqual([
    {channel: 'email', status: 'sent'},
    {channel: 'slack', status: 'failed'},
  ]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(slack).toHaveBeenCalledTimes(1);
});
it('treats Slack timeouts and server failures as uncertain, not safe to resend', async () => {
  await seed();
  slack.mockResolvedValueOnce(new Response('error', {status: 500}));
  await processShowReminders(config(), now);
  expect(await statuses()).toEqual([
    {channel: 'email', status: 'sent'},
    {channel: 'slack', status: 'uncertain'},
  ]);
});
it('recovers stale claims as uncertain instead of double-sending', async () => {
  await seed();
  await env.DB.prepare(
    "UPDATE show_reminders SET status='sending',attempted_at='2030-09-30T16:00:00.000Z'",
  ).run();
  await processShowReminders(config(), now);
  expect(await statuses()).toEqual([
    {channel: 'email', status: 'uncertain'},
    {channel: 'slack', status: 'uncertain'},
  ]);
  expect(send).not.toHaveBeenCalled();
});
it('blocks reschedule/cancel once delivery is claimed and preserves stable IDs before delivery', async () => {
  await seed();
  await env.DB.prepare(
    "UPDATE show_and_tell_events SET starts_at='2030-10-09T16:00:00.000Z', reminder_at='2030-10-02T16:00:00.000Z',plan_updated_by='scheduler' WHERE id='show'",
  ).run();
  await processShowReminders(config(), now);
  expect(send).not.toHaveBeenCalled();
  await env.DB.prepare(
    "UPDATE show_reminders SET status='sending' WHERE event_id='show' AND channel='email'",
  ).run();
  await expect(
    env.DB.prepare(
      "UPDATE show_and_tell_events SET cancelled_at=CURRENT_TIMESTAMP,plan_updated_by='scheduler' WHERE id='show'",
    ).run(),
  ).rejects.toThrow('Delivery started');
});
