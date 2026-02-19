import { useState } from "react";
import { css } from "../styles/theme.js";

interface TokenSetupProps {
  onSet: () => void;
}

export function TokenSetup({ onSet }: TokenSetupProps) {
  const [token, setToken] = useState("");
  return (
    <div style={css.tokenSetup}>
      <h2 style={{ marginBottom: 16 }}>Son of Steve</h2>
      <p style={{ color: "var(--fg2)", marginBottom: 16, fontSize: 14 }}>
        Enter your API token (SOS_INTERNAL_API_TOKEN) to access the dashboard.
      </p>
      <div style={css.field}>
        <input
          style={css.input}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="API token"
          onKeyDown={(e) => {
            if (e.key === "Enter" && token) {
              localStorage.setItem("sos_token", token);
              onSet();
            }
          }}
        />
      </div>
      <button
        style={css.btnPrimary}
        onClick={() => {
          localStorage.setItem("sos_token", token);
          onSet();
        }}
      >
        Connect
      </button>
    </div>
  );
}
