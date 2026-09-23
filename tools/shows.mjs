import {createHash} from 'node:crypto';
import {readFileSync, mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {eventSlug} from '../src/shared/playlist.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const quote = (value) =>
  value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const text = (value, name, max) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw new Error(`Provide ${name} (1-${max} characters, no control characters)`);
  return value.trim();
};
function instant(value, name) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`${name} must be an explicit UTC ISO timestamp`);
  const normalized = new Date(value).toISOString();
  if (normalized !== value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z'))
    throw new Error(`${name} is not a valid calendar date`);
  return normalized;
}
export function normalizePlan(input, now = new Date()) {
  const title = text(input.title, 'title', 120);
  const key = text(input.key, 'stable plan key', 160);
  const actor = text(input.actor, 'verified admin email', 254).toLowerCase();
  if (!/^[^\s@]+@sentry\.io$/.test(actor))
    throw new Error('Actor must be a verified Sentry admin');
  const startsAt = instant(input.startsAt, 'startsAt');
  const timezone = text(input.timezone, 'IANA timezone', 80);
  new Intl.DateTimeFormat('en-US', {timeZone: timezone}).format();
  const reminderAt = input.reminderAt
    ? instant(input.reminderAt, 'reminderAt')
    : new Date(Date.parse(startsAt) - 7 * 86400000).toISOString();
  if (
    Date.parse(startsAt) <= now.getTime() ||
    Date.parse(reminderAt) <= now.getTime() ||
    reminderAt >= startsAt
  )
    throw new Error(
      'Show and reminder must be in the future, with reminder before show; confirm an explicit reminderAt for late additions',
    );
  const slug = eventSlug(text(input.slug || title, 'slug', 120));
  let meetingUrl = null;
  if (input.meetingUrl) {
    const url = new URL(input.meetingUrl);
    if (
      url.origin !== 'https://meet.google.com' ||
      !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(url.pathname) ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error('Use a canonical Google Meet URL');
    meetingUrl = url.href;
  }
  const description = input.description
    ? text(input.description, 'description', 1000)
    : null;
  const id = `planned-${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
  return {
    id,
    key,
    actor,
    title,
    description,
    slug,
    startsAt,
    reminderAt,
    timezone,
    meetingUrl,
  };
}
const admin = (actor) =>
  `(SELECT id FROM users WHERE email = ${quote(actor)} AND is_admin = 1)`;
export function createSql(plan) {
  // NOT NULL created_by makes a missing/non-admin actor fail instead of silently inserting nothing.
  return `INSERT INTO show_and_tell_events
    (id, plan_key, title, description, slug, is_hidden, starts_at, reminder_at, timezone, meeting_url, created_by)
    VALUES (${[plan.id, plan.key, plan.title, plan.description, plan.slug].map(quote).join(', ')}, 1,
      ${[plan.startsAt, plan.reminderAt, plan.timezone, plan.meetingUrl].map(quote).join(', ')}, ${admin(plan.actor)})
    ON CONFLICT(plan_key) WHERE plan_key IS NOT NULL DO NOTHING;`;
}
export const listSql = `SELECT e.id, e.plan_key, e.title, e.slug, e.is_hidden, e.starts_at, e.reminder_at, e.timezone, e.meeting_url, e.cancelled_at,
  r.channel, r.status, r.attempted_at, r.completed_at, r.provider_id
  FROM show_and_tell_events e LEFT JOIN show_reminders r ON r.event_id = e.id
  WHERE e.plan_key IS NOT NULL ORDER BY e.starts_at DESC LIMIT 100;`;

function query(sql, remote) {
  const directory = mkdtempSync(join(tmpdir(), 'show-plan-'));
  try {
    const file = join(directory, 'query.sql');
    writeFileSync(file, sql, {mode: 0o600});
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'execute',
        'show-and-tell-db',
        '--config',
        remote ? 'wrangler.production.json' : 'wrangler.jsonc',
        remote ? '--remote' : '--local',
        '--file',
        file,
        '--json',
      ],
      {cwd: root, encoding: 'utf8'},
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `Wrangler exited ${result.status}: ${result.stderr || result.stdout}`,
      );
    const responses = JSON.parse(result.stdout);
    if (
      !Array.isArray(responses) ||
      responses.some((response) => response.success === false)
    )
      throw new Error('D1 query did not succeed');
    return responses.flatMap((response) => response.results || []);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

export function main(args) {
  const [command, ...options] = args;
  const remote = options.includes('--remote');
  const origin = remote ? 'https://showandtell.sentry.new' : 'http://localhost:5173';
  const apply = options.includes('--apply');
  const flags = options.filter((option) => option.startsWith('--'));
  if (flags.some((flag) => !['--remote', '--apply'].includes(flag)))
    throw new Error('Unknown flag');
  const files = options.filter((option) => !option.startsWith('--'));
  if (command === 'list') {
    if (apply || files.length) throw new Error('Usage: shows.mjs list [--remote]');
    console.log(JSON.stringify(query(listSql, remote), null, 2));
    return;
  }
  if (
    !['create', 'reschedule', 'cancel', 'retry'].includes(command) ||
    files.length !== 1
  )
    throw new Error(
      'Usage: shows.mjs create|reschedule|cancel|retry plan.json [--remote] [--apply], or list [--remote]',
    );
  const input = JSON.parse(readFileSync(files[0], 'utf8'));
  let plan;
  let sql;
  if (command === 'create') {
    plan = normalizePlan(input);
    sql = createSql(plan);
  } else {
    const id = text(input.id, 'existing event id', 128);
    const actor = text(input.actor, 'verified admin email', 254).toLowerCase();
    const expected = instant(input.expectedStartsAt, 'expectedStartsAt');
    const guard = `id = ${quote(id)} AND starts_at = ${quote(expected)} AND plan_key IS NOT NULL AND cancelled_at IS NULL AND ${admin(actor)} IS NOT NULL`;
    plan = {id, actor};
    if (command === 'reschedule') {
      const normalized = normalizePlan({...input, key: id, title: 'Schedule update'});
      plan = {
        ...plan,
        startsAt: normalized.startsAt,
        reminderAt: normalized.reminderAt,
        timezone: normalized.timezone,
      };
      sql = `UPDATE show_and_tell_events SET starts_at = ${quote(plan.startsAt)}, reminder_at = ${quote(plan.reminderAt)}, timezone = ${quote(plan.timezone)}, is_hidden = 1, revealed_at = NULL, plan_updated_by = ${admin(actor)}, updated_at = CURRENT_TIMESTAMP WHERE ${guard} RETURNING id;`;
    } else if (command === 'cancel') {
      sql = `UPDATE show_and_tell_events SET cancelled_at = CURRENT_TIMESTAMP, is_hidden = 1, plan_updated_by = ${admin(actor)}, updated_at = CURRENT_TIMESTAMP WHERE ${guard} RETURNING id;`;
    } else {
      if (!['email', 'slack'].includes(input.channel))
        throw new Error('Choose email or slack');
      plan.channel = input.channel;
      sql = `UPDATE show_reminders SET status = 'pending', retry_by = ${admin(actor)} WHERE event_id = ${quote(id)} AND channel = ${quote(input.channel)} AND status = 'failed'
        AND EXISTS (SELECT 1 FROM show_and_tell_events WHERE ${guard} AND julianday(starts_at) > julianday('now') AND julianday(reminder_at) >= julianday('now', '-1 day')) RETURNING event_id;`;
    }
  }
  const preview = {
    action: command,
    target: remote ? 'production' : 'local',
    plan,
    submissionUrl: `${origin}/events/${plan.id}${plan.slug ? `/${plan.slug}` : ''}`,
    sql,
  };
  if (!apply) {
    console.log(JSON.stringify({dryRun: true, ...preview}, null, 2));
    return;
  }
  // Verify actor even on an idempotent retry (where ON CONFLICT might otherwise hide an auth failure).
  if (
    !query(
      `SELECT id FROM users WHERE email = ${quote(plan.actor)} AND is_admin = 1`,
      remote,
    ).length
  )
    throw new Error('Actor is not an existing admin');
  const rows = query(sql, remote);
  if (command !== 'create' && rows.length !== 1)
    throw new Error(
      'No change: stale date, cancelled show, wrong delivery state, or missing admin; inspect list before retrying',
    );
  const actual = query(
    `SELECT * FROM show_and_tell_events WHERE id = ${quote(plan.id)}`,
    remote,
  )[0];
  if (!actual) throw new Error('Could not verify the saved show');
  if (
    command === 'create' &&
    (actual.plan_key !== plan.key ||
      actual.title !== plan.title ||
      actual.description !== plan.description ||
      actual.starts_at !== plan.startsAt ||
      actual.reminder_at !== plan.reminderAt ||
      actual.slug !== plan.slug ||
      actual.timezone !== plan.timezone ||
      actual.meeting_url !== plan.meetingUrl ||
      actual.cancelled_at)
  )
    throw new Error(
      'Plan key already exists with different details. Nothing overwritten; inspect and use reschedule',
    );
  console.log(
    JSON.stringify(
      {
        applied: true,
        target: remote ? 'production' : 'local',
        action: command,
        event: actual,
        deliveries: query(
          `SELECT * FROM show_reminders WHERE event_id = ${quote(plan.id)}`,
          remote,
        ),
        submissionUrl: `${origin}/events/${actual.id}/${actual.slug}`,
      },
      null,
      2,
    ),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
