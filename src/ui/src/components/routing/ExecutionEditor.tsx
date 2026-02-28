import { useState } from "react";
import { stringify as stringifyYaml } from "yaml";
import { css } from "../../styles/theme.js";

interface ExecutionFieldProps {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  execution: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  onUpdate: (field: string, value: any) => void;
}

const EXECUTION_TYPES = [
  "reply",
  "create_job",
  "job_action",
  "job_query",
  "job_list",
  "create_respond_job",
  "github_query",
  "shell",
  "webhook",
  "agent_task",
  "dispatch",
] as const;

const JOB_ACTION_METHODS = ["cancel", "retry", "confirm", "promote"] as const;
const WEBHOOK_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

// --- Shared sub-components ---

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <span style={{ ...css.label, fontSize: 12 }}>{label}</span>
      {children}
    </div>
  );
}

function TextInput({
  value,
  onChange,
  placeholder,
  mono,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      style={{
        ...css.input,
        fontSize: 12,
        ...(mono ? { fontFamily: "'SF Mono', Monaco, Consolas, monospace" } : {}),
      }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function NumberInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      style={{ ...css.input, fontSize: 12, maxWidth: 160 }}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : undefined)}
      placeholder={placeholder}
    />
  );
}

function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label
      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, cursor: "pointer" }}
    >
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

function MonoTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  minHeight,
}: {
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  minHeight?: number;
}) {
  return (
    <textarea
      style={{
        ...css.textarea,
        minHeight: minHeight ?? 60,
        fontFamily: "'SF Mono', Monaco, Consolas, monospace",
        fontSize: 12,
      }}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      placeholder={placeholder}
      spellCheck={false}
    />
  );
}

function ChipsInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  return (
    <input
      style={{ ...css.input, fontSize: 12 }}
      value={values.join(", ")}
      onChange={(e) => {
        const val = e.target.value.trim();
        onChange(val ? val.split(",").map((s) => s.trim()) : []);
      }}
      placeholder={placeholder}
    />
  );
}

// --- Reply templates sub-component ---

function ReplyTemplatesEditor({
  execution,
  onChange,
  fields,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  execution: Record<string, any>;
  onChange: (field: string, value: string) => void;
  fields: Array<{ key: string; label: string; multiline?: boolean }>;
}) {
  if (fields.length === 0) return null;

  return (
    <div
      style={{
        borderTop: "1px solid var(--border)",
        paddingTop: 10,
        marginTop: 10,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--fg2)", marginBottom: 8 }}>
        Reply Templates
      </div>
      {fields.map((f) =>
        f.multiline ? (
          <Field key={f.key} label={f.label}>
            <MonoTextarea
              value={execution[f.key] || ""}
              onChange={(v) => onChange(f.key, v)}
              placeholder={f.label}
              minHeight={50}
            />
          </Field>
        ) : (
          <Field key={f.key} label={f.label}>
            <TextInput
              value={execution[f.key] || ""}
              onChange={(v) => onChange(f.key, v)}
              placeholder={`{{template}}`}
              mono
            />
          </Field>
        ),
      )}
    </div>
  );
}

// --- Type-specific editors ---

function ReplyFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <Checkbox
      checked={execution.silent ?? false}
      onChange={(v) => onUpdate("silent", v || undefined)}
      label="Silent (no reply sent)"
    />
  );
}

function CreateJobFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <Checkbox
        checked={execution.needs_plan ?? false}
        onChange={(v) => onUpdate("needs_plan", v || undefined)}
        label="Needs plan (planning mode)"
      />
      <Field label="Custom Instructions">
        <MonoTextarea
          value={execution.custom_instructions || ""}
          onChange={(v) => onUpdate("custom_instructions", v || undefined)}
          placeholder="Optional agent instructions template"
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "reply_success", label: "Success" },
          { key: "reply_error", label: "Error" },
        ]}
      />
    </>
  );
}

function JobActionFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
        <Field label="Method">
          <select
            style={css.select}
            value={execution.method || ""}
            onChange={(e) => onUpdate("method", e.target.value)}
          >
            <option value="">—</option>
            {JOB_ACTION_METHODS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Require Status">
          <TextInput
            value={execution.require_status || ""}
            onChange={(v) => onUpdate("require_status", v || undefined)}
            placeholder="e.g. PENDING_CONFIRMATION"
          />
        </Field>
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 10 }}>
        <Checkbox
          checked={execution.require_pr ?? false}
          onChange={(v) => onUpdate("require_pr", v || undefined)}
          label="Require PR"
        />
      </div>
      <Field label="Extra Args (comma-separated)">
        <ChipsInput
          values={execution.extra_args || []}
          onChange={(v) => onUpdate("extra_args", v.length ? v : undefined)}
          placeholder="e.g. revised_task_text, reviewers"
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "reply_success", label: "Success" },
          { key: "reply_not_found", label: "Not Found" },
          { key: "reply_wrong_status", label: "Wrong Status" },
          { key: "reply_no_pr", label: "No PR" },
          { key: "reply_failed", label: "Failed" },
          { key: "reply_error", label: "Error" },
        ]}
      />
    </>
  );
}

function JobQueryFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <ReplyTemplatesEditor
      execution={execution}
      onChange={onUpdate}
      fields={[
        { key: "reply_template", label: "Reply Template", multiline: true },
        { key: "reply_not_found", label: "Not Found" },
      ]}
    />
  );
}

function JobListFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <Field label="Default Limit">
        <NumberInput
          value={execution.default_limit}
          onChange={(v) => onUpdate("default_limit", v)}
          placeholder="5"
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "item_template", label: "Item Template" },
          { key: "reply_empty", label: "Empty" },
        ]}
      />
    </>
  );
}

function CreateRespondJobFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <ReplyTemplatesEditor
      execution={execution}
      onChange={onUpdate}
      fields={[
        { key: "reply_success", label: "Success" },
        { key: "reply_not_found", label: "Not Found" },
        { key: "reply_no_pr", label: "No PR" },
        { key: "reply_missing_input", label: "Missing Input" },
        { key: "reply_error", label: "Error" },
      ]}
    />
  );
}

function GithubQueryFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <Field label="Instant Types (comma-separated)">
        <ChipsInput
          values={execution.instant_types || []}
          onChange={(v) => onUpdate("instant_types", v.length ? v : undefined)}
          placeholder="my_review_requests, my_open_prs, ..."
        />
      </Field>
      <Field label="Summary Types (comma-separated)">
        <ChipsInput
          values={execution.summary_types || []}
          onChange={(v) => onUpdate("summary_types", v.length ? v : undefined)}
          placeholder="my_recap, team_recap"
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "reply_summary_queued", label: "Summary Queued" },
          { key: "reply_error", label: "Error" },
          { key: "reply_rate_limited", label: "Rate Limited" },
          { key: "reply_unknown_type", label: "Unknown Type" },
        ]}
      />
    </>
  );
}

function ShellFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <Field label="Command">
        <MonoTextarea
          value={execution.command || ""}
          onChange={(v) => onUpdate("command", v)}
          placeholder="sh -c '...'"
        />
      </Field>
      <Field label="Timeout (seconds)">
        <NumberInput
          value={execution.timeout_seconds}
          onChange={(v) => onUpdate("timeout_seconds", v)}
          placeholder="30"
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "reply_template", label: "Reply Template" },
          { key: "reply_empty", label: "Empty" },
          { key: "reply_error", label: "Error" },
        ]}
      />
    </>
  );
}

function JsonTextarea({
  value,
  onChange,
  placeholder,
  minHeight,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  value: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  onChange: (v: any) => void;
  placeholder?: string;
  minHeight?: number;
}) {
  const [text, setText] = useState(() => (value ? JSON.stringify(value, null, 2) : ""));
  const [jsonError, setJsonError] = useState("");

  const handleBlur = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      onChange(undefined);
      setJsonError("");
      return;
    }
    try {
      onChange(JSON.parse(trimmed));
      setJsonError("");
    } catch {
      setJsonError("Invalid JSON");
    }
  };

  return (
    <>
      <MonoTextarea
        value={text}
        onChange={setText}
        onBlur={handleBlur}
        placeholder={placeholder}
        minHeight={minHeight}
      />
      {jsonError && (
        <div style={{ fontSize: 11, color: "var(--red)", marginTop: 2 }}>{jsonError}</div>
      )}
    </>
  );
}

function WebhookFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        <div style={{ minWidth: 100 }}>
          <Field label="Method">
            <select
              style={css.select}
              value={execution.method || "POST"}
              onChange={(e) => onUpdate("method", e.target.value)}
            >
              {WEBHOOK_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="URL">
            <TextInput
              value={execution.url || ""}
              onChange={(v) => onUpdate("url", v)}
              placeholder="https://..."
              mono
            />
          </Field>
        </div>
      </div>
      <Field label="Headers (JSON)">
        <JsonTextarea
          value={execution.headers}
          onChange={(v) => onUpdate("headers", v)}
          placeholder='{"Authorization": "Bearer {{env.TOKEN}}"}'
          minHeight={40}
        />
      </Field>
      <Field label="Body (JSON)">
        <JsonTextarea
          value={execution.body}
          onChange={(v) => onUpdate("body", v)}
          placeholder="{}"
          minHeight={40}
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "reply_success", label: "Success" },
          { key: "reply_error", label: "Error" },
        ]}
      />
    </>
  );
}

function AgentTaskFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <Field label="Instructions">
        <MonoTextarea
          value={execution.instructions || ""}
          onChange={(v) => onUpdate("instructions", v)}
          placeholder="Agent task instructions (supports {{template}} vars)"
          minHeight={120}
        />
      </Field>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Field label="Repo Hint">
          <TextInput
            value={execution.repo_hint || ""}
            onChange={(v) => onUpdate("repo_hint", v || undefined)}
            placeholder="e.g. son-of-steve"
          />
        </Field>
        <Field label="Test Level">
          <TextInput
            value={execution.test_level || ""}
            onChange={(v) => onUpdate("test_level", v || undefined)}
            placeholder="fast / full / none"
          />
        </Field>
      </div>
      <Field label="Reviewers (comma-separated)">
        <ChipsInput
          values={execution.reviewers || []}
          onChange={(v) => onUpdate("reviewers", v.length ? v : undefined)}
          placeholder="github-user1, github-user2"
        />
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[
          { key: "reply_queued", label: "Queued" },
          { key: "reply_error", label: "Error" },
        ]}
      />
    </>
  );
}

function DispatchFields({ execution, onUpdate }: ExecutionFieldProps) {
  return (
    <>
      <Field label="Dispatch On (parameter key)">
        <TextInput
          value={execution.on || ""}
          onChange={(v) => onUpdate("on", v)}
          placeholder="e.g. args.query_type"
          mono
        />
      </Field>
      <Field label="Routes (YAML)">
        <MonoTextarea
          value={execution.routes ? stringifyYaml(execution.routes, { lineWidth: 100 }) : ""}
          onChange={() => {
            // Editing routes via YAML is complex; kept read-only for now
          }}
          placeholder="Route definitions"
          minHeight={80}
        />
        <div style={{ fontSize: 11, color: "var(--fg3)", marginTop: 4 }}>
          Edit dispatch routes in the YAML view for full control.
        </div>
      </Field>
      <ReplyTemplatesEditor
        execution={execution}
        onChange={onUpdate}
        fields={[{ key: "reply_unknown", label: "Unknown Route" }]}
      />
    </>
  );
}

// --- Main ExecutionEditor ---

export function ExecutionEditor({
  execution,
  onChange,
}: {
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  execution: Record<string, any>;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  onChange: (updated: Record<string, any>) => void;
}) {
  const execType = execution?.type || "";

  // biome-ignore lint/suspicious/noExplicitAny: dynamic config type
  const onUpdate = (field: string, value: any) => {
    onChange({ ...execution, [field]: value });
  };

  const handleTypeChange = (newType: string) => {
    // Preserve existing fields — harmless extra keys are stripped on save
    onChange({ ...execution, type: newType });
  };

  return (
    <div>
      <Field label="Execution Type">
        <select
          style={{ ...css.select, minWidth: 200 }}
          value={execType}
          onChange={(e) => handleTypeChange(e.target.value)}
        >
          <option value="">—</option>
          {EXECUTION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>

      {execType === "reply" && <ReplyFields execution={execution} onUpdate={onUpdate} />}
      {execType === "create_job" && <CreateJobFields execution={execution} onUpdate={onUpdate} />}
      {execType === "job_action" && <JobActionFields execution={execution} onUpdate={onUpdate} />}
      {execType === "job_query" && <JobQueryFields execution={execution} onUpdate={onUpdate} />}
      {execType === "job_list" && <JobListFields execution={execution} onUpdate={onUpdate} />}
      {execType === "create_respond_job" && (
        <CreateRespondJobFields execution={execution} onUpdate={onUpdate} />
      )}
      {execType === "github_query" && (
        <GithubQueryFields execution={execution} onUpdate={onUpdate} />
      )}
      {execType === "shell" && <ShellFields execution={execution} onUpdate={onUpdate} />}
      {execType === "webhook" && <WebhookFields execution={execution} onUpdate={onUpdate} />}
      {execType === "agent_task" && <AgentTaskFields execution={execution} onUpdate={onUpdate} />}
      {execType === "dispatch" && <DispatchFields execution={execution} onUpdate={onUpdate} />}
    </div>
  );
}
