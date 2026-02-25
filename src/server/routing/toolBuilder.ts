/**
 * Converts YAML action definitions into LLM ToolDefinition[] for the routing LLM.
 */

import type { ToolDefinition } from "../llm/index.js";
import type { ActionDef, ParamDef, RoutingConfig } from "./routingTypes.js";

/**
 * Convert a YAML parameter definition map to JSON Schema properties + required array.
 */
function buildJsonSchema(params: Record<string, ParamDef>): {
  properties: Record<string, unknown>;
  required: string[];
} {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [name, def] of Object.entries(params)) {
    const prop: Record<string, unknown> = { type: def.type };
    if (def.description) prop.description = def.description;
    if (def.enum) prop.enum = def.enum;
    if (def.items) prop.items = def.items;
    properties[name] = prop;
    if (def.required) required.push(name);
  }

  return { properties, required };
}

/**
 * Build a tool description from the action's description + routing_hint.
 */
function buildDescription(action: ActionDef): string {
  let desc = action.description;
  if (action.routing_hint) {
    desc += ` ${action.routing_hint}`;
  }
  return desc;
}

/**
 * Build ToolDefinition[] from a RoutingConfig.
 * Includes both built-in actions and custom actions, filtered by enabled.
 */
export function buildToolsFromConfig(config: RoutingConfig): ToolDefinition[] {
  const tools: ToolDefinition[] = [];

  const allActions = { ...config.actions, ...config.custom_actions };

  for (const [name, action] of Object.entries(allActions)) {
    if (!action.enabled) continue;

    const { properties, required } = buildJsonSchema(action.parameters);

    tools.push({
      name,
      description: buildDescription(action),
      parameters: {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      },
    });
  }

  return tools;
}

/**
 * Build the "Available Actions" section for the system prompt.
 * This generates the action list that helps the LLM understand what each tool does.
 */
export function buildActionsPromptSection(config: RoutingConfig): string {
  const lines: string[] = ["## Available Actions (use the tools)", ""];

  const allActions = { ...config.actions, ...config.custom_actions };

  for (const [name, action] of Object.entries(allActions)) {
    if (!action.enabled) continue;
    const hint = action.routing_hint ? ` ${action.routing_hint}` : "";
    lines.push(`- **${name}**: ${action.description}${hint}`);
  }

  return lines.join("\n");
}
