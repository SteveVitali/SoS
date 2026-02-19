import { useEffect, useState } from "react";

interface LastUpdatedProps {
  at: number | null;
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function LastUpdated({ at }: LastUpdatedProps) {
  const [, tick] = useState(0);

  useEffect(() => {
    if (at == null) return;
    const id = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, [at]);

  if (at == null) return null;

  const elapsed = Date.now() - at;

  return (
    <span
      style={{
        fontSize: 11,
        color: "var(--fg3)",
        fontWeight: 400,
        whiteSpace: "nowrap",
        opacity: 0.7,
      }}
      title={new Date(at).toLocaleTimeString()}
    >
      updated {formatElapsed(elapsed)}
    </span>
  );
}
