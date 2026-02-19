import { Link } from "react-router-dom";

interface NavTabProps {
  to: string;
  label: string;
  active: boolean;
}

export function NavTab({ to, label, active }: NavTabProps) {
  return (
    <Link
      to={to}
      style={{
        padding: "8px 16px",
        borderBottom: active ? "2px solid var(--accent)" : "2px solid transparent",
        color: active ? "var(--fg)" : "var(--fg3)",
        fontWeight: active ? 600 : 400,
        fontSize: 14,
        textDecoration: "none",
        transition: "color 0.1s, border-color 0.1s",
      }}
    >
      {label}
    </Link>
  );
}
