import type React from "react";

interface HoverRowProps {
  children: React.ReactNode;
  onClick?: () => void;
  style?: React.CSSProperties;
}

export function HoverRow({ children, onClick, style }: HoverRowProps) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderBottom: "1px solid var(--border)",
        borderRadius: 6,
        transition: "background 0.1s",
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
      onClick={onClick}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "var(--bg2)";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.background = "transparent";
      }}
    >
      {children}
    </div>
  );
}
