import type { ReactNode } from "react";

function IconFrame(props: { children: ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="18"
      viewBox="0 0 20 20"
      width="18"
    >
      {props.children}
    </svg>
  );
}

export function SelectListIcon() {
  return (
    <IconFrame>
      <g fill="currentColor">
        <circle cx="3.5" cy="5" r="1.15" />
        <circle cx="3.5" cy="10" r="1.15" />
        <circle cx="3.5" cy="15" r="1.15" />
      </g>
      <g stroke="currentColor" strokeLinecap="round" strokeWidth="1.6">
        <path d="M7 5h9" />
        <path d="M7 10h9" />
        <path d="M7 15h9" />
      </g>
    </IconFrame>
  );
}

export function TrashIcon() {
  return (
    <IconFrame>
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      >
        <path d="M3.5 5.5h13" />
        <path d="M7.5 3.5h5" />
        <path d="M5.5 5.5l.7 11h7.6l.7-11" />
        <path d="M8.3 8.2v5.5M11.7 8.2v5.5" />
      </g>
    </IconFrame>
  );
}

export function MoveIcon() {
  return (
    <IconFrame>
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.5"
      >
        <path d="M2.5 6.5h5l1.4 1.7h8.6v7.3h-15z" />
        <path d="M11 3.5h5.5V9" />
        <path d="M16.3 3.7l-6 6" />
      </g>
    </IconFrame>
  );
}
