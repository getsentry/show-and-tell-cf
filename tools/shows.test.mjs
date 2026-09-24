import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {normalizePlan, createSql, quote} from './shows.mjs';

const now = new Date('2030-01-01T00:00:00Z');
const input = {
  key: 'october-special',
  actor: 'admin@sentry.io',
  title: "October's Special Show",
  startsAt: '2030-10-08T16:00:00Z',
  timezone: 'America/Los_Angeles',
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
};
test('normalizes UTC, derives seven days, preserves stable key identity and sanitizes free-form slug', () => {
  const plan = normalizePlan(input, now);
  assert.equal(plan.reminderAt, '2030-10-01T16:00:00.000Z');
  assert.equal(plan.slug, 'october-s-special-show');
  assert.equal(normalizePlan({...input, title: 'Changed'}, now).id, plan.id);
  assert.equal(
    normalizePlan({...input, slug: 'Über / October!'}, now).slug,
    'uber-october',
  );
  assert.equal(quote("it's"), "'it''s'");
});
test('rejects ambiguous dates, impossible dates, past reminders, bad timezone and URLs', () => {
  for (const changes of [
    {startsAt: '2030-10-08T16:00:00'},
    {startsAt: '2030-02-30T16:00:00Z'},
    {reminderAt: '2029-01-01T00:00:00Z'},
    {timezone: 'Pacific'},
    {actor: 'admin@example.com'},
    {meetingUrl: 'https://evil.test/'},
    {title: 'Hello\nBcc: x'},
  ]) {
    assert.throws(() => normalizePlan({...input, ...changes}, now));
  }
});
test('migration and create SQL atomically create one hidden show, one email delivery and one audit', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort())
      db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    db.exec(
      "INSERT INTO users(id,email,display_name,is_admin) VALUES ('admin','admin@sentry.io','Admin',1)",
    );
    const plan = normalizePlan(input, now);
    db.exec(createSql(plan));
    db.exec(createSql(plan));
    assert.equal(
      db.prepare('SELECT COUNT(*) count FROM show_and_tell_events').get().count,
      1,
    );
    assert.equal(
      db.prepare('SELECT is_hidden FROM show_and_tell_events').get().is_hidden,
      1,
    );
    assert.equal(db.prepare('SELECT COUNT(*) count FROM show_reminders').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) count FROM show_plan_audit').get().count, 1);
    assert.throws(() =>
      db.exec(
        createSql(
          normalizePlan({...input, key: 'other', actor: 'member@sentry.io'}, now),
        ),
      ),
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) count FROM show_and_tell_events').get().count,
      1,
    );
  } finally {
    db.close();
  }
});

test('email-only migration retires unsent Slack work, preserves history and does not requeue it', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = readdirSync(new URL('../migrations/', import.meta.url)).sort();
    const migration = files.find((file) => file.startsWith('0009_'));
    for (const file of files.filter((file) => file < migration))
      db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    db.exec(
      "INSERT INTO users(id,email,display_name,is_admin) VALUES ('admin','admin@sentry.io','Admin',1)",
    );
    for (const state of ['pending', 'failed', 'sent', 'sending', 'uncertain']) {
      const plan = normalizePlan({...input, key: state}, now);
      db.exec(createSql(plan));
      db.exec(
        `UPDATE show_reminders SET status='${state}' WHERE event_id='${plan.id}' AND channel='slack'`,
      );
    }
    db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    const pendingId = normalizePlan({...input, key: 'pending'}, now).id;
    db.exec(
      `UPDATE show_and_tell_events SET starts_at='2030-10-09T16:00:00.000Z',plan_updated_by='admin' WHERE id='${pendingId}'`,
    );
    const states = db
      .prepare("SELECT status FROM show_reminders WHERE channel='slack' ORDER BY status")
      .all()
      .map((row) => row.status);
    assert.deepEqual(states, ['sent', 'skipped', 'skipped', 'uncertain', 'uncertain']);
    const newPlan = normalizePlan({...input, key: 'new'}, now);
    db.exec(createSql(newPlan));
    assert.deepEqual(
      db
        .prepare('SELECT channel FROM show_reminders WHERE event_id=?')
        .all(newPlan.id)
        .map((row) => row.channel),
      ['email'],
    );
  } finally {
    db.close();
  }
});
