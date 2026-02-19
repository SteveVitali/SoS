import type React from "react";
import { css } from "../../styles/theme.js";

interface PageHeaderProps {
  title: string;
  count?: number;
  actions?: React.ReactNode;
}

export function PageHeader({ title, count, actions }: PageHeaderProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        marginBottom: 16,
      }}
    >
      <h2 style={{ fontSize: 18, fontWeight: 600 }}>
        {title}
        {count != null ? ` (${count})` : ""}
      </h2>
      {actions && <div style={css.row}>{actions}</div>}
    </div>
  );
}
