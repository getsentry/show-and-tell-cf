import {useEffect, useState} from 'react';

/** Google avatar when available, otherwise initials on a tone picked from the name
 * so the same person always gets the same colour. */
export function Avatar({
  name,
  avatarUrl,
  className = '',
}: {
  name: string;
  avatarUrl?: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarUrl]);
  const classes = `avatar${className ? ` ${className}` : ''}`;
  if (!avatarUrl || failed) {
    return (
      <span
        className={`${classes} avatar--fallback`}
        data-tone={tone(name)}
        aria-hidden="true"
      >
        {initials(name)}
      </span>
    );
  }
  return (
    <img
      className={classes}
      src={avatarUrl}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      width={64}
      height={64}
      onError={() => setFailed(true)}
    />
  );
}

function initials(value: string) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

/** 0-3, matching the four `.avatar[data-tone]` colours in styles.css. */
function tone(value: string) {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) % 4;
  return hash;
}
