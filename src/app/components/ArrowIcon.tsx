export function ArrowIcon({direction}: {direction: 'left' | 'right' | 'up' | 'down'}) {
  return (
    <svg
      className="arrowIcon"
      data-direction={direction}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M19 12H5m7-7-7 7 7 7" />
    </svg>
  );
}
