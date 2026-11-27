import { JSON_RPC_ERROR_CODES, McpError } from "@earendil-works/pi-mcp";
import type { Card, CardActionRequest, CardActionResult, CardElement, CardSelectOption } from "../../shared/cards.ts";
import { t } from "../../shared/i18n.ts";

export type McpElicitationAction = "accept" | "decline" | "cancel";
export type McpElicitationPrimitive = string | number | boolean | string[];
export type McpElicitationContent = Record<string, McpElicitationPrimitive>;

export type McpElicitationResult =
  | { action: "accept"; content?: McpElicitationContent }
  | { action: "decline" | "cancel" };

export interface ElicitationOption {
  value: string;
  label: string;
}

export type ElicitationField =
  | {
    name: string;
    label: string;
    hint?: string;
    required: boolean;
    sensitive: boolean;
    kind: "string";
    format?: "email" | "uri" | "date" | "date-time" | "password";
    minLength?: number;
    maxLength?: number;
    default?: string;
  }
  | {
    name: string;
    label: string;
    hint?: string;
    required: boolean;
    sensitive: boolean;
    kind: "enum";
    options: ElicitationOption[];
    default?: string;
  }
  | {
    name: string;
    label: string;
    hint?: string;
    required: boolean;
    sensitive: boolean;
    kind: "multi_enum";
    options: ElicitationOption[];
    minItems?: number;
    maxItems?: number;
    default?: string[];
  }
  | {
    name: string;
    label: string;
    hint?: string;
    required: boolean;
    sensitive: boolean;
    kind: "number";
    integer: boolean;
    min?: number;
    max?: number;
    default?: number;
  }
  | {
    name: string;
    label: string;
    hint?: string;
    required: boolean;
    sensitive: boolean;
    kind: "boolean";
    default?: boolean;
  };

export type ParsedMcpElicitation =
  | { mode: "form"; message: string; fields: ElicitationField[] }
  | { mode: "url"; message: string; url: string; elicitationId?: string };

export type ElicitationActionOutcome =
  | { ok: true; mcpResult: McpElicitationResult; cardResult: CardActionResult }
  | { ok: false; errors: Record<string, string> };

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonNegInt = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
const finiteNum = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;

function extractChoiceOptions(schema: Record<string, unknown>): ElicitationOption[] {
  const options: ElicitationOption[] = [];
  const seen = new Set<string>();
  const push = (value: unknown, label?: unknown) => {
    if (typeof value !== "string" || !value.trim() || seen.has(value)) return;
    seen.add(value);
    options.push({ value, label: typeof label === "string" && label.trim() ? label.trim() : value });
  };
  const choices = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (choices) {
    for (const entry of choices) {
      if (isObject(entry)) push(entry.const, entry.title);
    }
    return options;
  }
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
    schema.enum.forEach((value, index) => push(value, names[index]));
  }
  return options;
}

function parseField(name: string, schema: Record<string, unknown>, required: boolean): ElicitationField | undefined {
  const label = typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : name;
  const hint = typeof schema.description === "string" && schema.description.trim() ? schema.description.trim() : undefined;
  const sensitive = schema.writeOnly === true || schema.format === "password";
  const type = typeof schema.type === "string" ? schema.type : "string";

  if (type === "boolean") {
    return {
      name,
      label,
      ...(hint ? { hint } : {}),
      required,
      sensitive,
      kind: "boolean",
      ...(typeof schema.default === "boolean" ? { default: schema.default } : {}),
    };
  }
  if (type === "number" || type === "integer") {
    let min = finiteNum(schema.minimum);
    let max = finiteNum(schema.maximum);
    if (min !== undefined && max !== undefined && min > max) { min = undefined; max = undefined; }
    return {
      name,
      label,
      ...(hint ? { hint } : {}),
      required,
      sensitive,
      kind: "number",
      integer: type === "integer",
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(finiteNum(schema.default) !== undefined ? { default: schema.default as number } : {}),
    };
  }
  if (type === "array") {
    const items = isObject(schema.items) ? schema.items : undefined;
    const options = items ? extractChoiceOptions(items) : [];
    if (!options.length) {
      if (required) throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, `Unsupported required elicitation array field "${name}" without string enum options`);
      return undefined;
    }
    const validValues = new Set(options.map((option) => option.value));
    const defaults = Array.isArray(schema.default)
      ? schema.default.filter((item): item is string => typeof item === "string" && validValues.has(item))
      : undefined;
    const minItems = nonNegInt(schema.minItems);
    const maxItems = nonNegInt(schema.maxItems);
    return {
      name,
      label,
      ...(hint ? { hint } : {}),
      required,
      sensitive,
      kind: "multi_enum",
      options,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined && (minItems === undefined || maxItems >= minItems) ? { maxItems } : {}),
      ...(defaults?.length ? { default: defaults } : {}),
    };
  }

  if (type !== "string") {
    if (required) throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, `Unsupported required elicitation field "${name}" of type "${type}"`);
    return undefined;
  }

  const options = extractChoiceOptions(schema);
  if (options.length) {
    const defaultOption = typeof schema.default === "string" && options.some((option) => option.value === schema.default)
      ? schema.default
      : undefined;
    return {
      name,
      label,
      ...(hint ? { hint } : {}),
      required,
      sensitive,
      kind: "enum",
      options,
      ...(defaultOption !== undefined ? { default: defaultOption } : {}),
    };
  }

  let minLength = nonNegInt(schema.minLength);
  let maxLength = nonNegInt(schema.maxLength);
  if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) { minLength = undefined; maxLength = undefined; }
  const format = schema.format === "email" || schema.format === "uri" || schema.format === "date" || schema.format === "date-time" || schema.format === "password"
    ? schema.format
    : undefined;
  return {
    name,
    label,
    ...(hint ? { hint } : {}),
    required,
    sensitive,
    kind: "string",
    ...(format ? { format } : {}),
    ...(minLength !== undefined ? { minLength } : {}),
    ...(maxLength !== undefined ? { maxLength } : {}),
    ...(typeof schema.default === "string" ? { default: schema.default } : {}),
  };
}

/** 校验并解析标准 MCP `elicitation/create` 参数（支持 form 与 url 模式）。 */
export function parseElicitationRequest(params: unknown): ParsedMcpElicitation {
  if (!isObject(params)) throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, "Invalid elicitation/create params");
  const message = typeof params.message === "string" ? params.message.trim() : "";
  if (!message) throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, "elicitation/create requires a non-empty message");
  const mode = params.mode === undefined ? "form" : params.mode;

  if (mode === "url") {
    const rawUrl = typeof params.url === "string" ? params.url.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, "elicitation/create url mode requires a valid http(s) url");
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, "elicitation/create url must use http or https");
    }
    const elicitationId = typeof params.elicitationId === "string" && params.elicitationId.trim() ? params.elicitationId.trim() : undefined;
    return { mode: "url", message, url: parsedUrl.toString(), ...(elicitationId ? { elicitationId } : {}) };
  }

  if (mode !== "form") {
    throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, `Unsupported elicitation mode: ${String(mode)}`);
  }

  const fields: ElicitationField[] = [];
  if (params.requestedSchema !== undefined) {
    if (!isObject(params.requestedSchema)) {
      throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, "elicitation/create requestedSchema must be an object");
    }
    if (params.requestedSchema.type !== undefined && params.requestedSchema.type !== "object") {
      throw new McpError(JSON_RPC_ERROR_CODES.invalidParams, "elicitation/create requestedSchema.type must be object");
    }
    const requiredSet = new Set(
      Array.isArray(params.requestedSchema.required)
        ? params.requestedSchema.required.filter((item): item is string => typeof item === "string")
        : [],
    );
    const properties = isObject(params.requestedSchema.properties) ? params.requestedSchema.properties : {};
    for (const [name, raw] of Object.entries(properties)) {
      if (!name.trim() || !isObject(raw)) continue;
      const field = parseField(name, raw, requiredSet.has(name));
      if (field) fields.push(field);
    }
  }
  return { mode: "form", message, fields };
}

function toDatetimeLocal(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)/.exec(value.trim());
  return match ? match[1] : undefined;
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isValidIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return false;
  return !Number.isNaN(Date.parse(value));
}

function fieldToCardElement(field: ElicitationField, redact: (text: string) => string): CardElement {
  const label = redact(field.label);
  const hint = field.hint ? redact(field.hint) : undefined;
  if (field.kind === "boolean") {
    return {
      tag: "checker",
      name: field.name,
      text: hint ? `${label}（${hint}）` : label,
      ...(field.default !== undefined ? { checked: field.default } : {}),
    };
  }
  if (field.kind === "enum") {
    const options: CardSelectOption[] = field.options.map((option) => ({ text: redact(option.label), value: option.value }));
    return {
      tag: "select_static",
      name: field.name,
      label,
      ...(hint ? { hint } : {}),
      options,
      ...(field.default !== undefined ? { initial_option: field.default } : {}),
      ...(field.required ? { required: true } : {}),
    };
  }
  if (field.kind === "multi_enum") {
    const options: CardSelectOption[] = field.options.map((option) => ({ text: redact(option.label), value: option.value }));
    return {
      tag: "multi_select_static",
      name: field.name,
      label,
      ...(hint ? { hint } : {}),
      options,
      ...(field.default?.length ? { initial_options: field.default } : {}),
      ...(field.required ? { required: true } : {}),
    };
  }
  if (field.kind === "number") {
    return {
      tag: "input",
      name: field.name,
      label,
      ...(hint ? { hint } : {}),
      input_type: "number",
      ...(field.min !== undefined ? { min: field.min } : {}),
      ...(field.max !== undefined ? { max: field.max } : {}),
      ...(field.default !== undefined ? { default_value: field.default } : {}),
      ...(field.required ? { required: true } : {}),
    };
  }
  if (field.format === "date") {
    return {
      tag: "date_picker",
      name: field.name,
      label,
      ...(hint ? { hint } : {}),
      ...(field.default && isValidIsoDate(field.default) ? { initial_date: field.default } : {}),
      ...(field.required ? { required: true } : {}),
    };
  }
  if (field.format === "date-time") {
    const initial = field.default ? toDatetimeLocal(field.default) : undefined;
    return {
      tag: "picker_datetime",
      name: field.name,
      label,
      ...(hint ? { hint } : {}),
      ...(initial ? { initial_datetime: initial } : {}),
      ...(field.required ? { required: true } : {}),
    };
  }
  return {
    tag: "input",
    name: field.name,
    label,
    ...(hint ? { hint } : {}),
    input_type: field.sensitive ? "password" : "text",
    ...(field.minLength !== undefined ? { min_length: field.minLength } : {}),
    ...(field.maxLength !== undefined ? { max_length: field.maxLength } : {}),
    ...(field.default !== undefined ? { default_value: field.default } : {}),
    ...(field.required ? { required: true } : {}),
  };
}

/** 把标准 MCP `elicitation/create` 翻译成 Hob 卡片 JSON 2.0。 */
export function buildElicitationCard(parsed: ParsedMcpElicitation, pluginName: string, redact: (text: string) => string = (text) => text): Card {
  const safeMessage = redact(parsed.message);
  if (parsed.mode === "url") {
    return {
      header: { title: t("{plugin} 请求外部确认", { plugin: pluginName }) },
      body: {
        elements: [
          { tag: "markdown", content: safeMessage },
          { tag: "div", text: parsed.url },
          { tag: "button", text: t("打开链接"), type: "primary_filled", behaviors: [{ type: "open_url", default_url: parsed.url }] },
          { tag: "button", text: t("已完成"), type: "default", behaviors: [{ type: "callback", value: { elicitation_action: "accept" } }] },
          { tag: "button", text: t("取消"), type: "default", behaviors: [{ type: "callback", value: { elicitation_action: "cancel" } }] },
        ],
      },
    };
  }

  if (!parsed.fields.length) {
    return {
      header: { title: t("{plugin} 请求确认", { plugin: pluginName }) },
      body: {
        elements: [
          { tag: "markdown", content: safeMessage },
          { tag: "button", text: t("允许"), type: "primary_filled", behaviors: [{ type: "callback", value: { elicitation_action: "accept" } }] },
          { tag: "button", text: t("拒绝"), type: "danger", behaviors: [{ type: "callback", value: { elicitation_action: "decline" } }] },
          { tag: "button", text: t("取消"), type: "default", behaviors: [{ type: "callback", value: { elicitation_action: "cancel" } }] },
        ],
      },
    };
  }

  // 拒绝与取消按钮放在 form 外面：未填必填项时也可以直接拒绝或取消。
  return {
    header: { title: t("{plugin} 请求确认", { plugin: pluginName }) },
    body: {
      elements: [
        { tag: "markdown", content: safeMessage },
        {
          tag: "form",
          name: "elicitation",
          elements: [
            ...parsed.fields.map((field) => fieldToCardElement(field, redact)),
            {
              tag: "button",
              text: t("提交"),
              type: "primary_filled",
              form_action_type: "submit",
              behaviors: [{ type: "callback", value: { elicitation_action: "accept" } }],
            },
          ],
        },
        { tag: "button", text: t("拒绝"), type: "danger", behaviors: [{ type: "callback", value: { elicitation_action: "decline" } }] },
        { tag: "button", text: t("取消"), type: "default", behaviors: [{ type: "callback", value: { elicitation_action: "cancel" } }] },
      ],
    },
  };
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function decisionOf(action: Record<string, unknown>): McpElicitationAction {
  const explicit = action.elicitation_action;
  if (explicit === "accept" || explicit === "decline" || explicit === "cancel") return explicit;
  if (action.tag === "form") return "accept";
  return "cancel";
}

/** 校验用户对 Elicitation 卡片的操作，生成发回 MCP 服务的 ElicitResult 与展示用的 CardActionResult。 */
export function resolveElicitationAction(parsed: ParsedMcpElicitation, input: CardActionRequest): ElicitationActionOutcome {
  const decision = decisionOf(input.action);
  if (decision === "decline" || decision === "cancel") {
    return {
      ok: true,
      mcpResult: { action: decision },
      cardResult: {
        action: input.action,
        buttonText: input.button_text || (decision === "decline" ? t("已拒绝") : t("已取消")),
      },
    };
  }

  if (parsed.mode === "url") {
    return {
      ok: true,
      mcpResult: { action: "accept" },
      cardResult: {
        action: input.action,
        buttonText: input.button_text || t("已完成"),
      },
    };
  }

  if (!parsed.fields.length) {
    return {
      ok: true,
      mcpResult: { action: "accept", content: {} },
      cardResult: {
        action: input.action,
        buttonText: input.button_text || t("已允许"),
      },
    };
  }

  const rawValues = isObject(input.form_value) ? input.form_value : {};
  const content: McpElicitationContent = {};
  const displayFields: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const field of parsed.fields) {
    const raw = rawValues[field.name];
    if (field.kind === "boolean") {
      const value = typeof raw === "boolean" ? raw : field.default ?? false;
      content[field.name] = value;
      displayFields[field.name] = value;
      continue;
    }

    if (isEmptyValue(raw)) {
      if (field.required) errors[field.name] = t("这是必填项");
      continue;
    }

    if (field.kind === "number") {
      const parsedNum = typeof raw === "number" ? raw : Number(String(raw).trim());
      if (!Number.isFinite(parsedNum)) {
        errors[field.name] = t("请输入有效数字");
        continue;
      }
      if (field.integer && !Number.isInteger(parsedNum)) {
        errors[field.name] = t("请输入整数");
        continue;
      }
      if (field.min !== undefined && parsedNum < field.min) {
        errors[field.name] = t("不能小于 {value}", { value: field.min });
        continue;
      }
      if (field.max !== undefined && parsedNum > field.max) {
        errors[field.name] = t("不能大于 {value}", { value: field.max });
        continue;
      }
      content[field.name] = parsedNum;
      displayFields[field.name] = parsedNum;
      continue;
    }

    if (field.kind === "enum") {
      const selected = String(raw);
      const option = field.options.find((item) => item.value === selected);
      if (!option) {
        errors[field.name] = t("请选择有效选项");
        continue;
      }
      content[field.name] = selected;
      displayFields[field.name] = option.label;
      continue;
    }

    if (field.kind === "multi_enum") {
      const selected = Array.isArray(raw) ? raw.map(String) : [];
      const optionMap = new Map(field.options.map((item) => [item.value, item.label]));
      if (selected.some((item) => !optionMap.has(item))) {
        errors[field.name] = t("请选择有效选项");
        continue;
      }
      if (field.minItems !== undefined && selected.length < field.minItems) {
        errors[field.name] = t("至少选 {count} 项", { count: field.minItems });
        continue;
      }
      if (field.maxItems !== undefined && selected.length > field.maxItems) {
        errors[field.name] = t("最多选 {count} 项", { count: field.maxItems });
        continue;
      }
      content[field.name] = selected;
      displayFields[field.name] = selected.map((item) => optionMap.get(item) ?? item);
      continue;
    }

    const text = String(raw);
    const length = [...text].length;
    if (field.minLength !== undefined && length < field.minLength) {
      errors[field.name] = t("至少 {count} 个字", { count: field.minLength });
      continue;
    }
    if (field.maxLength !== undefined && length > field.maxLength) {
      errors[field.name] = t("最多 {count} 个字", { count: field.maxLength });
      continue;
    }
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim())) {
      errors[field.name] = t("请输入有效邮箱");
      continue;
    }
    if (field.format === "uri") {
      try {
        new URL(text.trim());
      } catch {
        errors[field.name] = t("请输入有效网址");
        continue;
      }
    }
    if (field.format === "date" && !isValidIsoDate(text.trim())) {
      errors[field.name] = t("请输入有效日期（YYYY-MM-DD）");
      continue;
    }
    if (field.format === "date-time" && !isValidIsoDateTime(text.trim())) {
      errors[field.name] = t("请输入有效日期时间");
      continue;
    }
    content[field.name] = text;
    displayFields[field.name] = field.sensitive ? "••••••" : text;
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    mcpResult: { action: "accept", content },
    cardResult: {
      action: input.action,
      buttonText: input.button_text || t("已提交"),
      fields: displayFields,
    },
  };
}
