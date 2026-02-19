import { css } from "../../styles/theme.js";

interface CommandEditorProps {
  label: string;
  value: string[] | undefined;
  onChange: (v: string[] | undefined) => void;
}

export function CommandEditor({ label, value, onChange }: CommandEditorProps) {
  const text = (value || []).join(" ");
  return (
    <div style={css.field}>
      <label style={css.label}>{label}</label>
      <input
        style={css.input}
        value={text}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v ? v.split(/\s+/) : undefined);
        }}
        placeholder="e.g. npm run lint"
      />
    </div>
  );
}
