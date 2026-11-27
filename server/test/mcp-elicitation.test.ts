import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { McpError } from "@earendil-works/pi-mcp";
import type { CardRecord } from "../../shared/types.ts";
import { answerCard, recoverElicitationCards } from "../src/actions.ts";
import { validateCard } from "../src/cards.ts";
import { buildElicitationCard, parseElicitationRequest, resolveElicitationAction } from "../src/mcp-elicitation.ts";
import { pluginToolsForAssistant } from "../src/plugin-host.ts";
import { call, makeHob, seedPluginSource, text } from "./helpers.ts";

const ELICITATION_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-elicitation-fixture.mjs", import.meta.url));

async function setupElicitationPlugin(hob: ReturnType<typeof makeHob>) {
  seedPluginSource(hob.home);
  const host = hob.runtime.plugins;
  host.store.install("github");
  host.store.saveConfig("github", { GITHUB_PERSONAL_ACCESS_TOKEN: "fixture-token" });
  writeFileSync(
    join(hob.home, "plugins/github/mcp.json"),
    JSON.stringify({ mcpServers: { ops: { command: process.execPath, args: [ELICITATION_FIXTURE] } } }),
  );
  await host.start();
  return host;
}

describe("mcp elicitation parser and card builder", () => {
  it("parses form and url elicitation requests and generates valid plugin cards", () => {
    const formParsed = parseElicitationRequest({
      message: "请填写变更信息",
      requestedSchema: {
        type: "object",
        properties: {
          title: { type: "string", title: "标题", minLength: 2, maxLength: 20 },
          env: { type: "string", title: "环境", enum: ["dev", "prod"], enumNames: ["开发", "生产"], default: "dev" },
          count: { type: "integer", title: "实例数", minimum: 1, maximum: 10 },
          confirm: { type: "boolean", title: "二次确认", default: true },
          day: { type: "string", title: "日期", format: "date", default: "2026-11-27" },
          tags: { type: "array", title: "标签", items: { type: "string", enum: ["a", "b"] } },
          token: { type: "string", title: "口令", format: "password" },
        },
        required: ["title", "count"],
      },
    });
    const formCard = buildElicitationCard(formParsed, "OpsKat");
    expect(validateCard(formCard, { mode: "plugin" }).ok).toBe(true);
    // 拒绝/取消按钮在 form 外面，不阻塞必填校验
    expect(formCard.body.elements.some((el) => el.tag === "form")).toBe(true);
    expect(formCard.body.elements.filter((el) => el.tag === "button")).toHaveLength(2);

    const urlParsed = parseElicitationRequest({
      mode: "url",
      message: "请完成 SSO 认证",
      url: "https://sso.example.com/login",
    });
    const urlCard = buildElicitationCard(urlParsed, "OpsKat");
    expect(validateCard(urlCard, { mode: "plugin" }).ok).toBe(true);

    // 校验非法输入
    const invalid = resolveElicitationAction(formParsed, {
      action: { tag: "button", elicitation_action: "accept" },
      form_value: { title: "a", count: 1.5 },
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.errors.title).toContain("2");
      expect(invalid.errors.count).toBe("请输入整数");
    }

    // 校验合法输入与密码脱敏
    const valid = resolveElicitationAction(formParsed, {
      action: { tag: "button", elicitation_action: "accept" },
      form_value: { title: "重启服务", env: "prod", count: "3", confirm: true, tags: ["a"], token: "s3cr3t" },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.mcpResult).toEqual({
        action: "accept",
        content: { title: "重启服务", env: "prod", count: 3, confirm: true, tags: ["a"], token: "s3cr3t" },
      });
      expect(valid.cardResult.fields?.token).toBe("••••••");
      expect(valid.cardResult.fields?.env).toBe("生产");
    }
  });

  it("rejects malformed elicitation params, invalid dates, and unsupported required fields with McpError", () => {
    expect(() => parseElicitationRequest(null)).toThrow(McpError);
    expect(() => parseElicitationRequest({ message: "   " })).toThrow(McpError);
    expect(() => parseElicitationRequest({ mode: "url", message: "open", url: "javascript:alert(1)" })).toThrow(McpError);
    expect(() => parseElicitationRequest({ mode: "unknown", message: "hi" })).toThrow(McpError);
    expect(() => parseElicitationRequest({
      message: "bad schema",
      requestedSchema: { type: "object", properties: { nested: { type: "object" } }, required: ["nested"] },
    })).toThrow(McpError);
    expect(() => parseElicitationRequest({
      message: "bad array",
      requestedSchema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, required: ["items"] },
    })).toThrow(McpError);

    // 空白枚举值会被过滤、date-time 默认值会被归一化、非法日期会被校验拒绝
    const dateParsed = parseElicitationRequest({
      message: "执行命令含 secret-abc",
      requestedSchema: {
        type: "object",
        properties: {
          day: { type: "string", format: "date" },
          at: { type: "string", format: "date-time", default: "2026-11-27T19:00:00Z" },
          choice: { type: "string", enum: ["   ", "ok"] },
        },
        required: ["day", "at"],
      },
    });
    const dateCard = buildElicitationCard(dateParsed, "OpsKat", (str) => str.replace("secret-abc", "[已隐藏]"));
    expect(validateCard(dateCard, { mode: "plugin" }).ok).toBe(true);
    expect(JSON.stringify(dateCard)).not.toContain("secret-abc");
    expect(JSON.stringify(dateCard)).toContain("2026-11-27T19:00:00");
    expect(JSON.stringify(dateCard)).not.toContain("2026-11-27T19:00:00Z");

    const badDate = resolveElicitationAction(dateParsed, {
      action: { tag: "button", elicitation_action: "accept" },
      form_value: { day: "2026-02-30", at: "not-a-time" },
    });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) {
      expect(badDate.errors.day).toContain("YYYY-MM-DD");
      expect(badDate.errors.at).toBe("请输入有效日期时间");
    }
  });
});

describe("mcp elicitation runtime flow", () => {
  it("advertises elicitation capability and resolves pure approval cards in main chat", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const host = await setupElicitationPlugin(hob);
      const capTool = pluginToolsForAssistant(host, "hob").find((tool) => tool.name === "github_capabilities")!;
      const capResult = await capTool.execute("cap-1", {}) as { content: { text?: string }[] };
      expect(JSON.parse(capResult.content[0]?.text ?? "{}")).toMatchObject({ elicitation: { form: {}, url: {} } });

      // 无交互上下文的直接工具调用应礼貌 decline
      const directConfirm = pluginToolsForAssistant(host, "hob").find((tool) => tool.name === "github_confirm_exec")!;
      const declined = await directConfirm.execute("direct-1", { command: "ls" }) as { content: { text?: string }[] };
      expect(JSON.parse(declined.content[0]?.text ?? "{}")).toEqual({ command: "ls", elicit: { action: "decline" } });

      // 主对话触发 elicitation 卡片 -> 用户点允许 -> 同一次 tool call 直接拿到结果
      let confirmResultText = "";
      hob.faux.setResponses([
        call("github_confirm_exec", { command: "systemctl restart nginx" }),
        (context) => {
          const last = context.messages.findLast((m) => m.role === "toolResult");
          confirmResultText = last && "content" in last ? (last.content as { text?: string }[]).map((b) => b.text ?? "").join("") : "";
          return text("已重启完成");
        },
      ]);
      const sendPromise = hob.runtime.router.send("hob", { text: "帮我重启 nginx" });
      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.status === "open" && c.plugin?.elicitation)).toBe(true), { timeout: 5000 });
      const card = hob.runtime.store.cards().find((c) => c.status === "open" && c.plugin?.elicitation)!;
      expect(card.owner).toEqual({ type: "plugin", pluginId: "github", assistantId: "hob" });

      const answer = await answerCard(hob.runtime, card.id, {
        action: { tag: "button", elicitation_action: "accept" },
        button_text: "允许",
      });
      expect(answer.status).toBe(200);
      expect(hob.runtime.store.card(card.id)).toMatchObject({ status: "done", result: { buttonText: "允许" } });

      await sendPromise;
      await hob.runtime.router.waitIdle("hob");
      expect(JSON.parse(confirmResultText)).toEqual({ command: "systemctl restart nginx", elicit: { action: "accept", content: {} } });
    } finally {
      await hob.runtime.plugins.close();
      hob.close();
    }
  });

  it("validates form elicitation in-place, masks secrets on disk, and supports url and chained elicitations", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await setupElicitationPlugin(hob);

      // 1. 表单校验报错 -> 修正后提交 -> 密码不落盘
      let formToolText = "";
      hob.faux.setResponses([
        call("github_form_exec", {}),
        (context) => {
          const last = context.messages.findLast((m) => m.role === "toolResult");
          formToolText = last && "content" in last ? (last.content as { text?: string }[]).map((b) => b.text ?? "").join("") : "";
          return text("发布完成");
        },
      ]);
      const formTurn = hob.runtime.router.send("hob", { text: "执行发布" });
      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.status === "open" && c.plugin?.elicitation)).toBe(true), { timeout: 5000 });
      const formCard = hob.runtime.store.cards().find((c) => c.status === "open" && c.plugin?.elicitation)!;

      const badSubmit = await answerCard(hob.runtime, formCard.id, {
        action: { tag: "button", elicitation_action: "accept" },
        button_text: "提交",
        form_value: { reason: "x", env: "prod", retries: "99" },
      });
      expect(badSubmit.status).toBe(200);
      expect(hob.runtime.store.card(formCard.id)).toMatchObject({
        status: "open",
        feedback: { errors: { reason: "至少 3 个字", retries: "不能大于 5" } },
      });

      const goodSubmit = await answerCard(hob.runtime, formCard.id, {
        action: { tag: "button", elicitation_action: "accept" },
        button_text: "提交",
        form_value: { reason: "紧急修复线上问题", env: "prod", retries: "3", dryRun: true, tags: ["canary", "notify"], secret: "super-secret-pass" },
      });
      expect(goodSubmit.status).toBe(200);
      await formTurn;
      await hob.runtime.router.waitIdle("hob");

      const persisted = readFileSync(join(hob.home, "assistants/hob/cards.json"), "utf8");
      expect(persisted).not.toContain("super-secret-pass");
      expect(JSON.parse(formToolText)).toEqual({
        action: "accept",
        content: { reason: "紧急修复线上问题", env: "prod", retries: 3, dryRun: true, tags: ["canary", "notify"], secret: "super-secret-pass" },
      });

      // 2. URL 模式
      let urlToolText = "";
      hob.faux.setResponses([
        call("github_url_auth", {}),
        (context) => {
          const last = context.messages.findLast((m) => m.role === "toolResult");
          urlToolText = last && "content" in last ? (last.content as { text?: string }[]).map((b) => b.text ?? "").join("") : "";
          return text("认证通过");
        },
      ]);
      const urlTurn = hob.runtime.router.send("hob", { text: "做外部认证" });
      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.status === "open" && c.plugin?.elicitation)).toBe(true), { timeout: 5000 });
      const urlCard = hob.runtime.store.cards().find((c) => c.status === "open" && c.plugin?.elicitation)!;
      expect(urlCard.card.body.elements.some((el) => el.tag === "button" && el.behaviors?.some((b) => b.type === "open_url"))).toBe(true);
      await answerCard(hob.runtime, urlCard.id, { action: { tag: "button", elicitation_action: "accept" }, button_text: "已完成" });
      await urlTurn;
      await hob.runtime.router.waitIdle("hob");
      expect(JSON.parse(urlToolText)).toEqual({ action: "accept" });

      // 3. 连续追问（单次工具调用两次 elicitation）
      let chainText = "";
      hob.faux.setResponses([
        call("github_chained_exec", {}),
        (context) => {
          const last = context.messages.findLast((m) => m.role === "toolResult");
          chainText = last && "content" in last ? (last.content as { text?: string }[]).map((b) => b.text ?? "").join("") : "";
          return text("两步都确认完了");
        },
      ]);
      const chainTurn = hob.runtime.router.send("hob", { text: "重启 prod-01" });
      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.status === "open" && c.plugin?.elicitation)).toBe(true), { timeout: 5000 });
      const firstCard = hob.runtime.store.cards().find((c) => c.status === "open" && c.plugin?.elicitation)!;
      await answerCard(hob.runtime, firstCard.id, { action: { tag: "button", elicitation_action: "accept" }, button_text: "允许" });

      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.id !== firstCard.id && c.status === "open" && c.plugin?.elicitation)).toBe(true));
      const secondCard = hob.runtime.store.cards().find((c) => c.id !== firstCard.id && c.status === "open" && c.plugin?.elicitation)!;
      await answerCard(hob.runtime, secondCard.id, { action: { tag: "button", elicitation_action: "decline" }, button_text: "拒绝" });
      await chainTurn;
      await hob.runtime.router.waitIdle("hob");

      expect(JSON.parse(chainText)).toEqual({ first: { action: "accept", content: {} }, second: { action: "decline" } });
    } finally {
      await hob.runtime.plugins.close();
      hob.close();
    }
  });

  it("expires cards on server cancel, plugin stop, and stale card actions", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const host = await setupElicitationPlugin(hob);

      // 1. 服务端主动发 notifications/cancelled
      hob.faux.setResponses([call("github_cancel_by_server", {}), text("服务端已取消")]);
      await hob.runtime.router.send("hob", { text: "测服务端取消" });
      await hob.runtime.router.waitIdle("hob");
      const cancelledCard = hob.runtime.store.cards().find((c) => c.plugin?.elicitation)!;
      expect(cancelledCard).toMatchObject({ status: "done", feedback: { unavailable: "这项确认已取消" } });

      // 2. 插件停止时取消挂起确认且不死锁
      hob.faux.setResponses([call("github_confirm_exec", { command: "rm -rf /tmp/demo" }), text("已中断")]);
      const turn = hob.runtime.router.send("hob", { text: "停插件测试" });
      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.status === "open" && c.plugin?.elicitation)).toBe(true), { timeout: 5000 });
      const stopCard = hob.runtime.store.cards().find((c) => c.status === "open" && c.plugin?.elicitation)!;
      await host.stopPlugin("github");
      await turn;
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.card(stopCard.id)).toMatchObject({ status: "done", feedback: { unavailable: "这项确认已失效，请让助手重新发起。" } });

      // 3. 重启后遗留的失效卡片点按钮应返回 409 并作废
      const stale: CardRecord = {
        id: "c-stale-elicit",
        owner: { type: "plugin", pluginId: "github", assistantId: "hob" },
        plugin: { service: "ops", pluginName: "GitHub", elicitation: true },
        card: { header: { title: "旧确认" }, body: { elements: [{ tag: "div", text: "旧内容" }] } },
        status: "open",
        createdAt: new Date().toISOString(),
      };
      hob.runtime.store.saveCard(stale);
      const res = await answerCard(hob.runtime, stale.id, { action: { tag: "button", elicitation_action: "accept" } });
      expect(res.status).toBe(409);
      expect(hob.runtime.store.card(stale.id)).toMatchObject({ status: "done", feedback: { unavailable: "这项确认已失效，请让助手重新发起。" } });

      // 4. 启动恢复只作废 open 的 elicitation 卡片，不影响普通插件回调卡
      const leftoverElicit: CardRecord = { ...stale, id: "c-recover-elicit" };
      const normalPluginCard: CardRecord = {
        id: "c-recover-normal",
        owner: { type: "plugin", pluginId: "github", assistantId: "hob" },
        plugin: { service: "ops", callbackTool: "save", pluginName: "GitHub" },
        card: { header: { title: "普通插件卡" }, body: { elements: [{ tag: "div", text: "保持打开" }] } },
        status: "open",
        createdAt: new Date().toISOString(),
      };
      hob.runtime.store.saveCard(leftoverElicit);
      hob.runtime.store.saveCard(normalPluginCard);
      recoverElicitationCards(hob.runtime);
      expect(hob.runtime.store.card(leftoverElicit.id)).toMatchObject({
        status: "done",
        feedback: { unavailable: "服务已重启，这项确认已失效，请让助手重新发起。" },
      });
      expect(hob.runtime.store.card(normalPluginCard.id)?.status).toBe("open");
    } finally {
      await hob.runtime.plugins.close();
      hob.close();
    }
  });

  it("supports elicitation cards inside background jobs without tripping stall detection", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      await setupElicitationPlugin(hob);
      hob.faux.setResponses([
        call("github_confirm_exec", { command: "df -h" }),
        call("report", { outcome: "done", result: "磁盘检查完成" }),
        text("磁盘检查好了。"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "检查磁盘", instruction: "调用确认工具检查磁盘" });
      await vi.waitFor(() => expect(hob.runtime.store.cards().some((c) => c.status === "open" && c.plugin?.elicitation)).toBe(true), { timeout: 5000 });
      const card = hob.runtime.store.cards().find((c) => c.status === "open" && c.plugin?.elicitation)!;

      // 等待用户点卡期间即使时间过了很久，也不应被 checkStalls 判成卡死
      hob.runtime.jobs.checkStalls(Date.now() + 60 * 60_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("running");

      const answer = await answerCard(hob.runtime, card.id, {
        action: { tag: "button", elicitation_action: "accept" },
        button_text: "允许",
      });
      expect(answer.status).toBe(200);
      await hob.runtime.jobs.waitIdle(30_000);
      expect(hob.runtime.store.job(job.id)?.status).toBe("done");
      expect(hob.runtime.store.job(job.id)?.summary).toContain("磁盘检查完成");
    } finally {
      await hob.runtime.plugins.close();
      hob.close();
    }
  });
});
