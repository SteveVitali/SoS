/**
 * Lightweight template engine for routing config reply templates.
 *
 * Supports:
 * - {{var}}           — interpolate variable
 * - {{var:start:end}} — interpolate with slice (e.g. {{task_id:0:8}})
 * - {{?var}}...{{/var}} — conditional block (render only if var is truthy)
 * - {{args.field}}    — nested access (one level: args.task_id, ctx.github_username)
 */

export interface TemplateContext {
  [key: string]: unknown;
  args?: Record<string, unknown>;
  ctx?: Record<string, unknown>;
  env?: Record<string, string>;
}

function resolve(ctx: TemplateContext, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function stringify(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Render a template string with the given context.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  if (!template) return "";

  let result = template;

  // 1. Conditional blocks: {{?var}}...{{/var}}
  result = result.replace(/\{\{\?([^}]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_match, varName, body) => {
    const val = resolve(ctx, varName.trim());
    if (!val || (Array.isArray(val) && val.length === 0)) return "";
    return body;
  });

  // 2. Interpolation with slice: {{var:start:end}}
  result = result.replace(/\{\{([^}:]+):(\d+):(\d+)\}\}/g, (_match, varName, startStr, endStr) => {
    const val = stringify(resolve(ctx, varName.trim()));
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return val.slice(start, end);
  });

  // 3. Simple interpolation: {{var}}
  result = result.replace(/\{\{([^}]+)\}\}/g, (_match, varName) => {
    // Support default values: {{var | default:"value"}}
    const defaultMatch = varName.match(/^(.+?)\s*\|\s*default:\s*"([^"]*)"$/);
    if (defaultMatch) {
      const val = resolve(ctx, defaultMatch[1].trim());
      return stringify(val) || defaultMatch[2];
    }
    return stringify(resolve(ctx, varName.trim()));
  });

  return result;
}
