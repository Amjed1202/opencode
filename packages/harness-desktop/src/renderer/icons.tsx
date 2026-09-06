import type { JSX } from "solid-js"

export function Icon(props: {
  name: "folder" | "plus" | "send" | "stop" | "refresh" | "chevron" | "close" | "shield" | "code" | "book" | "activity"
  size?: number
}) {
  const paths: Record<typeof props.name, JSX.Element> = {
    folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    send: (
      <>
        <path d="m5 12 7-7 7 7M12 5v15" />
      </>
    ),
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
    refresh: (
      <>
        <path d="M20 11a8 8 0 1 0-2 6M20 4v7h-7" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    shield: (
      <>
        <path d="m12 3 8 3v5c0 5-8 10-8 10S4 16 4 11V6Z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
    code: <path d="m8 6-6 6 6 6M16 6l6 6-6 6m-5 3 2-18" />,
    book: (
      <>
        <path d="M12 5c-3-2-6-2-10-1v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1Z" />
        <path d="M12 5v15" />
      </>
    ),
    activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  }
  return (
    <svg
      width={props.size ?? 18}
      height={props.size ?? 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[props.name]}
    </svg>
  )
}
