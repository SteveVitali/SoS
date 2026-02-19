import type React from "react";

const spinKeyframes = `
@keyframes sos-spin {
  to { transform: rotate(360deg); }
}
`;

let styleInjected = false;
function injectStyle() {
  if (styleInjected) return;
  const style = document.createElement("style");
  style.textContent = spinKeyframes;
  document.head.appendChild(style);
  styleInjected = true;
}

interface SpinnerProps {
  size?: number;
  label?: string;
  style?: React.CSSProperties;
}

export function Spinner({ size = 28, label, style }: SpinnerProps) {
  injectStyle();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: "40px 20px",
        ...style,
      }}
    >
      <div
        style={{
          width: size,
          height: size,
          border: "3px solid var(--border)",
          borderTopColor: "var(--accent)",
          borderRadius: "50%",
          animation: "sos-spin 0.7s linear infinite",
        }}
      />
      {label && <span style={{ fontSize: 13, color: "var(--fg3)", fontWeight: 500 }}>{label}</span>}
    </div>
  );
}
