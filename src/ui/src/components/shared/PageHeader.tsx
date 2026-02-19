import type React from "react";
import { css } from "../../styles/theme.js";

interface PageHeaderProps {
  title: string;
  count?: number;
  actions?: React.ReactNode;
  subtitle?: React.ReactNode;
}

export function PageHeader({ title, count, actions, subtitle }: PageHeaderProps) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <h2 style={{ fontSize: 18, fontWeight: 600 }}>
          {title}
          {count != null ? ` (${count})` : ""}
        </h2>
        {actions && <div style={css.row}>{actions}</div>}
      </div>
      {subtitle && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>{subtitle}</div>
      )}
    </div>
  );
}
