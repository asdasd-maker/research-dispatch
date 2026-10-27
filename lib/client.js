/**
 * research-dispatch — 设置页（浏览器半）。
 *
 * 形态与 dsh-claude-style / dsh-client-ui-settings-unarchive-sessions 一致：
 * 注册 settings.section，点设置左栏进去是整页。
 *
 * 数据通路（按可用性依次尝试，全都不抛）：
 *   ① ctx.remote.settings.describe() —— 核心 RPC 网关，返回全部命名空间的
 *      { ns, schema, value, base, user, revision }。第三方 client 半拿不到
 *      settingsScope（写进 inject 会让 entry 永久 pending、整个 boot 失败），
 *      但网关本身是通的。
 *   ② ctx.remote.settings.update(ns, patch, revision) —— 写回，patch 是"只含改动字段"的对象。
 *
 * 字段不写死：从 describe 拿到的 schema.properties 生成，宿主 Config 里加一个字段，
 * 这里就自动多一行。
 */
window.__ModuleLoader__.load({
  id: "research-dispatch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const NS = "research-dispatch";

    // ── 样式（规范见仓库内文档）──────────────────────────────────────────────
    // 三条硬约束：只取宿主 alias 令牌（换肤自动跟随，不硬编码色值）；
    // 行不做盒子（分区靠 0.5px 发丝线 + 4px 节奏的间距，不叠阴影）；
    // 强调色只给主按钮 / 焦点环 / 徽标（占比 <10%）。
    const CSS = [
      ".rdp{max-width:720px;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}",
      ".rdp-head{display:flex;flex-direction:column;gap:6px}",
      ".rdp-title{margin:0;font-size:18px;font-weight:600;letter-spacing:.005em}",
      ".rdp-lead{margin:0;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.65;max-width:72ch}",
      ".rdp-state{margin-top:16px;padding:12px 14px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));font-size:12.5px;color:var(--dsw-alias-label-secondary);line-height:1.65}",
      ".rdp-group{display:flex;flex-direction:column;margin-top:24px;padding-top:20px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".rdp-group-t{margin:0;font-size:15px;font-weight:600;letter-spacing:.005em}",
      ".rdp-group-d{margin:5px 0 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary);line-height:1.65;max-width:66ch}",
      ".rdp-items{display:flex;flex-direction:column;margin-top:8px}",
      ".rdp-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:20px;align-items:center;padding:13px 0;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".rdp-items .rdp-item:first-child{border-top:0}",
      ".rdp-item-full{grid-template-columns:minmax(0,1fr)}",
      ".rdp-item-main{display:flex;flex-direction:column;gap:3px;min-width:0}",
      ".rdp-label{font-size:13px;font-weight:500;display:flex;align-items:center;gap:8px;min-width:0}",
      ".rdp-sub{display:flex;align-items:baseline;gap:5px;font-size:12px;color:var(--dsw-alias-label-tertiary);min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
      ".rdp-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.6}",
      ".rdp code{font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary);background:transparent;padding:0}",
      ".rdp-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-grid2{display:grid;grid-template-columns:132px 208px;gap:8px}",
      ".rdp-ctl-ghost{width:28px;height:28px;flex:0 0 auto}",
      ".rdp-in{font:inherit;font-size:12.5px;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary);box-sizing:border-box;width:100%;transition:border-color .12s ease,box-shadow .12s ease}",
      ".rdp-in:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
      ".rdp-in:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".rdp-in:disabled{opacity:.55;cursor:default}",
      // 模型选择器：自造弹层，形态与 /model 弹窗一致（供应商胶囊标题 + 模型名 + 勾选标记）。
      // 只取宿主 alias 令牌，换肤自动跟随；弹层锚右，避免从卡片右缘溢出。
      ".rdp-pick{position:relative;min-width:0}",
      ".rdp-pick-btn{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%;height:30px;padding:0 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:border-color .12s ease,box-shadow .12s ease}",
      ".rdp-pick-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}",
      ".rdp-pick-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".rdp-pick-btn:disabled{opacity:.55;cursor:default}",
      ".rdp-pick-btn.is-open{border-color:var(--dsw-alias-brand-primary)}",
      ".rdp-pick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-pick-caret{flex:0 0 auto;font-size:9px;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-menu{position:absolute;z-index:40;top:calc(100% + 4px);right:0;width:max(268px,100%);max-height:326px;overflow:auto;padding:6px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base,#fff);box-shadow:0 10px 28px rgba(0,0,0,.16)}",
      ".rdp-menu-search{display:block;width:100%;height:28px;margin:2px 0 6px;padding:0 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;box-sizing:border-box}",
      ".rdp-menu-search:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".rdp-menu-empty{padding:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-menu-sec+.rdp-menu-sec{margin-top:4px}",
      // 分组标题做成深色胶囊（和 /model 弹窗一致）；用前景/背景令牌互换，深浅色主题都成立
      ".rdp-menu-cap{display:inline-flex;align-items:center;height:20px;margin:6px 8px 4px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base,#fff);font-size:11px;font-weight:600;letter-spacing:.01em}",
      ".rdp-menu-item{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;height:30px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}",
      ".rdp-menu-item:hover,.rdp-menu-item.is-hi{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}",
      ".rdp-menu-item.is-sel{color:var(--dsw-alias-brand-primary);font-weight:500}",
      ".rdp-menu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-menu-tick{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-brand-primary)}",
      ".rdp-btn{font:inherit;font-size:12.5px;height:30px;padding:0 12px;border-radius:8px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex:0 0 auto;transition:background-color .12s ease,color .12s ease,border-color .12s ease}",
      ".rdp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));color:var(--dsw-alias-label-primary)}",
      ".rdp-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}",
      ".rdp-btn:disabled{opacity:.45;cursor:default}",
      ".rdp-btn-danger{height:28px;padding:0 10px;border-color:transparent;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-danger-fg,#d0554a);background:color-mix(in srgb,var(--dsw-alias-state-danger-fg,#d0554a) 9%,transparent)}",
      ".rdp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-button-primary-text,#fff)}",
      ".rdp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}",
      ".rdp-add-wrap{margin-top:10px}",
      ".rdp-add{width:100%;height:34px;border-style:dashed;color:var(--dsw-alias-label-tertiary)}",
      ".rdp-add:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:transparent}",
      ".rdp-note{margin:10px 0 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.65}",
      ".rdp-empty{padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}",
      ".rdp-badge{font-size:10.5px;font-weight:500;padding:1px 6px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}",
      ".rdp-foot{display:flex;align-items:center;gap:12px;margin-top:24px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2)}",
      ".rdp-foot-msg{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-right:auto}",
      ".rdp-foot-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-ok{color:var(--dsw-alias-state-success-fg,#4f9d6b)}",
      ".rdp-bad{color:var(--dsw-alias-state-danger-fg,#d0554a)}",
      // 窄了就折成一栏。用**容器查询**而不是媒体查询：这张卡挂在设置面板里，
      // 面板可能比视口窄得多（实测 480px 宽时两栏会把左边的标签挤成一字一行），
      // 而视口往往还是宽的 —— 媒体查询在这种情况下根本不触发。
      ".rdp{container-type:inline-size}",
      "@container (max-width:560px){.rdp-item{grid-template-columns:minmax(0,1fr)}.rdp-item-full{grid-template-columns:minmax(0,1fr)}.rdp-ctl{justify-content:flex-start;width:100%}.rdp-grid2{grid-template-columns:1fr 1fr;width:100%}.rdp-ctl-ghost{display:none}}",
      "@media (max-width:560px){.rdp-item{grid-template-columns:minmax(0,1fr)}.rdp-ctl{justify-content:flex-start;width:100%}.rdp-grid2{grid-template-columns:1fr 1fr;width:100%}}",
      "@media (prefers-reduced-motion:reduce){.rdp *{transition:none!important}}",
    ].join("");
    // 这张 <style> 是本模块插进 document.head 的：谁插的谁拆，apply 里注册卸载。
    let STYLE_TAG = null;
    try {
      if (typeof document !== "undefined" && document && typeof document.querySelector === "function" &&
          !document.querySelector('style[data-plugin-css="research-dispatch"]')) {
        const tag = document.createElement("style");
        tag.dataset.plugin = "research-dispatch";
        tag.dataset.pluginCss = "research-dispatch";
        tag.textContent = CSS;
        document.head.appendChild(tag);
        STYLE_TAG = tag;
      }
    } catch { /* 样式失败不影响功能 */ }

    const diag = (typeof window !== "undefined")
      ? (window.__researchDispatch = window.__researchDispatch || { steps: [] })
      : { steps: [] };
    // 环形缓冲：页面每重载一次就 push 一条，只增不减会把这颗全局对象撑成内存泄漏。
    const STEP_CAP = 50;
    function pushStep(step) {
      diag.steps.push(step);
      if (diag.steps.length > STEP_CAP) diag.steps.splice(0, diag.steps.length - STEP_CAP);
    }
    pushStep("evaluated@" + Date.now());

    // ── 网关：可选依赖，走 ctx.inject 子光纤，绝不阻塞插件本体 ────────────
    // ctx.get("remote") 实测拿不到（页面上那句原因就是它），但 shipped 的设置类插件
    // 都把 remote 写进 inject 且工作正常 —— 说明服务存在，只是"直接 get"这条路不通。
    // ctx.inject 是 cordis 的标准做法：等服务就绪再跑回调，服务一直不来也不会 pending。
    let GATEWAY = null;
    const watchers = new Set();
    function setGateway(gw) {
      GATEWAY = gw;
      for (const fn of watchers) { try { fn(); } catch { /* 订阅者自己坏了不该影响别人 */ } }
    }

    // ── 网关访问：全部包在 try 里，任何一步不通都只降级，不抛 ────────────
    // remote 到底把设置方法挂在哪个属性上：RPC 元数据写的是
    //   service: settingsController / namespace: settings / method: describe
    // 我没法从元数据断定客户端暴露成 remote.settings 还是 remote.settingsController，
    // 所以这里按候选依次试，并把真实键名记进 diag —— 猜错一次就够了，不该再猜第二次。
    function resolveSettings(remote, ctx) {
      const tries = [];
      // ① 反射 API 取子服务：与 ctx.get("remote") 同一条路，不触发属性门禁。
      try {
        const s1 = ctx && ctx.get ? ctx.get("remote.settings") : null;
        if (s1 && typeof s1.describe === "function") { diag.resolveVia = 'ctx.get("remote.settings")'; return s1; }
        tries.push("ctx.get(\"remote.settings\") → " + (s1 ? "不是设置 API" : "空"));
      } catch (e) { tries.push("ctx.get(\"remote.settings\"): " + e.message); }

      // ② remote 上有个 namespaces 键，可能正是"命名空间 → API"的映射。
      try {
        const ns = remote && remote.namespaces;
        const s2 = ns ? (ns.settings || (typeof ns.get === "function" ? ns.get("settings") : null)) : null;
        if (s2 && typeof s2.describe === "function") { diag.resolveVia = "remote.namespaces.settings"; return s2; }
        tries.push("remote.namespaces → " + (ns ? "存在但没有 settings" : "无"));
      } catch (e) { tries.push("remote.namespaces: " + e.message); }

      // ③ 其余候选（属性访问未声明会抛，全部包 try）
      const cands = [
        ["remote.settings", () => remote.settings],
        ["remote.settingsController", () => remote.settingsController],
        ["remote 本身", () => remote],
      ];
      for (const [name, get] of cands) {
        try {
          const c = get();
          if (c && typeof c.describe === "function") { diag.resolveVia = name; return c; }
          tries.push(name + " → 无 describe");
        } catch (e) { tries.push(name + ": " + e.message); }
      }
      if (!diag.resolveTries) diag.resolveTries = tries;
      return null;
    }

    function gateway(ctx) {
      if (GATEWAY) return GATEWAY;
      try {
        // remote 用 ctx.get 懒取而不是写进 inject：声明一个拿不到的服务会让 entry
        // 永久 pending、整个 web boot 失败（已实测）。懒取的代价只是这一次拿不到。
        // 已声明 remote.settings：直接取即可（未声明时这一步会抛，所以仍在 try 里）
        const direct = ctx && ctx.remote && ctx.remote.settings;
        if (direct && typeof direct.describe === "function") {
          if (!diag.resolveVia) diag.resolveVia = "ctx.remote.settings（已声明）";
          return direct;
        }
        const svc = (ctx && ctx.remote) || (ctx && ctx.get ? ctx.get("remote") : null);
        const resolved = resolveSettings(svc, ctx);
        if (svc && !resolved && !diag.remoteKeys) {
          try { diag.remoteKeys = Object.keys(svc).slice(0, 40); } catch { diag.remoteKeys = "无法枚举"; }
        }
        if (svc && !diag.remoteType) {
          try { diag.remoteType = typeof svc + ":" + (svc.constructor && svc.constructor.name); } catch { /* 忽略 */ }
        }
        return resolved;
      } catch (e) { diag.gatewayError = String((e && e.message) || e); return null; }
    }
    // 官方实现里的返回形状是 {ok, value} / {ok:false, error}，不是裸数组：
    //   const response = await this.ctx.remote.settings.describe();
    //   outcome = response.ok ? { view: response.value } : { failure: response.error.message };
    // 我前几轮按"裸数组"解析，于是 describe 成功了也被判成"拿不到命名空间"。
    async function unwrap(res, what) {
      if (res && typeof res === "object" && Object.prototype.hasOwnProperty.call(res, "ok")) {
        if (!res.ok) throw new Error(what + " 失败：" + ((res.error && res.error.message) || "未知错误"));
        return res.value;
      }
      return res;
    }

    async function readDescriptor(ctx) {
      const gw = gateway(ctx);
      if (!gw || typeof gw.describe !== "function") return null;
      const res = await gw.describe();
      if (res && typeof res === "object" && !Array.isArray(res) && !diag.describeShape) {
        try { diag.describeShape = Object.keys(res).slice(0, 12); } catch { /* 忽略 */ }
      }
      const value = await unwrap(res, "settings.describe");
      const list = Array.isArray(value) ? value
        : (value && Array.isArray(value.namespaces)) ? value.namespaces
        : (value && value.view && Array.isArray(value.view.namespaces)) ? value.view.namespaces
        : [];
      if (!diag.describeCount) diag.describeCount = list.length;
      const found = list.find((d) => d && d.ns === NS) || null;
      // ⑦ 区分两种"拿不到"：describe 成功但没有本 ns ≠ describe 根本没通。
      // 以前两种情况都返回 null，页面一律说"连不上网关"，把装配问题（没注册命名空间）
      // 误导成网络问题，排查方向直接被带偏。
      if (!found) {
        const err = new Error("设置服务已连通，但命名空间 " + NS + " 未注册（describe 里没有这一项）");
        err.code = "NS_MISSING";
        throw err;
      }
      return found;
    }

    async function writePatch(ctx, patch, revision) {
      const gw = gateway(ctx);
      if (!gw) throw new Error("当前连不上设置服务，无法保存");
      if (typeof gw.update === "function") return unwrap(await gw.update(NS, patch, revision), "settings.update");
      if (typeof gw.mutate === "function") {
        const ops = Object.keys(patch).map((k) => ({ op: "set", path: [k], value: patch[k] }));
        return unwrap(await gw.mutate(NS, ops, revision), "settings.mutate");
      }
      throw new Error("当前连不上设置服务，无法保存");
    }

    // 字段列表：优先取 schema，拿不到就退到 value 的键。
    // **真实形状**：DSH 的 describe() 给的是 schemastery 的 toJSON() 输出 { uid, refs } ——
    // 根对象在 refs[uid]，键在它的 dict 里（键名 → 子 schema 的 uid），子 schema 的元信息
    // 在 refs[子uid].meta。**没有 properties 这个键**。以前只认 schema.properties：
    // describe 通了、值也在，schema 这一格永远解析成空，于是整排可编辑控件消失。
    let USED_REFS = false;
    function propsFromSchema(schema) {
      if (!schema || typeof schema !== "object") return null;
      const refs = Array.isArray(schema.refs) ? null : schema.refs;
      if (refs && typeof refs === "object" && schema.uid !== undefined) {
        USED_REFS = true;
        const root = refs[String(schema.uid)] || refs[schema.uid];
        const dict = root && typeof root.dict === "object" ? root.dict : null;
        if (!dict) return null;
        const out = {};
        for (const key of Object.keys(dict)) {
          const sub = (refs[String(dict[key])] || refs[dict[key]]) || {};
          out[key] = sub.meta || {};
        }
        return out;
      }
      // 兼容 / 防御：别的序列化实现可能直接给 properties。
      if (schema.properties && typeof schema.properties === "object") return schema.properties;
      return null;
    }

    const LABELS = {
      reviewVotes: "评审票",
      repoRoot: "工作流仓库根",
      seatsFile: "座位表路径",
    };

    function fieldsOf(desc) {
      const props = propsFromSchema(desc && desc.schema);
      const source = props || (desc && desc.value) || {};
      const keys = Object.keys(source);
      // 最后一层保险：schema 与 value 都取不到键时，至少把一项已知字段列出来
      // （它是 Config 里必然存在的，缺了只可能是解析问题，不该让整页只剩快照）。
      if (keys.length === 0) { keys.push("reviewVotes"); }
      if (!diag.fieldKeys) diag.fieldKeys = keys.slice(0, 10);
      if (!diag.fieldSource) diag.fieldSource = props ? (USED_REFS ? "schema.refs" : "schema.properties") : "value keys";
      return keys.map((k) => {
        const meta = (props && props[k]) || {};
        return {
          key: k,
          title: meta.title || LABELS[k] || k,
          description: meta.description || "",
          default: meta.default,
        };
      });
    }

    // 没有网关时也要有内容：这些是字段的静态说明，与 Config 里的三个字段一一对应。
    // 它们的作用不是"假装有数据"，而是让页面在第一屏就是完整骨架 + 恢复路径，
    // 而不是一片空白（那是上一次的形态，用户明确否掉了）。
    // 没有网关时的静态骨架：只剩一个"都有专用控件"的说明性字段，
    // 保证首屏不是空白（真正可编辑的东西要等网关通了才出现）。
    const FALLBACK_FIELDS = [
      { key: "reviewVotes", title: "评审票", description: "几票 = 几座（exec:model,exec:model）", default: "" },
    ];

    // 座位不在面板上（按设计整块去掉）：逐座的模型与执行方式只写在
    // dispatch/seats.json 的 seats[<id>].model_override / executor_override。面板不再持有
    // 第二份，也就不存在"界面与文件各说一套"。
    // 逐座的**固定**模型/执行方式不在面板上（整块去掉）：它们只写在座位表里。
    // 面板负责的是"这一轮排哪几票"，座位表负责"每一座默认是谁"。
    // 面向所有用户的进阶提示：说清"能固定"，但不暴露文件名与字段名。
    const SEATS_HINT = "进阶：想让某一位评审员固定使用某个模型，需要在配置文件里单独指定，本页不提供这一项。日常不用管。";
    const EXECUTORS = [
      { v: "", label: "按座位表默认" },
      { v: "cli", label: "外部 CLI" },
      { v: "api", label: "HTTP API" },
      { v: "subagent", label: "subagent（代递）" },
    ];

    // 执行者目录（宿主探测好塞进 Config 的扁平串）→ [{exec, models[]}]
    // 运行时补模型清单：DSH 自己的模型目录服务（dsh-client-ui-model-selection 提供）。
    // 用 ctx.get 懒取 —— 声明进 inject 一旦拿不到就是整个 boot 失败，代价太大。
    // 拿不到就保持宿主探测的静态清单，界面上如实显示，不编造。
    let EXTRA_MODELS = null;
    function readModelDirectories(ctx) {
      if (EXTRA_MODELS !== null) return EXTRA_MODELS;
      try {
        const svc = ctx && ctx.get ? ctx.get("modelDirectories") : null;
        if (!svc) { EXTRA_MODELS = {}; return EXTRA_MODELS; }
        const snap = typeof svc.getSnapshot === "function" ? svc.getSnapshot() : svc;
        const out = {};
        const push = (exec, model) => {
          if (!exec || !model) return;
          out[exec] = out[exec] || [];
          if (!out[exec].includes(model)) out[exec].push(model);
        };
        const walk = (node, depth) => {
          if (!node || depth > 4) return;
          if (Array.isArray(node)) { node.forEach((n) => walk(n, depth + 1)); return; }
          if (typeof node !== "object") return;
          const prov = node.provider || node.providerId || node.id;
          if (prov && Array.isArray(node.models)) {
            node.models.forEach((m) => push(String(prov), String(m.id || m.model || m.name || "")));
          }
          Object.values(node).forEach((v) => { if (v && typeof v === "object") walk(v, depth + 1); });
        };
        walk(snap, 0);
        EXTRA_MODELS = out;
        try { diag.modelDirsKeys = Object.keys(out).slice(0, 10); } catch { /* 忽略 */ }
        return out;
      } catch (e) {
        try { diag.modelDirsError = String((e && e.message) || e); } catch { /* 忽略 */ }
        EXTRA_MODELS = {};
        return EXTRA_MODELS;
      }
    }

    function catalogOf(value, ctx) {
      const raw = String((value && value.executorCatalog) || "");
      return raw.split(";").map((row) => {
        const i = row.indexOf(":");
        if (i < 0) return null;
        const exec = row.slice(0, i).trim();
        const models = row.slice(i + 1).split("|").map((x) => x.trim()).filter(Boolean);
        return exec ? { exec, models } : null;
      }).filter(Boolean);
    }

    // 把运行时拿到的模型并进静态目录（同名去重）。
    function mergeCatalog(base, extra) {
      if (!extra) return base;
      const byExec = new Map(base.map((c) => [c.exec, c]));
      for (const [exec, models] of Object.entries(extra)) {
        const row = byExec.get(exec);
        if (!row) { byExec.set(exec, { exec, models: models.slice() }); continue; }
        for (const m of models) if (!row.models.includes(m)) row.models.push(m);
      }
      return [...byExec.values()];
    }

    // ── 宿主模型目录：与 /model 弹窗同一份 ────────────────────────────────
    // 面板以前只有两条数据源：宿主探测串（executorCatalog）与 modelDirectories 快照。
    // 两者都只能看见"本机文件里落了盘"的供应商（实测只出 cline-pass 那 44 个），而 /model
    // 弹窗里是 Cline Pass / Qoder / Magpie / Magpie·Anthropic 四组 —— 于是 dsh 与 subagent
    // 两条选出来的模型跟正常对话根本不是同一批。真正的目录来自 RPC：
    //   ctx.remote.session.modelCatalog() → { ok, value: { groups: [{ id, name, models: [{ id, name }] }] } }
    // （实现见 @deepseek-ai/dsh-client-ui-model-selection 的目录加载）。
    // 拿不到就保持静态探测，绝不编造 —— 但要把原因记进诊断，别静默降级。
    let LIVE_GROUPS = null;
    let LIVE_CATALOG = null;

    function groupsToCatalog(groups) {
      const ids = [];
      for (const g of groups || []) {
        const prov = String((g && (g.id || g.name)) || '').trim();
        const ms = (g && Array.isArray(g.models)) ? g.models : [];
        for (const m of ms) {
          const mid = String((m && (m.id || m.name)) || '').trim();
          if (!prov || !mid) continue;
          const full = prov + '/' + mid;
          if (!ids.includes(full)) ids.push(full);
        }
      }
      return ids;
    }

    function setLiveGroups(groups) {
      LIVE_GROUPS = groups;
      const ids = groupsToCatalog(groups);
      // dsh 与 subagent 用的是同一份会话模型目录（subagent 继承会话模型），所以两行同源。
      LIVE_CATALOG = ids.length ? { dsh: ids.slice(), subagent: ids.slice() } : null;
      for (const fn of watchers) { try { fn(); } catch { /* 订阅者自己坏了不该影响别人 */ } }
    }

    // 面板最终看到的目录：静态探测 + modelDirectories 快照打底；一旦拿到宿主目录，
    // dsh / subagent 两行以宿主目录**覆盖**（不是并集 —— 并集会把两次不同批次的清单混在一起）。
    function panelCatalog(value, ctx) {
      const base = mergeCatalog(catalogOf(value), readModelDirectories(ctx));
      if (!LIVE_CATALOG) return base;
      const out = base.filter((c) => !Object.prototype.hasOwnProperty.call(LIVE_CATALOG, c.exec));
      for (const [exec, models] of Object.entries(LIVE_CATALOG)) {
        if (models.length) out.push({ exec, models: models.slice() });
      }
      return out;
    }

    // 评审票：可自由增删，每票 = 执行者 + 该执行者的模型。
    // 存储用 "exec:model,exec:model" 的扁平串（不带引号，能安全穿过 YAML 设置文档）。
    function voteRows(value) {
      const raw = String((value && value.reviewVotes) || "");
      if (!raw.trim()) return [{ executor: "codex", model: "" }, { executor: "claude", model: "" }, { executor: "dsh", model: "" }];
      return raw.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
        const i = t.indexOf(":");
        return i < 0 ? { executor: t, model: "" } : { executor: t.slice(0, i), model: t.slice(i + 1) };
      });
    }
    function voteString(rows) {
      return rows.map((r) => r.executor + ":" + (r.model || "")).join(",");
    }

    // 其余三个环节：由主会话执行，这里只存选择。整段渲染包在 try/catch 里，
    // 任何一处取不到都退化成一行提示 —— 绝不允许再出现"整页空白"。
    // 三个"只登记"的环节：label 与 hint 是这一节的标题与说明的**唯一来源**
    // （以前 hint 画在行里、说明另写一段，同一件事说了两遍）。
    const STAGE_ROWS = [
      { id: "scout", label: "文献调研", hint: "先收集这个方向的论文，整理成可比较的卡片。" },
      { id: "novelty", label: "新颖度复查", hint: "选定一条想法之后，确认是不是已经有人做过。" },
      { id: "implement", label: "实现与实验", hint: "方向定了之后，写代码、跑实验、产出结果。" },
    ];
    const STAGE_NOTE = "（只登记由谁做，不在本页运行）";

    function parseStages(raw) {
      const map = {};
      for (const t of String(raw || "").split(";")) {
        const parts = t.split(":");
        if (!parts[0]) continue;
        map[parts[0]] = { executor: parts[1] || "", model: parts.slice(2).join(":") || "" };
      }
      return map;
    }

    // ── 模型选择器：自造弹层，形态与 /model 弹窗一致 ───────────────────────
    // 面板原来把模型拍平成一列 provider/model 长串，而 /model 弹窗是"供应商胶囊标题 + 模型名
    // + 勾选"。这里做同样的形态：分组标题是深色小胶囊，行只写模型名，选中行右侧打勾。
    // 代价是焦点/键盘/点外部关闭都要自己写，所以：
    //   · 打开状态全部挂在 Page 上（一个 key + 一个高亮下标），组件本身无 hook；
    //   · 渲染任何一步失败只让这一个控件降级，不会把整页画没（这面板被试过整页空白）。
    function groupedModels(exec, cat) {
      const flat = (cat.find((c) => c.exec === exec) || { models: [] }).models;
      // 只有 dsh / subagent 有宿主目录；其它执行者（codex/claude/kimi）本来就没有分组概念。
      if (LIVE_GROUPS && (exec === "dsh" || exec === "subagent")) {
        const out = [];
        for (const g of LIVE_GROUPS) {
          const prov = String((g && (g.id || g.name)) || "").trim();
          const label = String((g && g.name) || prov).trim();
          const ms = (g && Array.isArray(g.models)) ? g.models : [];
          const items = ms.map((m) => ({
            value: prov + "/" + String((m && (m.id || m.name)) || ""),
            label: String((m && m.name) || (m && m.id) || "").trim(),
          })).filter((x) => x.value && x.label && x.label !== "undefined");
          if (prov && items.length) out.push({ label, items });
        }
        if (out.length) return out;
      }
      return [{ label: "", items: flat.map((m) => ({ value: m, label: m })) }];
    }

    // 占位符只写模型名，别把 provider/model 长串塞进"默认（…）"里 —— 下拉里已经看得见分组了。
    function defaultModelLabel(exec, cat, fallback) {
      for (const g of groupedModels(exec, cat)) {
        for (const it of g.items) return "默认（" + it.label + "）";
      }
      return fallback;
    }

    function flattenGroups(groups) {
      const items = [];
      for (const g of groups) for (const it of g.items) items.push(it);
      return items;
    }

    // 搜索规则与 /model 弹窗一致：去首尾空格、不区分大小写、**允许不连续字符**
    // （按顺序逐个找得到即命中）。名字与 provider/model 都参与匹配 —— 想按供应商查就输 qoder。
    function modelMatch(it, needle) {
      const q = String(needle || "").trim().toLowerCase();
      if (!q) return true;
      const hay = (String(it.label || "") + " " + String(it.value || "")).toLowerCase();
      let i = 0;
      for (const ch of hay) {
        if (ch === q[i]) i += 1;
        if (i >= q.length) return true;
      }
      return false;
    }

    // 过滤后只剩非空分组（没有匹配项的分组整组隐藏，与弹窗一致）。
    function filteredGroups(groups, q) {
      if (!String(q || "").trim()) return groups;
      const out = [];
      for (const g of groups) {
        const items = g.items.filter((it) => modelMatch(it, q));
        if (items.length) out.push({ label: g.label, items });
      }
      return out;
    }

    // 一个选择器要的全部交互状态：谁开着、高亮第几行、选中了写什么。
    // 状态在 Page，组件是纯函数 —— 自检里能把"点一下"真的走一遍，不用模拟整棵状态树。
    function menuProps(state, key, groups, value, onPick) {
      const { menu, setMenu } = state;
      const open = menu.key === key;
      // 查询串属于"这一个弹层"：没打开时一律为空，避免切到别的控件还带着上一个的过滤词。
      const q = open ? String(menu.q || "") : "";
      const items = flattenGroups(filteredGroups(groups, q));
      const idxOf = (v) => {
        for (let i = 0; i < items.length; i++) if (items[i].value === v) return i;
        return -1;
      };
      const hi0 = Math.max(0, idxOf(value));
      return {
        open,
        q,
        // 弹窗的原口径：完整目录超过 4 个模型才给搜索框，小目录直接聚焦当前行。
        showSearch: flattenGroups(groups).length > 4,
        hi: open ? Math.min(Math.max(0, menu.hi || 0), Math.max(0, items.length - 1)) : hi0,
        onOpen: () => setMenu({ key, hi: hi0, q: "" }),
        onClose: () => setMenu({ key: null, hi: 0, q: "" }),
        onHover: (i) => setMenu({ key, hi: i, q }),
        onQuery: (v) => {
          // 改过滤词时高亮回到"当前值若还在结果里，否则第一行" —— 连按两次 Backspace 不会
          // 留下一个指向已消失行的下标（那会让 Enter 选到看不见的项）。
          const next = flattenGroups(filteredGroups(groups, v));
          const at = next.findIndex((it) => it.value === value);
          setMenu({ key, q: v, hi: at >= 0 ? at : 0 });
        },
        onMove: (d) => {
          const n = items.length;
          if (!n) return;
          const base = open ? (menu.hi || 0) : hi0;
          setMenu({ key, q, hi: ((base + d) % n + n) % n });
        },
        onPick: (v) => { setMenu({ key: null, hi: 0, q: "" }); onPick(v); },
      };
    }

    function ModelPicker(props) {
      const { value, groups, disabled, placeholder, open, hi, q, showSearch, onOpen, onClose, onMove, onHover, onPick, onQuery } = props;
      // 按钮上写的是**完整目录**里的当前项：过滤词只影响弹层内容，不许影响已选值的显示。
      const all = flattenGroups(groups);
      const cur = all.filter((x) => x.value === value)[0];
      const label = cur ? cur.label : (value || placeholder);
      const view = filteredGroups(groups, q);
      const items = flattenGroups(view);
      const navKey = (e) => {
        const k = e && e.key;
        if (k === "ArrowDown" || k === "ArrowUp") { e.preventDefault(); onMove(k === "ArrowDown" ? 1 : -1); return; }
        if (k === "Escape") { e.preventDefault(); onClose(); return; }
        if (k === "Enter") {
          e.preventDefault();
          if (open && items[hi]) onPick(items[hi].value);
          else if (!open) onOpen();
        }
      };
      let list = null;
      if (open) {
        const rows = [];
        if (showSearch) {
          rows.push(h("input", {
            key: "__q__",
            className: "rdp-menu-search",
            type: "text",
            value: q,
            placeholder: "搜索模型",
            autoFocus: true,
            onChange: (e) => onQuery(e.target.value),
            // 焦点留在搜索框（与弹窗一致）：上下移动高亮、Enter 选中，都不用先移焦点
            onKeyDown: navKey,
          }));
        }
        if (!items.length) {
          rows.push(h("div", { key: "__empty__", className: "rdp-menu-empty" }, "没有匹配的模型"));
        } else {
          view.forEach((g, gi) => {
            rows.push(h("div", { className: "rdp-menu-sec", key: "sec:" + gi },
              g.label ? h("div", { className: "rdp-menu-cap" }, g.label) : null,
              g.items.map((it) => {
                const idx = items.indexOf(it);
                const sel = it.value === value;
                return h("button", {
                  type: "button",
                  key: it.value,
                  className: "rdp-menu-item" + (idx === hi ? " is-hi" : "") + (sel ? " is-sel" : ""),
                  role: "option",
                  "aria-selected": sel ? "true" : "false",
                  title: it.value,
                  onMouseEnter: () => onHover(idx),
                  onClick: () => onPick(it.value),
                },
                  h("span", { className: "rdp-menu-name" }, it.label),
                  sel ? h("span", { className: "rdp-menu-tick", "aria-hidden": "true" }, "✓") : null);
              })));
          });
        }
        list = h("div", { className: "rdp-menu", role: "listbox" }, rows);
      }
      return h("div", { className: "rdp-pick" },
        h("button", {
          type: "button",
          disabled: !!disabled,
          className: "rdp-pick-btn" + (open ? " is-open" : ""),
          "aria-haspopup": "listbox",
          "aria-expanded": open ? "true" : "false",
          onClick: () => (open ? onClose() : onOpen()),
          // 空格只在按钮上算"打开/选中"；搜索框里那是正常输入，不能拦。
          onKeyDown: (e) => {
            if (e && e.key === " ") {
              e.preventDefault();
              if (open) { if (items[hi]) onPick(items[hi].value); } else onOpen();
              return;
            }
            navKey(e);
          },
        },
          h("span", { className: "rdp-pick-label" }, label),
          h("span", { className: "rdp-pick-caret", "aria-hidden": "true" }, "▾")),
        list);
    }

    // 调用点的唯一入口：选谁、给几组、开没开、点了写什么。括号只在函数体里出现一次。
    function pickerNode(state, key, exec, cat, value, disabled, placeholder, onPick) {
      const groups = groupedModels(exec, cat);
      return ModelPicker(Object.assign(
        { value, groups, disabled, placeholder },
        menuProps(state, key, groups, value, onPick),
      ));
    }

    // 三个环节共用同一份设置（stageOpinions），但分别渲染在各自的流程位置上 ——
    // 一次只画一行：由谁来做 + 当前值。功能说明归该节标题下的那句（hint），不在行里重复。
    function stageRow(args, stageId) {
      const { value, draft, setDraft, live, ctx, menu, setMenu } = args;
      const cat = panelCatalog(value, ctx);
      const cur = draft.stageOpinions !== undefined ? parseStages(draft.stageOpinions) : parseStages(value.stageOpinions);
      const all = STAGE_ROWS.map((base) => ({ ...base, ...(cur[base.id] || {}) }));
      const row = all.find((x) => x.id === stageId) || { id: stageId, executor: "", model: "" };
      const models = (cat.find((c) => c.exec === row.executor) || { models: [] }).models;
      const apply = (next) => setDraft({ ...draft, stageOpinions: next.map((x) => x.id + ":" + (x.executor || "") + ":" + (x.model || "")).join(";") });
      return h("div", { className: "rdp-items" },
        h("div", { className: "rdp-item" },
          h("div", { className: "rdp-item-main" },
            h("span", { className: "rdp-label" }, "由谁来做"),
            h("span", { className: "rdp-sub" }, "当前 ", h("code", null, (row.executor || "系统决定") + " · " + (row.model || "默认")))),
          h("div", { className: "rdp-ctl" },
            h("div", { className: "rdp-grid2" },
              h("select", { className: "rdp-in", disabled: !live, value: row.executor,
                onChange: (e) => apply(all.map((x) => (x.id === stageId ? { ...x, executor: e.target.value, model: "" } : x))) },
                h("option", { key: "", value: "" }, "默认（系统决定）"),
                cat.map((c) => h("option", { key: c.exec, value: c.exec }, c.exec))),
              pickerNode({ menu, setMenu }, "stage:" + stageId, row.executor, cat, row.model, !live,
                defaultModelLabel(row.executor, cat, "未探测到模型"),
                (m) => apply(all.map((x) => (x.id === stageId ? { ...x, model: m } : x))))))));
    }


    function Page(props) {
      const ctx = props.ctx;
      const [st, setSt] = React.useState({ phase: "loading" });
      const [draft, setDraft] = React.useState({});
      const [phase, setPhase] = React.useState("idle");
      const [, bump] = React.useState(0);
      // 模型弹层的唯一状态：没打开时 key=null。放在 Page 上是因为 ModelPicker 本身无 hook ——
      // 组件一旦有 hook，自检里"点开一行"要模拟整棵状态树，而生产上任何一处钩子顺序变化都是空白页。
      const [menu, setMenu] = React.useState({ key: null, hi: 0 });

      React.useEffect(() => {
        let alive = true;
        // ⑦ 两种失败分别落两个状态：nons = describe 通了但没有本命名空间；nogw = 连不上网关。
        const fail = (e) => {
          if (!alive) return;
          clearTimeout(timer);
          if (e && e.code === "NS_MISSING") setSt({ phase: "nons", why: String(e.message || e) });
          else setSt({ phase: "nogw", why: String((e && e.message) || e) });
        };
        const reload = () => { readDescriptor(ctx).then((d) => { if (alive && d) setSt({ phase: "ready", desc: d }); }).catch(fail); };
        watchers.add(reload);
        const timer = setTimeout(() => {
          if (alive && st.phase === "loading") setSt({ phase: "nogw", why: "设置服务 3 秒内没有返回" });
        }, 3000);
        readDescriptor(ctx)
          .then((d) => {
            if (!alive) return;
            clearTimeout(timer);
            if (d) setSt({ phase: "ready", desc: d });
            else setSt({ phase: "nogw", why: "连不上设置服务" });
          })
          .catch(fail);
        return () => { alive = false; clearTimeout(timer); watchers.delete(reload); };
      }, []);

      const desc = st.phase === "ready" ? st.desc : null;
      const value = (desc && desc.value) || {};
      const user = (desc && desc.user) || {};
      const live = !!desc;
      const allFields = live ? fieldsOf(desc) : FALLBACK_FIELDS;
      const fields = allFields;
      // HIDDEN = 元信息，界面上不铺开（用户不该在面板上改仓库根与宿主探测值）。
      // DEDICATED = 已经有专用控件的键：必须从 otherFields 里排除，否则会被"高级项"
      // 兜底再渲染一次（stageOpinions 之前就是这样渲染两次的），或者干脆一个都不渲染
      // （10 个座位键以前落在 seatKeys 里、又没人画，于是面板上根本没有座位控件）。
      const HIDDEN = new Set(["executorCatalog", "otherStages", "repoRoot", "seatsFile"]);
      // 有专用控件的键必须从"高级项"兜底里排除，否则会被再画一遍。
      // divergeCommand / divergeModel 也有专用控件（发散环节那两个下拉）—— 以前漏了它们，
      // 于是「高级项」里又用原始键名各画一次，同一个值出现两个输入框。
      const DEDICATED = new Set(["reviewVotes", "stageOpinions", "divergeCommand", "divergeModel"]);
      const otherFields = allFields.filter((f) => !HIDDEN.has(f.key) && !DEDICATED.has(f.key));
      const text = (f) => (draft[f.key] !== undefined ? draft[f.key] : String(value[f.key] === undefined ? "" : value[f.key]));
      const dirty = live && fields.some((f) => draft[f.key] !== undefined && draft[f.key] !== String(value[f.key] === undefined ? "" : value[f.key]));

      // 点弹层外面收起：没有 document（Node 自检）时整段跳过。
      React.useEffect(() => {
        if (typeof document === "undefined" || !document.addEventListener) return undefined;
        const onDocDown = (e) => {
          const t = e && e.target;
          if (t && typeof t.closest === "function" && t.closest(".rdp-pick")) return;
          setMenu({ key: null, hi: 0 });
        };
        document.addEventListener("mousedown", onDocDown);
        return () => document.removeEventListener("mousedown", onDocDown);
      }, [menu.key]);

      const save = () => {
        if (!live) return;
        const patch = {};
        for (const f of fields) {
          if (draft[f.key] === undefined) continue;
          if (draft[f.key] !== String(value[f.key] === undefined ? "" : value[f.key])) patch[f.key] = draft[f.key];
        }
        if (Object.keys(patch).length === 0) { setDraft({}); return; }
        setPhase("saving");
        writePatch(ctx, patch, desc.revision)
          .then(() => readDescriptor(ctx))
          .then((d) => { if (d) setSt({ phase: "ready", desc: d }); setDraft({}); setPhase("saved"); })
          .catch((e) => setPhase("failed:" + ((e && e.message) || e)));
      };


      // 三个"只登记"的环节各自独立渲染，失败只坏一节（其余设置不受影响）
      const safeStage = (id) => {
        try { return stageRow({ value, draft, setDraft, live, ctx, menu, setMenu }, id); }
        catch (e) {
          return h("div", { className: "rdp-items" },
            h("div", { className: "rdp-item" },
              h("div", { className: "rdp-item-main" },
                h("span", { className: "rdp-meta" }, "这一节渲染失败（不影响其它设置）：" + ((e && e.message) || e)))));
        }
      };
      const stageHead = (row) => h("div", { className: "rdp-group", key: "sec-" + row.id },
        h("h3", { className: "rdp-group-t" }, row.label),
        h("p", { className: "rdp-group-d" }, row.hint + STAGE_NOTE));

      return h("div", { className: "rdp" },
        h("div", { className: "rdp-head", key: "head" },
          h("h2", { className: "rdp-title" }, "科研派工 · 评审与环节"),
          h("p", { className: "rdp-lead" }, "这一页按科研流程从上到下排：文献调研 → 发散 → 评审 → 新颖度复查 → 实现与实验。改完保存即可。")),
        live ? null : h("div", { className: "rdp-state", key: "state" },
          st.phase === "loading"
            ? "正在连接设置服务…（首次打开会慢一点）"
            : st.phase === "nons"
              ? "设置服务连上了，但本页暂时没有可编辑项。先用默认设置即可；需要改动时请参考项目说明。"
              : "连不上设置服务（原因：" + st.why + "），这一页只能看说明、不能修改。稍后重试，或检查桌面端是否正常运行。"),
        stageHead(STAGE_ROWS[0]),
        safeStage("scout"),
        h("div", { className: "rdp-group", key: "sec-diverge" },
          h("h3", { className: "rdp-group-t" }, "发散"),
          h("p", { className: "rdp-group-d" }, "需要让 AI 先出一批候选想法时才用这里。平时不用管；留空就用默认的模型。")),
(() => {
          const cat = panelCatalog(value, ctx);
          if (cat.length === 0) {
            return h("div", { className: "rdp-items", key: "diverge" },
              h("div", { className: "rdp-item" },
                h("div", { className: "rdp-item-main" },
                  h("span", { className: "rdp-label" }, "由谁发散"),
                  h("span", { className: "rdp-meta" }, "没有找到可用的模型清单 —— 留空就用默认模型。"))));
          }
          const curExec = draft.divergeCommand !== undefined ? draft.divergeCommand : String(value.divergeCommand === undefined ? "" : value.divergeCommand);
          const curModel = draft.divergeModel !== undefined ? draft.divergeModel : String(value.divergeModel === undefined ? "" : value.divergeModel);
          const active = cat.find((c) => c.exec === curExec) || cat[0] || { exec: "", models: [] };
          return h("div", { className: "rdp-items", key: "diverge" },
            h("div", { className: "rdp-item" },
              h("div", { className: "rdp-item-main" },
                h("span", { className: "rdp-label" }, "由谁发散"),
                h("span", { className: "rdp-sub" }, "当前 ", h("code", null, (curExec || active.exec || "默认") + " · " + (curModel || "默认")))),
              h("div", { className: "rdp-ctl" },
                h("div", { className: "rdp-grid2" },
                  h("select", { className: "rdp-in", disabled: !live, value: curExec || active.exec,
                    onChange: (e) => setDraft({ ...draft, divergeCommand: e.target.value, divergeModel: "" }) },
                    cat.map((c) => h("option", { key: c.exec, value: c.exec }, c.exec))),
                  pickerNode({ menu, setMenu }, "diverge", active.exec, cat, curModel, !live,
                    defaultModelLabel(active.exec, cat, "默认（用它自己的默认模型）"),
                    (m) => setDraft({ ...draft, divergeModel: m }))))));
        })(),
        h("div", { className: "rdp-group", key: "sec-review" },
          h("h3", { className: "rdp-group-t" }, "评审"),
          h("p", { className: "rdp-group-d" }, "每轮都用这一组票。每条想法交给几位评审员分别打分，最后由你决定采纳哪一条。排几票就有几位评审员；一票都不排，就按默认的三位。")),
(() => {
          const cat = panelCatalog(value, ctx);
          const rows = draft.reviewVotes !== undefined ? String(draft.reviewVotes).split(",").map((t) => {
            const i = t.indexOf(":");
            return i < 0 ? { executor: t, model: "" } : { executor: t.slice(0, i), model: t.slice(i + 1) };
          }) : voteRows(value);
          const apply = (next) => setDraft({ ...draft, reviewVotes: voteString(next) });
          return h("div", { key: "votes" },
            h("div", { className: "rdp-items" },
              rows.map((row, idx) => {
                const models = (cat.find((c) => c.exec === row.executor) || { models: [] }).models;
                return h("div", { className: "rdp-item", key: "v" + idx },
                  h("div", { className: "rdp-item-main" },
                    h("span", { className: "rdp-label" }, "票 " + (idx + 1)),
                    h("span", { className: "rdp-sub" }, "当前 ", h("code", null, row.executor + " · " + (row.model || "默认")))),
                  h("div", { className: "rdp-ctl" },
                    h("div", { className: "rdp-grid2" },
                      h("select", { className: "rdp-in", disabled: !live, value: row.executor,
                        onChange: (e) => apply(rows.map((r, i) => (i === idx ? { executor: e.target.value, model: "" } : r))) },
                        cat.map((c) => h("option", { key: c.exec, value: c.exec }, c.exec))),
                      pickerNode({ menu, setMenu }, "vote:" + idx, row.executor, cat, row.model, !live,
                        defaultModelLabel(row.executor, cat, "默认（用它自己的默认模型）"),
                        (m) => apply(rows.map((r, i) => (i === idx ? { ...r, model: m } : r))))),
                    rows.length > 1
                      ? h("button", {
                        type: "button", className: "rdp-btn rdp-btn-danger", title: "删除票 " + (idx + 1),
                        onClick: () => apply(rows.filter((_, i) => i !== idx)),
                      }, "删除")
                      : h("span", { className: "rdp-ctl-ghost", "aria-hidden": "true" })));
              }),
              cat.length === 0 ? h("div", { className: "rdp-empty", key: "nocat" },
                "没有找到可用的评审员清单。票仍然可以保存，实际由系统按默认安排。") : null),
            h("div", { className: "rdp-add-wrap", key: "add" },
              h("button", { type: "button", className: "rdp-btn rdp-add", disabled: !live,
                onClick: () => apply(rows.concat([{ executor: (cat[0] || {}).exec || "codex", model: "" }])) }, "+ 加一票")),
          );
        })(),
        h("p", { className: "rdp-note", key: "seats-hint" }, SEATS_HINT),
        stageHead(STAGE_ROWS[1]),
        safeStage("novelty"),
        stageHead(STAGE_ROWS[2]),
        safeStage("implement"),
        otherFields.length === 0 ? null : h("div", { className: "rdp-group", key: "adv" },
          h("h3", { className: "rdp-group-t" }, "高级项"),
          h("p", { className: "rdp-group-d" }, "这里是没有专用控件的项目，日常不用修改；仓库位置这类内部设置不在页面上展开。")),
        otherFields.map((f) => h("div", { className: "rdp-item rdp-item-full", key: f.key },
          h("div", { className: "rdp-item-main" },
            h("span", { className: "rdp-label" }, f.title,
              live && Object.prototype.hasOwnProperty.call(user, f.key) ? h("span", { className: "rdp-badge" }, "已覆盖") : null),
            h("input", { className: "rdp-in", type: "text", disabled: !live, value: text(f),
              placeholder: live ? String(f.default === undefined ? "" : f.default) : "（当前不可编辑）",
              onChange: (e) => setDraft({ ...draft, [f.key]: e.target.value }) }),
            f.description ? h("span", { className: "rdp-meta" }, f.description) : null),
        )),
        h("div", { className: "rdp-foot", key: "foot" },
          h("span", { className: "rdp-foot-msg" },
            phase === "saved" ? h("span", { className: "rdp-ok" }, "已保存，下一轮生效")
              : phase.indexOf("failed") === 0 ? h("span", { className: "rdp-bad" }, "保存失败：" + phase.slice(7))
              : (live ? "" : "当前不可编辑，保存不可用")),
          h("div", { className: "rdp-foot-ctl" },
            h("button", { className: "rdp-btn", type: "button", disabled: !dirty || phase === "saving",
              onClick: () => { setDraft({}); setPhase("idle"); } }, "放弃"),
            h("button", { className: "rdp-btn rdp-primary", type: "button", disabled: !dirty || phase === "saving",
              onClick: save }, phase === "saving" ? "保存中" : "保存")),
        ),
      );
    }

    const name = "research-dispatch";
    // 只声明 slots：注册设置页必需（没声明就拿不到 ctx.slots）。
    // remote / settingsScope 一律走 ctx.get 懒取 —— 声明一个拿不到的服务 =
    // entry 永久 pending = 整个 web boot 失败，这条已经用一次崩溃换来过。
    // 插件级 inject 是**服务**名；包级 dsh.client.inject 是**包**名（模块依赖）。
    // 这两层我上一版混了：只声明 slots，于是 remote 即便存在也拿不到；
    // 而 settingsScope 那次崩溃是因为包级依赖没声明、设置域客户端根本没加载。
    // 参考 @eddyskywalker/dsh-chatgpt-subscription：包级注入 dsh-client-ui-settings 等，
    // 插件级 inject 里直接写 remote。
    // 决定性依据：官方 @deepseek-ai/dsh-client-ui-settings 的 client 里是
    //   const inject = ["remote", "remote.settings"];  ctx.remote.settings.describe()
    // 即 remote.settings 这个命名空间服务是"按声明发放"的 —— 不写进 inject，
    // 属性访问被守卫拦，ctx.get 也返回空（前几轮就卡在这里）。
    const inject = ["slots", "remote", "remote.settings"];

    function apply(ctx) {
      // 顺序是有讲究的：**注册必须先做**。下面任何一行探针抛异常，都不该让整页消失。
      try {
        ctx.slots.inject("settings.section", () => ctx.slots.register({
          name: "settings.section",
          id: "research-dispatch",
          order: 40,
          label: () => "科研派工",
        }, (p) => h(Page, { ...p, ctx })));
        diag.registered = true;
      } catch (e) {
        diag.error = String((e && e.message) || e);
        console.warn("[research-dispatch] 浏览器半注册失败，已跳过：" + (e && e.message));
        return;
      }
      // 可选光纤：remote 就绪后把网关递进来，页面自己重渲染。服务不来就永远不跑，
      // 插件本体照常工作 —— 这是 cordis 里"可选依赖"的正确姿势，代价只是拿不到。
      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["remote"], (child) => {
            try {
              const svc = child && child.remote;
              const resolved = resolveSettings(svc, child);
              setGateway(resolved);
              diag.remoteViaInject = !!resolved;
              if (svc && !resolved) {
                try { diag.remoteKeysViaInject = Object.keys(svc).slice(0, 40); } catch { /* 忽略 */ }
              }
            } catch (e) {
              diag.remoteInjectError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) {
        diag.injectError = String((e && e.message) || e);
      }
      // 可选光纤 ②：宿主模型目录（/model 弹窗用的那一份）。同样不写进 inject ——
      // 一条拿不到的服务会让 entry 永久 pending、整个 web boot 失败（这条用一次崩溃换来过）。
      // 拿到了就以它为准覆盖 dsh / subagent 两行的模型清单；拿不到则保持静态探测并留诊断。
      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["remote.session"], (child) => {
            try {
              const svc = (child && child["remote.session"])
                || (child && typeof child.get === "function" ? child.get("remote.session") : null)
                || (child && child.remote && child.remote.session);
              if (!svc || typeof svc.modelCatalog !== "function") {
                diag.liveCatalogError = "modelCatalog 不可用";
                return;
              }
              svc.modelCatalog().then((res) => {
                if (!res || res.ok !== true || !res.value || !Array.isArray(res.value.groups)) {
                  diag.liveCatalogError = "modelCatalog 返回形状不对";
                  return;
                }
                diag.liveCatalog = res.value.groups
                  .map((g) => String((g && (g.id || g.name)) || "?") + ":" + ((g && g.models) || []).length)
                  .join(";");
                setLiveGroups(res.value.groups);
              }).catch((e) => { diag.liveCatalogError = String((e && e.message) || e); });
            } catch (e) {
              diag.liveCatalogError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) { diag.liveCatalogError = String((e && e.message) || e); }
      // ⑨ <style> 是模块求值时插进 document.head 的：卸载时拆掉，别在 head 里留孤儿节点。
      try {
        if (STYLE_TAG && typeof ctx.effect === "function") {
          ctx.effect(() => () => {
            try { if (STYLE_TAG && typeof STYLE_TAG.remove === "function") STYLE_TAG.remove(); } catch { /* 已不在 DOM 里 */ }
            STYLE_TAG = null;
          });
        }
      } catch (e) { diag.effectError = String((e && e.message) || e); }
      // 注册完成后再写探针。每个字段单独 try：cordis 对"未声明服务"的读取是**抛异常**
      // （cannot get property "remote" without inject），不是返回 undefined ——
      // 所以探针绝不能直接摸 ctx.remote，只能走 ctx.get。
      try { pushStep("apply@" + Date.now()); } catch { /* 探针失败不影响功能 */ }
      try { diag.inject = inject.slice(); } catch { /* 同上 */ }
      try { diag.slots = !!(ctx && ctx.slots); } catch { /* 同上 */ }
      try { diag.remoteReachable = !!(ctx && ctx.get && ctx.get("remote")); } catch { /* 同上 */ }
    }
    // __test 只给自检用：把"读网关照 / 写回 / 从 schema 生成字段"三件事拆出来单测，
    // 免得为了测它们去模拟整棵 React 状态树。
    module.exports = {
      name, inject, apply,
      // __test：真实调用得出来的东西都导出来，自检断言直接跑函数，不再 grep 源码。
      __test: {
        readDescriptor, writePatch, fieldsOf, propsFromSchema,
        catalogOf, mergeCatalog, readModelDirectories,
        // 宿主目录（/model 弹窗同一份）：映射、覆盖、以及复位
        groupsToCatalog, panelCatalog, setLiveGroups, groupedModels, flattenGroups,
        modelMatch, filteredGroups,
        messagePlaceholder: null, ModelPicker, menuProps,
        liveGroups: () => LIVE_GROUPS,
        resetLiveCatalog: () => { LIVE_GROUPS = null; LIVE_CATALOG = null; },
        resetModelDirs: () => { EXTRA_MODELS = null; },
        EXECUTORS, SEATS_HINT,
        // 预览页要用的正是这一份 CSS 文本（不许另抄一份，否则"预览好看、真页面难看"）
        CSS: () => CSS,
      },
      default: { name, inject, apply },
    };
    return module.exports;
  },
});
