import type {ReactNode} from 'react';

/** Hack Week's bouncing tiles, in Sentry colours. */
export function Loader() {
  return (
    <div className="tileLoader" aria-hidden="true">
      <div className="tileLoaderTiles">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="tileLoaderTrack">
        <span />
      </div>
    </div>
  );
}

export function PageState({
  title,
  detail,
  tone = 'neutral',
  loading = false,
  children,
}: {
  title: string;
  detail: string;
  tone?: 'neutral' | 'error';
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      className={`pageState pageState--${tone}${loading ? ' pageState--loading' : ''}`}
      aria-busy={loading || undefined}
      aria-live="polite"
      role={tone === 'error' ? 'alert' : undefined}
    >
      {loading ? <Loader /> : null}
      <p className="kicker">Sentry Show &amp; Tell</p>
      <h1>{title}</h1>
      <p>{detail}</p>
      {children}
    </section>
  );
}
