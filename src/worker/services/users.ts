import type {SessionUser} from '../../shared/api';
import type {SessionIdentity} from './sessions';

interface UserRow {
  id: string;
  google_subject: string | null;
  email: string;
  display_name: string;
  avatar_url: string | null;
  is_admin: number;
}

export async function synchronizeGoogleUser(
  db: D1Database,
  identity: SessionIdentity,
): Promise<SessionUser> {
  const bySubject = await findBySubject(db, identity.subject);
  const user = bySubject ?? (await findByEmail(db, identity.email));
  if (user) {
    if (user.google_subject !== null && user.google_subject !== identity.subject) {
      throw new UserIdentityConflictError();
    }
    try {
      await db
        .prepare(
          `UPDATE users SET google_subject = ?, email = ?, display_name = ?, avatar_url = ?,
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .bind(
          identity.subject,
          identity.email,
          identity.displayName,
          identity.avatarUrl,
          user.id,
        )
        .run();
    } catch {
      throw new UserIdentityConflictError();
    }
    return toSessionUser({...user, ...identityRow(identity)});
  }

  const id = crypto.randomUUID();
  try {
    await db
      .prepare(
        `INSERT INTO users (id, google_subject, email, display_name, avatar_url)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        identity.subject,
        identity.email,
        identity.displayName,
        identity.avatarUrl,
      )
      .run();
  } catch {
    throw new UserIdentityConflictError();
  }
  return toSessionUser({id, is_admin: 0, ...identityRow(identity)});
}

async function findBySubject(db: D1Database, subject: string) {
  return db
    .prepare(
      `SELECT id, google_subject, email, display_name, avatar_url, is_admin
       FROM users WHERE google_subject = ?`,
    )
    .bind(subject)
    .first<UserRow>();
}

async function findByEmail(db: D1Database, email: string) {
  return db
    .prepare(
      `SELECT id, google_subject, email, display_name, avatar_url, is_admin
       FROM users WHERE email = ? COLLATE NOCASE`,
    )
    .bind(email)
    .first<UserRow>();
}

function identityRow(identity: SessionIdentity) {
  return {
    google_subject: identity.subject,
    email: identity.email,
    display_name: identity.displayName,
    avatar_url: identity.avatarUrl,
  };
}

function toSessionUser(row: UserRow): SessionUser {
  const role = row.is_admin === 1 ? 'admin' : 'member';
  return {
    id: row.id,
    email: row.email.toLowerCase(),
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    role,
  };
}

export class UserIdentityConflictError extends Error {}
