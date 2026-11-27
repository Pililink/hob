// 标准 MCP elicitation/create 假服务：覆盖 form（无字段/多字段）、url、连续追问、服务端取消。
const LATEST = "2025-11-25";

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let clientCapabilities = {};
let nextServerId = 1;
const pendingElicitations = new Map();

function sendElicitation(params) {
  const id = `elicit-${nextServerId++}`;
  return {
    id,
    promise: new Promise((resolve, reject) => {
      pendingElicitations.set(id, { resolve, reject });
      write({ jsonrpc: "2.0", id, method: "elicitation/create", params });
    }),
  };
}

const TOOLS = [
  {
    name: "capabilities",
    description: "返回客户端在 initialize 中声明的 capabilities",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "confirm_exec",
    description: "请求用户确认后再执行命令",
    inputSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
  {
    name: "form_exec",
    description: "通过结构化表单收集执行参数",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "url_auth",
    description: "通过 URL 模式请求外部确认",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "chained_exec",
    description: "单次工具调用连续触发两次 elicitation",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "cancel_by_server",
    description: "发出 elicitation 后由服务端主动取消",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "url_complete_notify",
    description: "URL 确认后由服务端推送 notifications/elicitation/complete 自动完成",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "url_error_retry",
    description: "首次返回 -32042 URLElicitationRequiredError，重试后成功",
    inputSchema: { type: "object", properties: { key: { type: "string" } } },
  },
];

const retriedKeys = new Set();

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    void handle(JSON.parse(line));
  }
});

async function handle(message) {
  // Response to server-initiated elicitation/create
  if (message.id !== undefined && !message.method) {
    const pending = pendingElicitations.get(message.id);
    if (!pending) return;
    pendingElicitations.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message || "elicitation error"));
    else pending.resolve(message.result);
    return;
  }

  if (message.method === "initialize") {
    clientCapabilities = message.params?.capabilities ?? {};
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: "hob-elicitation-fixture", version: "1.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") return;
  if (message.method === "tools/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    try {
      if (name === "capabilities") {
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(clientCapabilities) }] } });
        return;
      }
      if (name === "confirm_exec") {
        const { promise } = sendElicitation({
          mode: "form",
          message: `确定要执行 \`${args.command ?? ""}\` 吗？`,
          requestedSchema: { type: "object", properties: {} },
        });
        const res = await promise;
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ command: args.command, elicit: res }) }] } });
        return;
      }
      if (name === "form_exec") {
        const { promise } = sendElicitation({
          mode: "form",
          message: "请补充发布参数",
          requestedSchema: {
            type: "object",
            properties: {
              reason: { type: "string", title: "变更原因", description: "简述本次变更目的", minLength: 3 },
              env: {
                type: "string",
                title: "目标环境",
                oneOf: [
                  { const: "staging", title: "预发环境" },
                  { const: "prod", title: "生产环境" },
                ],
                default: "staging",
              },
              retries: { type: "integer", title: "重试次数", minimum: 1, maximum: 5, default: 2 },
              dryRun: { type: "boolean", title: "仅演练", default: false },
              tags: {
                type: "array",
                title: "标签",
                items: { type: "string", enum: ["canary", "rollback", "notify"], enumNames: ["灰度", "可回滚", "通知群"] },
              },
              secret: { type: "string", title: "口令", format: "password", writeOnly: true },
            },
            required: ["reason", "env", "retries"],
          },
        });
        const res = await promise;
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(res) }] } });
        return;
      }
      if (name === "url_auth") {
        const { promise } = sendElicitation({
          mode: "url",
          message: "请在浏览器完成二次认证后返回点击已完成。",
          url: "https://auth.example.com/approve?ticket=42",
          elicitationId: "ticket-42",
        });
        const res = await promise;
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(res) }] } });
        return;
      }
      if (name === "chained_exec") {
        const first = await sendElicitation({
          mode: "form",
          message: "第一步：确认目标节点 prod-01",
          requestedSchema: { type: "object", properties: {} },
        }).promise;
        if (first.action !== "accept") {
          write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ step: 1, first }) }] } });
          return;
        }
        const second = await sendElicitation({
          mode: "form",
          message: "第二步：确认执行重启",
          requestedSchema: { type: "object", properties: {} },
        }).promise;
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ first, second }) }] } });
        return;
      }
      if (name === "cancel_by_server") {
        const { id, promise } = sendElicitation({
          mode: "form",
          message: "服务端即将超时取消这条审批",
          requestedSchema: { type: "object", properties: {} },
        });
        setTimeout(() => {
          write({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } });
        }, 50);
        const res = await promise;
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ cancelled: true, res }) }] } });
        return;
      }
      if (name === "url_complete_notify") {
        const { promise } = sendElicitation({
          mode: "url",
          message: "请前往外部页面完成授权（服务端完成后会自动通知）",
          url: "https://oauth.example.com/callback?id=notify-1",
          elicitationId: "notify-1",
        });
        setTimeout(() => {
          write({ jsonrpc: "2.0", method: "notifications/elicitation/complete", params: { elicitationId: "notify-1" } });
        }, 60);
        const res = await promise;
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify({ notified: true, res }) }] } });
        return;
      }
      if (name === "url_error_retry") {
        const key = String(args.key ?? "default");
        if (!retriedKeys.has(key)) {
          retriedKeys.add(key);
          write({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32042,
              message: "URL elicitation required",
              data: {
                elicitations: [
                  {
                    mode: "url",
                    elicitationId: `err-${key}`,
                    url: `https://oauth.example.com/authorize?key=${encodeURIComponent(key)}`,
                    message: "请先在浏览器完成 OAuth 授权",
                  },
                ],
              },
            },
          });
          return;
        }
        write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `oauth retry succeeded: ${key}` }] } });
        return;
      }
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
    } catch (error) {
      write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(error?.message || error) }], isError: true } });
    }
    return;
  }
  if (message.id !== undefined) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}
