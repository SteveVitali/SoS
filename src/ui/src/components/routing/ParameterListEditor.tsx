import { useRef, useState } from "react";
import { css } from "../../styles/theme.js";

interface ParamDef {
  type: "string" | "number" | "boolean" | "array";
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: { type: string };
}

let nextParamId = 0;
function genParamId(): string {
  return `p-${++nextParamId}`;
}

const PARAM_TYPES = ["string", "number", "boolean", "array"] as const;

function ParameterCard({
  name,
  param,
  onChange,
  onRemove,
  onRename,
}: {
  name: string;
  param: ParamDef;
  onChange: (updated: ParamDef) => void;
  onRemove: () => void;
  onRename: (newName: string) => void;
}) {
  const [editName, setEditName] = useState(name);

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 12,
        background: "var(--bg)",
      }}
    >
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
        <input
          style={{ ...css.input, maxWidth: 160, fontWeight: 600, fontSize: 13 }}
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
          onBlur={() => {
            const trimmed = editName.trim();
            if (trimmed && trimmed !== name) onRename(trimmed);
            else setEditName(name);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          placeholder="param_name"
        />
        <select
          style={{ ...css.select, minWidth: 100 }}
          value={param.type}
          onChange={(e) => onChange({ ...param, type: e.target.value as ParamDef["type"] })}
        >
          {PARAM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <label
          style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, cursor: "pointer" }}
        >
          <input
            type="checkbox"
            checked={param.required ?? false}
            onChange={(e) => onChange({ ...param, required: e.target.checked || undefined })}
          />
          required
        </label>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          style={{ ...css.btnSmall, color: "var(--red)", border: "1px solid var(--red)" }}
          onClick={onRemove}
        >
          Remove
        </button>
      </div>
      <input
        style={{ ...css.input, fontSize: 12, marginBottom: 6 }}
        value={param.description || ""}
        onChange={(e) => onChange({ ...param, description: e.target.value || undefined })}
        placeholder="Description"
      />
      {param.type === "string" && (
        <input
          style={{ ...css.input, fontSize: 12 }}
          value={param.enum?.join(", ") || ""}
          onChange={(e) => {
            const val = e.target.value.trim();
            onChange({
              ...param,
              enum: val ? val.split(",").map((s) => s.trim()) : undefined,
            });
          }}
          placeholder="Enum values (comma-separated, leave blank for freeform)"
        />
      )}
      {param.type === "array" && (
        <input
          style={{ ...css.input, fontSize: 12 }}
          value={param.items?.type || "string"}
          onChange={(e) => onChange({ ...param, items: { type: e.target.value } })}
          placeholder="Items type (e.g. string)"
        />
      )}
    </div>
  );
}

export function ParameterListEditor({
  parameters,
  onChange,
}: {
  parameters: Record<string, ParamDef>;
  onChange: (updated: Record<string, ParamDef>) => void;
}) {
  const entries = Object.entries(parameters || {});

  // Maintain stable keys for each parameter by name
  const keyMapRef = useRef(new Map<string, string>());
  for (const [name] of entries) {
    if (!keyMapRef.current.has(name)) {
      keyMapRef.current.set(name, genParamId());
    }
  }

  const handleParamChange = (name: string, updated: ParamDef) => {
    onChange({ ...parameters, [name]: updated });
  };

  const handleRename = (oldName: string, newName: string) => {
    if (!newName || newName === oldName) return;
    // Transfer stable key to new name
    const stableKey = keyMapRef.current.get(oldName);
    if (stableKey) {
      keyMapRef.current.delete(oldName);
      keyMapRef.current.set(newName, stableKey);
    }
    const result: Record<string, ParamDef> = {};
    for (const [key, val] of Object.entries(parameters)) {
      result[key === oldName ? newName : key] = val;
    }
    onChange(result);
  };

  const handleRemove = (name: string) => {
    const next = { ...parameters };
    delete next[name];
    onChange(next);
  };

  const handleAdd = () => {
    let name = "new_param";
    let i = 1;
    while (parameters[name]) {
      name = `new_param_${i++}`;
    }
    onChange({ ...parameters, [name]: { type: "string", description: "" } });
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <span style={{ ...css.label, marginBottom: 0, flex: 1 }}>
          Parameters ({entries.length})
        </span>
        <button type="button" style={css.btnSmall} onClick={handleAdd}>
          + Add
        </button>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {entries.map(([name, param]) => (
          <ParameterCard
            key={keyMapRef.current.get(name)}
            name={name}
            param={param}
            onChange={(updated) => handleParamChange(name, updated)}
            onRemove={() => handleRemove(name)}
            onRename={(newName) => handleRename(name, newName)}
          />
        ))}
        {entries.length === 0 && (
          <div style={{ fontSize: 12, color: "var(--fg3)", fontStyle: "italic" }}>
            No parameters defined.
          </div>
        )}
      </div>
    </div>
  );
}
