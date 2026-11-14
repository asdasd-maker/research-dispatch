/**
 * research-dispatch v2.2.1 — DSH 全流程阵容编排工作台 & Antigravity /swarm 科研拓扑星图（浏览器与桌面端双栖 bundle）。
 *
 * 同时挂载四大客户端槽位：
 *   1. settings.section.icon     — 设置左栏「科研派工」专属矢量拓扑图标；
 *   2. conversation.view         — 会话顶栏一键切换「科研拓扑」全屏交互星图（自动跟随当前会话工作区）；
 *   3. conversation.session.header.utilities — 会话右上角实时状态胶囊（显示当前阶段与活跃 Worker 数，点击直达拓扑图）；
 *   4. settings.section          — 设置页双视图工作台：「阵容编排」（Bento 卡片）+「科研拓扑」（S0→S6 轨道 + SVG 星图 + 人类拍板台）。
 */
window.__ModuleLoader__.load({
  id: "research-dispatch",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const h = React.createElement;
    const NS = "research-dispatch";
    const RPC_CHANNEL = "/api";
    const RPC_EXEC_METHOD = "research-dispatch/executors";
    const RPC_SWARM_METHOD = "research-dispatch/swarm-state";
    const RPC_ACTION_METHOD = "research-dispatch/action";
    const BRIDGE_EXEC_PATH = "/api/research-dispatch/executors";
    const BRIDGE_SWARM_PATH = "/api/research-dispatch/swarm-state";
    const BRIDGE_ACTION_PATH = "/api/research-dispatch/action";

    // ── 旗舰级 Bento 工作台 & /swarm 拓扑星图样式（自适应明暗主题 --dsw-alias-*）──
    const CSS = [
      ".rdp{max-width:880px;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary,#0f172a);font-size:13px;line-height:1.6;container-type:inline-size;padding-bottom:28px}",
      ".rdp.is-swarm{max-width:1180px}",
      ".rdp-hero{position:relative;display:flex;flex-direction:column;gap:12px;padding:18px 20px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 7%,var(--dsw-alias-bg-layer-1,rgba(148,163,184,.05))),var(--dsw-alias-bg-base,transparent) 68%);box-shadow:0 4px 20px rgba(15,23,42,.04)}",
      ".rdp-hero-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}",
      ".rdp-head{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1 1 320px}",
      ".rdp-eyebrow{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-brand-primary,#4f46e5)}",
      ".rdp-title{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em;line-height:1.35}",
      ".rdp-lead{margin:2px 0 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#64748b);line-height:1.65;max-width:74ch}",
      ".rdp-tabs{display:inline-flex;align-items:center;gap:4px;padding:4px;border-radius:11px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.10));flex:0 0 auto}",
      ".rdp-tab{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 13px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#475569);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:all .15s ease}",
      ".rdp-tab:hover{color:var(--dsw-alias-label-primary,#0f172a)}",
      ".rdp-tab.is-active{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f172a);font-weight:600;box-shadow:0 1px 4px rgba(15,23,42,.10)}",
      ".rdp-tab-dot{width:7px;height:7px;border-radius:999px;background:#10b981}",
      ".rdp-tab-dot.is-working{background:#06b6d4;box-shadow:0 0 0 3px rgba(6,182,212,.22);animation:rdpPulse 1.6s ease-in-out infinite}",
      ".rdp-fleet{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(148,163,184,.18))}",
      ".rdp-fleet-chip{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22));background:var(--dsw-alias-bg-base,rgba(255,255,255,.55));font-size:11.5px;color:var(--dsw-alias-label-secondary,#475569)}",
      ".rdp-fleet-chip.is-off{opacity:.62;border-style:dashed}",
      ".rdp-fleet-dot{width:7px;height:7px;border-radius:999px;flex:0 0 auto}",
      ".rdp-fleet-cnt{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#64748b);padding-left:2px}",
      ".rdp-fleet-refresh{margin-left:auto;height:26px;padding:0 10px;font-size:11.5px;border-radius:999px}",
      ".rdp-state{margin-top:14px;padding:12px 16px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));font-size:12.5px;color:var(--dsw-alias-label-secondary,#475569);line-height:1.65}",
      ".rdp-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-fg,#c77c1b) 38%,var(--dsw-alias-border-l1,rgba(148,163,184,.25)));background:color-mix(in srgb,var(--dsw-alias-state-warning-fg,#c77c1b) 9%,transparent);color:var(--dsw-alias-label-primary,#0f172a)}",
      ".rdp-bento{margin-top:14px;padding:18px 20px;border-radius:15px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22));background:var(--dsw-alias-bg-layer-1,rgba(148,163,184,.04));transition:border-color .16s ease,box-shadow .16s ease}",
      ".rdp-bento:hover{border-color:var(--dsw-alias-border-l3,rgba(148,163,184,.38));box-shadow:0 6px 22px rgba(15,23,42,.045)}",
      ".rdp-group{display:flex;flex-direction:column}",
      ".rdp-group-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",
      ".rdp-step-pill{display:inline-flex;align-items:center;justify-content:center;height:20px;padding:0 8px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:#fff;background:#4f46e5}",
      ".rdp-step-s0{background:linear-gradient(135deg,#2563eb,#0ea5e9)}",
      ".rdp-step-s2{background:linear-gradient(135deg,#7c3aed,#a855f7)}",
      ".rdp-step-s4{background:linear-gradient(135deg,#0d9488,#10b981)}",
      ".rdp-step-s45{background:linear-gradient(135deg,#d97706,#f59e0b)}",
      ".rdp-step-ws{background:linear-gradient(135deg,#334155,#475569)}",
      ".rdp-group-t{margin:0;font-size:15px;font-weight:650;letter-spacing:-.005em}",
      ".rdp-group-d{margin:5px 0 0;font-size:12.5px;color:var(--dsw-alias-label-tertiary,#64748b);line-height:1.65;max-width:72ch}",
      ".rdp-items{display:flex;flex-direction:column;margin-top:10px}",
      ".rdp-item{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:12px 0;border-top:.5px solid var(--dsw-alias-border-l2,rgba(148,163,184,.18))}",
      ".rdp-items .rdp-item:first-child{border-top:0;padding-top:6px}",
      ".rdp-items .rdp-item:last-child{padding-bottom:2px}",
      ".rdp-item-full{grid-template-columns:minmax(0,1fr)}",
      ".rdp-item-main{display:flex;flex-direction:column;gap:4px;min-width:0}",
      ".rdp-label{font-size:13px;font-weight:560;display:flex;align-items:center;gap:8px;min-width:0}",
      ".rdp-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#64748b);min-width:0}",
      ".rdp-inherit{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:11px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 10%,transparent);color:var(--dsw-alias-brand-primary,#4f46e5)}",
      ".rdp-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#64748b);line-height:1.6}",
      ".rdp code{font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#334155);background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.12));padding:1px 6px;border-radius:5px}",
      ".rdp-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-grid2{display:grid;grid-template-columns:188px 232px;gap:8px}",
      ".rdp-in{font:inherit;font-size:12.5px;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f172a);box-sizing:border-box;width:100%;transition:border-color .14s ease,box-shadow .14s ease}",
      "select.rdp-in{padding-right:26px;cursor:pointer}",
      ".rdp-in-path{width:428px;max-width:100%}",
      ".rdp-in-num{width:104px;text-align:center;font-weight:600}",
      ".rdp-in-mode{width:304px;max-width:100%}",
      ".rdp-in:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(148,163,184,.5))}",
      ".rdp-in:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4f46e5);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 16%,transparent)}",
      ".rdp-in:disabled{opacity:.55;cursor:default}",
      ".rdp-ws-strip{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:8px}",
      ".rdp-ws-cap{font-size:11.5px;color:var(--dsw-alias-label-tertiary,#64748b);margin-right:2px}",
      ".rdp-ws-pill{display:inline-flex;align-items:center;gap:5px;height:25px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#475569);font:inherit;font-size:11.5px;cursor:pointer;transition:all .14s ease}",
      ".rdp-ws-pill:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f46e5);color:var(--dsw-alias-label-primary,#0f172a)}",
      ".rdp-ws-pill.is-active{border-color:var(--dsw-alias-brand-primary,#4f46e5);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 12%,transparent);color:var(--dsw-alias-brand-primary,#4f46e5);font-weight:600}",
      ".rdp-ws-star{color:#10b981;font-size:11px}",
      ".rdp-pick{position:relative;min-width:0}",
      ".rdp-pick-btn{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;padding:0 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f172a);font:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:border-color .14s ease,box-shadow .14s ease}",
      ".rdp-pick-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l3,rgba(148,163,184,.5))}",
      ".rdp-pick-btn:focus-visible{outline:none;border-color:var(--dsw-alias-brand-primary,#4f46e5);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 16%,transparent)}",
      ".rdp-pick-btn:disabled{opacity:.55;cursor:default}",
      ".rdp-pick-btn.is-open{border-color:var(--dsw-alias-brand-primary,#4f46e5)}",
      ".rdp-pick-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-pick-caret{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-label-tertiary,#64748b)}",
      ".rdp-menu{position:absolute;z-index:50;top:calc(100% + 5px);right:0;width:max(300px,100%);max-height:340px;overflow:auto;padding:8px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));background:var(--dsw-alias-bg-base,#fff);box-shadow:0 14px 36px rgba(15,23,42,.18)}",
      ".rdp-menu-search{display:block;width:100%;height:30px;margin:0 0 8px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));background:transparent;color:var(--dsw-alias-label-primary,#0f172a);font:inherit;font-size:12px;outline:none;box-sizing:border-box}",
      ".rdp-menu-search:focus{border-color:var(--dsw-alias-brand-primary,#4f46e5)}",
      ".rdp-menu-empty{padding:8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#64748b)}",
      ".rdp-menu-sec+.rdp-menu-sec{margin-top:4px}",
      ".rdp-menu-cap{display:inline-flex;align-items:center;height:20px;margin:4px 8px;padding:0 8px;border-radius:6px;background:var(--dsw-alias-label-primary,#0f172a);color:var(--dsw-alias-bg-base,#fff);font-size:11px;font-weight:600;letter-spacing:.01em}",
      ".rdp-menu-item{display:flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:30px;padding:0 9px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary,#0f172a);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}",
      ".rdp-menu-item:hover,.rdp-menu-item.is-hi{background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.14))}",
      ".rdp-menu-item.is-sel{color:var(--dsw-alias-brand-primary,#4f46e5);font-weight:600}",
      ".rdp-menu-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}",
      ".rdp-menu-tick{flex:0 0 auto;font-size:11px;color:var(--dsw-alias-brand-primary,#4f46e5)}",
      ".rdp-btn{font:inherit;font-size:12.5px;height:32px;padding:0 13px;border-radius:9px;cursor:pointer;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#475569);white-space:nowrap;flex:0 0 auto;transition:all .14s ease}",
      ".rdp-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.10));color:var(--dsw-alias-label-primary,#0f172a);border-color:var(--dsw-alias-border-l3,rgba(148,163,184,.45))}",
      ".rdp-btn:focus-visible{outline:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 16%,transparent)}",
      ".rdp-btn:disabled{opacity:.45;cursor:default}",
      ".rdp-btn-sm{height:27px;padding:0 10px;font-size:11.5px;border-radius:7px}",
      ".rdp-btn-danger{height:28px;padding:0 9px;border-color:transparent;color:var(--dsw-alias-label-tertiary,#64748b);background:transparent}",
      ".rdp-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-danger-fg,#d0554a);background:color-mix(in srgb,var(--dsw-alias-state-danger-fg,#d0554a) 10%,transparent);border-color:transparent}",
      ".rdp-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#4f46e5));color:var(--dsw-alias-button-primary-text,#fff);font-weight:560}",
      ".rdp-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,#4338ca));color:#fff;border-color:transparent}",
      ".rdp-add-wrap{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}",
      ".rdp-add{flex:1 1 200px;height:34px;border-style:dashed;color:var(--dsw-alias-label-secondary,#475569)}",
      ".rdp-add:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary,#4f46e5);color:var(--dsw-alias-brand-primary,#4f46e5);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 5%,transparent)}",
      ".rdp-note{margin:14px 4px 0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#64748b);line-height:1.65}",
      ".rdp-empty{padding:10px 14px;border:1px dashed var(--dsw-alias-border-l2,rgba(148,163,184,.3));border-radius:10px;font-size:12px;color:var(--dsw-alias-label-tertiary,#64748b);line-height:1.65;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}",
      ".rdp-slot-pills{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".rdp-badge{font-size:10.5px;font-weight:600;padding:1px 8px;border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 12%,transparent);color:var(--dsw-alias-brand-primary,#4f46e5)}",
      ".rdp-foot{position:sticky;bottom:0;z-index:20;display:flex;align-items:center;gap:12px;margin-top:18px;padding:12px 16px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 88%,transparent);backdrop-filter:blur(10px)}",
      ".rdp-foot-msg{font-size:12px;color:var(--dsw-alias-label-tertiary,#64748b);margin-right:auto}",
      ".rdp-foot-ctl{display:flex;align-items:center;gap:8px}",
      ".rdp-ok{color:var(--dsw-alias-state-success-fg,#10b981);font-weight:550}",
      ".rdp-bad{color:var(--dsw-alias-state-danger-fg,#ef4444);font-weight:550}",

      // ── 会话右上角状态胶囊（conversation.session.header.utilities）──────
      ".rdp-hdr-pill{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.26));background:var(--dsw-alias-bg-layer-1,rgba(148,163,184,.08));color:var(--dsw-alias-label-secondary,#475569);font:inherit;font-size:11.5px;font-weight:550;cursor:pointer;transition:all .15s ease}",
      ".rdp-hdr-pill:hover{border-color:var(--dsw-alias-brand-primary,#4f46e5);color:var(--dsw-alias-label-primary,#0f172a);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 8%,transparent)}",
      ".rdp-hdr-pill.is-working{border-color:rgba(6,182,212,.45);background:rgba(6,182,212,.10);color:#0891b2}",

      // ── /swarm 科研拓扑星图工作台（Settings Tab 2 & conversation.view 共用）──
      ".rdp-swarm-shell{display:flex;flex-direction:column;gap:12px;padding:16px;box-sizing:border-box;color:var(--dsw-alias-label-primary,#0f172a);font-size:12.5px;height:100%;overflow:auto}",
      ".rdp-swarm-shell.is-embedded{padding:14px 0 0;height:auto;overflow:visible}",
      ".rdp-swarm-bar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 14px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:var(--dsw-alias-bg-layer-1,rgba(148,163,184,.05))}",
      ".rdp-swarm-bar-l,.rdp-swarm-bar-r{display:flex;align-items:center;gap:8px;flex-wrap:wrap}",
      ".rdp-topic-pill{height:25px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.25));background:transparent;color:var(--dsw-alias-label-secondary,#475569);font:inherit;font-size:11.5px;cursor:pointer}",
      ".rdp-topic-pill.is-active{border-color:var(--dsw-alias-brand-primary,#4f46e5);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 12%,transparent);color:var(--dsw-alias-brand-primary,#4f46e5);font-weight:600}",
      ".rdp-rail{display:grid;grid-template-columns:repeat(8,minmax(108px,1fr));gap:8px;overflow-x:auto;padding-bottom:2px}",
      ".rdp-stage-card{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:9px 11px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.22));background:var(--dsw-alias-bg-layer-1,rgba(148,163,184,.04));color:var(--dsw-alias-label-primary,#0f172a);font:inherit;text-align:left;cursor:pointer;transition:all .15s ease}",
      ".rdp-stage-card:hover{border-color:var(--dsw-alias-border-l3,rgba(148,163,184,.45));transform:translateY(-1px)}",
      ".rdp-stage-card.is-active{border-color:var(--dsw-alias-brand-primary,#4f46e5);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 9%,var(--dsw-alias-bg-base,transparent));box-shadow:0 4px 14px color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 14%,transparent)}",
      ".rdp-stage-top{display:flex;align-items:center;justify-content:space-between;width:100%;gap:4px}",
      ".rdp-stage-id{font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#64748b)}",
      ".rdp-stage-dot{width:7px;height:7px;border-radius:999px;background:#94a3b8}",
      ".rdp-stage-dot.st-done{background:#10b981}",
      ".rdp-stage-dot.st-working{background:#06b6d4;box-shadow:0 0 0 3px rgba(6,182,212,.22);animation:rdpPulse 1.5s infinite}",
      ".rdp-stage-dot.st-pending{background:#f59e0b}",
      ".rdp-stage-name{font-size:12px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}",
      ".rdp-stage-cnt{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;width:100%}",
      ".rdp-ideas-strip{display:flex;align-items:center;gap:6px;overflow-x:auto;padding:4px 2px}",
      ".rdp-idea-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-secondary,#475569);font:inherit;font-size:11.5px;white-space:nowrap;cursor:pointer;transition:all .14s ease}",
      ".rdp-idea-chip:hover{border-color:var(--dsw-alias-brand-primary,#4f46e5);color:var(--dsw-alias-label-primary,#0f172a)}",
      ".rdp-idea-chip.is-active{border-color:var(--dsw-alias-brand-primary,#4f46e5);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4f46e5) 12%,transparent);color:var(--dsw-alias-brand-primary,#4f46e5);font-weight:600}",
      ".rdp-vtag{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;text-transform:uppercase}",
      ".rdp-vtag-go{background:rgba(16,185,129,.15);color:#059669}",
      ".rdp-vtag-revise{background:rgba(245,158,11,.16);color:#d97706}",
      ".rdp-vtag-kill{background:rgba(239,68,68,.14);color:#dc2626}",
      ".rdp-vtag-pending{background:rgba(99,102,241,.14);color:#4f46e5}",
      ".rdp-swarm-body{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;align-items:stretch;min-height:470px}",
      ".rdp-canvas-card{display:flex;flex-direction:column;justify-content:space-between;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--dsw-alias-label-tertiary,#64748b) 20%,transparent) 1px,transparent 0) 0 0/20px 20px,var(--dsw-alias-bg-layer-1,rgba(15,23,42,.02));overflow:hidden;position:relative}",
      ".rdp-svg{width:100%;height:auto;min-height:420px;display:block;user-select:none}",
      ".rdp-edge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-tertiary,#64748b) 38%,transparent);stroke-width:1.75;transition:stroke .2s ease}",
      ".rdp-edge.st-done{stroke:rgba(16,185,129,.58)}",
      ".rdp-edge.st-pending{stroke:rgba(245,158,11,.55);stroke-dasharray:5 5}",
      ".rdp-edge.st-working{stroke:#06b6d4;stroke-width:2.4;stroke-dasharray:7 5;animation:rdpFlow .9s linear infinite}",
      ".rdp-edge.st-failed{stroke:rgba(239,68,68,.65);stroke-dasharray:4 4}",
      ".rdp-gnode{cursor:pointer;transition:opacity .15s ease}",
      ".rdp-gnode-box{fill:var(--dsw-alias-bg-base,#ffffff);stroke:var(--dsw-alias-border-l1,rgba(148,163,184,.38));stroke-width:1.2;transition:stroke .15s ease,stroke-width .15s ease}",
      ".rdp-gnode:hover .rdp-gnode-box{stroke:var(--dsw-alias-brand-primary,#4f46e5);stroke-width:1.8}",
      ".rdp-gnode.is-selected .rdp-gnode-box{stroke:var(--dsw-alias-brand-primary,#4f46e5);stroke-width:2.3}",
      ".rdp-canvas-legend{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 14px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(148,163,184,.18));background:color-mix(in srgb,var(--dsw-alias-bg-base,#fff) 80%,transparent);font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b)}",
      ".rdp-legend-items{display:flex;align-items:center;gap:12px;flex-wrap:wrap}",
      ".rdp-legend-i{display:inline-flex;align-items:center;gap:5px}",
      ".rdp-drawer{display:flex;flex-direction:column;gap:12px;padding:14px 15px;border-radius:16px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.24));background:var(--dsw-alias-bg-layer-1,rgba(148,163,184,.04));max-height:560px;overflow-y:auto}",
      ".rdp-drawer-h{display:flex;flex-direction:column;gap:4px;padding-bottom:10px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(148,163,184,.2))}",
      ".rdp-drawer-t{margin:0;font-size:14px;font-weight:650;line-height:1.4}",
      ".rdp-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 10px;font-size:11.5px}",
      ".rdp-kv-k{color:var(--dsw-alias-label-tertiary,#64748b);white-space:nowrap}",
      ".rdp-kv-v{color:var(--dsw-alias-label-primary,#0f172a);font-weight:520;word-break:break-all}",
      ".rdp-sec-cap{font-size:11px;font-weight:650;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary,#64748b);text-transform:uppercase;margin-bottom:4px}",
      ".rdp-push-list{display:flex;flex-direction:column;gap:5px}",
      ".rdp-push-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.09));font-size:11.5px}",
      ".rdp-dim-list{display:flex;flex-direction:column;gap:7px}",
      ".rdp-dim-row{display:flex;flex-direction:column;gap:3px}",
      ".rdp-dim-top{display:flex;align-items:center;justify-content:space-between;font-size:11.5px}",
      ".rdp-dim-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,rgba(148,163,184,.18));overflow:hidden}",
      ".rdp-dim-fill{height:100%;border-radius:999px;background:linear-gradient(90deg,#6366f1,#10b981)}",
      ".rdp-dim-reason{font-size:11px;color:var(--dsw-alias-label-tertiary,#64748b);line-height:1.45}",
      ".rdp-verdict-box{display:flex;flex-direction:column;gap:8px;padding:10px 11px;border-radius:11px;border:1px solid color-mix(in srgb,#f59e0b 38%,var(--dsw-alias-border-l1,rgba(148,163,184,.25)));background:color-mix(in srgb,#f59e0b 7%,transparent)}",
      ".rdp-verdict-btns{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}",
      ".rdp-vbtn{height:30px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.3));background:var(--dsw-alias-bg-base,transparent);font:inherit;font-size:11.5px;font-weight:650;cursor:pointer;transition:all .14s ease}",
      ".rdp-vbtn-go:hover,.rdp-vbtn-go.is-sel{border-color:#10b981;background:rgba(16,185,129,.15);color:#059669}",
      ".rdp-vbtn-revise:hover,.rdp-vbtn-revise.is-sel{border-color:#f59e0b;background:rgba(245,158,11,.16);color:#d97706}",
      ".rdp-vbtn-kill:hover,.rdp-vbtn-kill.is-sel{border-color:#ef4444;background:rgba(239,68,68,.15);color:#dc2626}",
      ".rdp-textarea{width:100%;min-height:56px;padding:7px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(148,163,184,.28));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f172a);font:inherit;font-size:12px;resize:vertical;box-sizing:border-box}",
      ".rdp-act-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}",
      ".rdp-preview{margin:0;padding:10px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2,rgba(148,163,184,.2));background:var(--dsw-alias-bg-base,rgba(15,23,42,.03));font-family:var(--dsh-claude-font-code,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);font-size:11px;line-height:1.55;color:var(--dsw-alias-label-secondary,#334155);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}",
      "@keyframes rdpFlow{to{stroke-dashoffset:-24}}",
      "@keyframes rdpPulse{0%,100%{opacity:1}50%{opacity:.42}}",
      "@container (max-width:860px){.rdp-swarm-body{grid-template-columns:minmax(0,1fr)}.rdp-rail{grid-template-columns:repeat(4,minmax(110px,1fr))}}",
      "@container (max-width:580px){.rdp-item{grid-template-columns:minmax(0,1fr)}.rdp-ctl{justify-content:flex-start;width:100%}.rdp-grid2{grid-template-columns:1fr 1fr;width:100%}.rdp-in-path,.rdp-in-mode{width:100%}}",
      "@media (max-width:860px){.rdp-swarm-body{grid-template-columns:minmax(0,1fr)}.rdp-rail{grid-template-columns:repeat(4,minmax(110px,1fr))}}",
      "@media (prefers-reduced-motion:reduce){.rdp *,.rdp-swarm-shell *{transition:none!important;animation:none!important}}",
    ].join("");

    let STYLE_TAG = null;
    function ensureStyleTag() {
      try {
        if (typeof document === "undefined" || !document || typeof document.querySelector !== "function") return;
        const existing = document.querySelector('style[data-plugin-css="research-dispatch"]');
        if (existing) {
          existing.textContent = CSS;
          STYLE_TAG = existing;
          return;
        }
        if (document.head && typeof document.createElement === "function") {
          const tag = document.createElement("style");
          tag.dataset.plugin = "research-dispatch";
          tag.dataset.pluginCss = "research-dispatch";
          tag.textContent = CSS;
          document.head.appendChild(tag);
          STYLE_TAG = tag;
        }
      } catch { /* 样式挂载失败不影响功能 */ }
    }
    ensureStyleTag();

    const diag = (typeof window !== "undefined")
      ? (window.__researchDispatch = window.__researchDispatch || { steps: [] })
      : { steps: [] };
    const STEP_CAP = 50;
    function pushStep(step) {
      diag.steps.push(step);
      if (diag.steps.length > STEP_CAP) diag.steps.splice(0, diag.steps.length - STEP_CAP);
    }
    pushStep("evaluated@" + Date.now());

    function isDshProfilePath(p) {
      const norm = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
      return /(?:^|\/)\.dsh\/profiles(?:\/|$)/i.test(norm);
    }

    // ── 设置服务解析：可选子光纤 + 多路反射兜底，绝不阻塞插件启动 ────────
    let GATEWAY = null;
    const watchers = new Set();
    function notifyWatchers() {
      for (const fn of watchers) {
        try { fn(); } catch { /* 单个订阅者异常不影响其余监听器 */ }
      }
    }
    function setGateway(gw) {
      GATEWAY = gw;
      notifyWatchers();
    }

    function resolveSettings(remote, ctx) {
      const tries = [];
      try {
        const s1 = ctx && ctx.get ? ctx.get("remote.settings") : null;
        if (s1 && typeof s1.describe === "function") { diag.resolveVia = 'ctx.get("remote.settings")'; return s1; }
        tries.push("ctx.get(\"remote.settings\") → " + (s1 ? "不是设置 API" : "空"));
      } catch (e) { tries.push("ctx.get(\"remote.settings\"): " + e.message); }

      try {
        const ns = remote && remote.namespaces;
        const s2 = ns ? (ns.settings || (typeof ns.get === "function" ? ns.get("settings") : null)) : null;
        if (s2 && typeof s2.describe === "function") { diag.resolveVia = "remote.namespaces.settings"; return s2; }
        tries.push("remote.namespaces → " + (ns ? "存在但没有 settings" : "无"));
      } catch (e) { tries.push("remote.namespaces: " + e.message); }

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
      if (!found) {
        const err = new Error("设置服务已连通，但未找到 " + NS + " 配置项");
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
      if (schema.properties && typeof schema.properties === "object") return schema.properties;
      return null;
    }

    const KNOWN_KEYS = [
      "repoRoot",
      "seatsFile",
      "scoutCommand",
      "scoutModel",
      "divergeCommand",
      "divergeModel",
      "divergeCount",
      "divergeUseDeadEnds",
      "reviewVotes",
      "noveltyCommand",
      "noveltyModel",
      "executorCatalog",
      "executorStatus",
      "otherStages",
      "stageOpinions",
    ];

    const LABELS = {
      repoRoot: "项目文件夹",
      seatsFile: "座位表路径",
      scoutCommand: "文献调研工具",
      scoutModel: "文献调研模型",
      divergeCommand: "想法发散工具",
      divergeModel: "想法发散模型",
      divergeCount: "单轮默认条数",
      divergeUseDeadEnds: "历史死胡同过滤",
      reviewVotes: "评审票",
      noveltyCommand: "前置查重工具",
      noveltyModel: "前置查重模型",
    };

    function fieldsOf(desc) {
      const props = propsFromSchema(desc && desc.schema);
      let keys;
      if (props) {
        keys = Object.keys(props);
      } else {
        const valKeys = Object.keys((desc && desc.value) || {});
        const seen = new Set();
        keys = [];
        for (const k of KNOWN_KEYS.concat(valKeys)) {
          if (k && !seen.has(k)) {
            seen.add(k);
            keys.push(k);
          }
        }
      }
      if (!diag.fieldKeys) diag.fieldKeys = keys.slice(0, 15);
      if (!diag.fieldSource) diag.fieldSource = props ? (USED_REFS ? "schema.refs" : "schema.properties") : "value+known keys";
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

    const FALLBACK_FIELDS = [
      { key: "repoRoot", title: "项目文件夹", description: "科研项目文件夹路径", default: "" },
      { key: "scoutCommand", title: "文献调研工具", description: "文献调研执行工具", default: "" },
      { key: "scoutModel", title: "文献调研模型", description: "文献调研模型", default: "" },
      { key: "divergeCommand", title: "想法发散工具", description: "想法发散执行工具", default: "" },
      { key: "divergeModel", title: "想法发散模型", description: "想法发散模型", default: "" },
      { key: "divergeCount", title: "单轮默认条数", description: "每次发散默认条数", default: "" },
      { key: "divergeUseDeadEnds", title: "历史死胡同过滤", description: "是否挂载历史已证伪方向", default: "" },
      { key: "reviewVotes", title: "评审票", description: "几票对应几位评审员", default: "" },
      { key: "noveltyCommand", title: "前置查重工具", description: "前置查重执行工具", default: "" },
      { key: "noveltyModel", title: "前置查重模型", description: "前置查重模型", default: "" },
    ];

    const SEATS_HINT = "提示：点击保存后，上方全部环节阵容会自动同步写入所选项目的配置文件中，桌面端与命令行共享生效；不会改动配置文件中手写的底层工具参数。";
    const STAGE_SEATS = ["codex", "claude", "dsh", "agy", "kimi"];
    const REVIEW_SEATS = STAGE_SEATS;
    const DIVERGE_SEATS = STAGE_SEATS;
    const SEAT_LABELS = {
      codex: "codex · Codex CLI",
      claude: "claude · Claude Code",
      dsh: "dsh · DeepSeek Harness",
      agy: "agy · Antigravity",
      kimi: "kimi · Kimi Code",
    };
    const SEAT_COLORS = {
      codex: "#10b981",
      claude: "#d97706",
      dsh: "#3b82f6",
      agy: "#8b5cf6",
      kimi: "#06b6d4",
    };
    const DIM_LABELS = {
      novelty: "新意",
      feasibility: "可行性",
      baseline_fit: "基线契合",
      impl_cost: "轻量省算力",
      expected_gain: "预期提升",
    };

    function statusOf(value) {
      const raw = String((value && value.executorStatus) || "");
      const out = {};
      for (const row of raw.split(";")) {
        const i = row.indexOf(":");
        if (i < 0) continue;
        const exec = row.slice(0, i).trim();
        const flag = row.slice(i + 1).trim();
        if (!exec || !flag) continue;
        out[exec] = flag === "1" || flag.toLowerCase() === "true";
      }
      return out;
    }

    function seatOptionLabel(exec, statusMap) {
      if (exec === "api") return "api · 旧配置兼容项（建议切换）";
      if (exec === "gemini") return "gemini · 旧版兼容项（建议切换至 agy）";
      const base = SEAT_LABELS[exec] || exec;
      if (statusMap && Object.prototype.hasOwnProperty.call(statusMap, exec) && statusMap[exec] === false) {
        return base + "（未检测到命令）";
      }
      return base;
    }

    function buildExecOptions(curExec, statusMap, emptyLabel) {
      const opts = [];
      if (emptyLabel) opts.push({ value: "", label: emptyLabel });
      for (const exec of STAGE_SEATS) {
        opts.push({ value: exec, label: seatOptionLabel(exec, statusMap) });
      }
      if (curExec && curExec !== "subagent" && !STAGE_SEATS.includes(curExec)) {
        opts.push({ value: curExec, label: seatOptionLabel(curExec, statusMap) });
      }
      return opts;
    }

    let EXTRA_MODELS = null;
    function readModelDirectories(ctx) {
      if (EXTRA_MODELS !== null && Object.keys(EXTRA_MODELS).length > 0) return EXTRA_MODELS;
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

    function catalogOf(value) {
      const raw = String((value && value.executorCatalog) || "");
      return raw.split(";").map((row) => {
        const i = row.indexOf(":");
        if (i < 0) return null;
        const exec = row.slice(0, i).trim();
        const models = row.slice(i + 1).split("|").map((x) => x.trim()).filter(Boolean);
        return exec ? { exec, models } : null;
      }).filter(Boolean);
    }

    function mergeCatalog(base, extra) {
      if (!extra) return base;
      const byExec = new Map(base.map((c) => [c.exec, { exec: c.exec, models: c.models.slice() }]));
      for (const [exec, models] of Object.entries(extra)) {
        const row = byExec.get(exec);
        if (!row) { byExec.set(exec, { exec: exec, models: models.slice() }); continue; }
        for (const m of models) if (!row.models.includes(m)) row.models.push(m);
      }
      return [...byExec.values()];
    }

    function mergeCatalogRows(primary, fallback) {
      const byExec = new Map();
      for (const row of primary || []) {
        if (!row || !row.exec) continue;
        byExec.set(row.exec, { exec: row.exec, models: (row.models || []).slice() });
      }
      for (const row of fallback || []) {
        if (!row || !row.exec) continue;
        const cur = byExec.get(row.exec);
        if (!cur) {
          byExec.set(row.exec, { exec: row.exec, models: (row.models || []).slice() });
          continue;
        }
        for (const m of row.models || []) {
          if (m && !cur.models.includes(m)) cur.models.push(m);
        }
      }
      return [...byExec.values()];
    }

    // ── 实时执行者探测桥与 /swarm 拓扑快照存储（兼容 DSH Electron connection.rpc 与 HTTP fetch）──
    let CONNECTION = null;
    let CONN_SEQ = 0;
    let BRIDGE_SNAPSHOT = null;
    let SWARM_SNAPSHOT = null;
    let SWARM_ROUTE_MISSING = false;
    let SWARM_LAST_ERROR = "";
    const bridgeWatchers = new Set();

    function notifyBridgeWatchers() {
      for (const fn of bridgeWatchers) {
        try { fn(); } catch { /* 单个订阅者异常不影响其余监听器 */ }
      }
    }

    function setConnection(conn) {
      CONNECTION = conn || null;
      CONN_SEQ += 1;
      if (CONNECTION) SWARM_LAST_ERROR = "";
      notifyBridgeWatchers();
    }

    function isRouteMissingError(msg) {
      return /\bHTTP\s*404\b|\bstatus(?:\s*code)?\s*[:=]?\s*404\b|404\s+not\s+found|^not found$|unknown endpoint/i.test(String(msg || ""));
    }

    function setBridgeSnapshot(snap) {
      BRIDGE_SNAPSHOT = snap && typeof snap === "object"
        ? {
          catalog: String(snap.catalog || ""),
          status: String(snap.status || ""),
          version: String(snap.version || ""),
          defaultRepoRoot: String(snap.defaultRepoRoot || ""),
          repoRoot: String(snap.repoRoot || ""),
          workspaces: Array.isArray(snap.workspaces) ? snap.workspaces.slice() : [],
          projectLineup: snap.projectLineup && typeof snap.projectLineup === "object" ? snap.projectLineup : null,
        }
        : null;
      notifyBridgeWatchers();
    }

    function setSwarmSnapshot(snap) {
      SWARM_SNAPSHOT = snap && typeof snap === "object" ? snap : null;
      if (snap) {
        SWARM_ROUTE_MISSING = false;
        SWARM_LAST_ERROR = "";
      }
      notifyBridgeWatchers();
    }

    const NATIVE_FETCH = typeof fetch === "function" ? fetch : null;
    function resolveRpcCaller(customFetch) {
      if (typeof customFetch === "function") return null;
      if (customFetch && typeof customFetch === "object" && typeof customFetch.call === "function") {
        return customFetch;
      }
      if (CONNECTION && CONNECTION.rpc && typeof CONNECTION.rpc.call === "function") {
        return CONNECTION.rpc;
      }
      if (
        typeof globalThis !== "undefined"
        && globalThis.__DSH_TRANSPORT__
        && globalThis.__DSH_TRANSPORT__.rpc
        && typeof globalThis.__DSH_TRANSPORT__.rpc.call === "function"
      ) {
        return globalThis.__DSH_TRANSPORT__.rpc;
      }
      return null;
    }

    function resolveFetchFn(customFetch) {
      if (typeof customFetch === "function") return customFetch;
      if (typeof fetch === "function" && fetch !== NATIVE_FETCH) return fetch;
      if (CONNECTION && typeof CONNECTION.fetch === "function") {
        return (p, init) => CONNECTION.fetch(p, init);
      }
      if (
        typeof globalThis !== "undefined"
        && globalThis.__DSH_TRANSPORT__
        && typeof globalThis.__DSH_TRANSPORT__.fetch === "function"
      ) {
        return (p, init) => globalThis.__DSH_TRANSPORT__.fetch(new URL(p, "http://dsh.internal"), init);
      }
      if (
        typeof fetch === "function"
        && typeof window !== "undefined"
        && window.location
        && /^https?:$/i.test(String(window.location.protocol || ""))
      ) {
        return fetch;
      }
      return null;
    }

    async function fetchBridgeSnapshot(customFetch, opts) {
      const bodyObj = typeof opts === "string"
        ? { repoRoot: opts }
        : (opts && typeof opts === "object" ? opts : {});
      const rpc = resolveRpcCaller(customFetch);
      if (rpc) {
        try {
          const res = await rpc.call(RPC_CHANNEL, RPC_EXEC_METHOD, bodyObj);
          if (res && res.ok && res.value && typeof res.value === "object") {
            setBridgeSnapshot(res.value);
            try {
              diag.bridgeVersion = String(res.value.version || "");
              diag.bridgeVia = "connection.rpc";
            } catch { /* 忽略 */ }
            return res.value;
          }
          if (res && res.ok === false && res.error) {
            const errMsg = String(res.error.message || res.error.code || "");
            try { diag.bridgeError = errMsg; } catch { /* 忽略 */ }
            if (isRouteMissingError(errMsg)) {
              SWARM_ROUTE_MISSING = true;
              notifyBridgeWatchers();
            }
          }
        } catch (e) {
          const msg = String((e && e.message) || e);
          try { diag.bridgeError = msg; } catch { /* 忽略 */ }
          if (isRouteMissingError(msg)) {
            SWARM_ROUTE_MISSING = true;
            notifyBridgeWatchers();
          }
        }
        return null;
      }
      const fn = resolveFetchFn(customFetch);
      if (!fn) return null;
      try {
        const resp = await fn(BRIDGE_EXEC_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyObj),
        });
        if (!resp || !resp.ok) return null;
        const data = await resp.json();
        if (data && data.ok && data.value && typeof data.value === "object") {
          setBridgeSnapshot(data.value);
          try {
            diag.bridgeVersion = String(data.value.version || "");
            diag.bridgeVia = "fetch";
          } catch { /* 忽略 */ }
          return data.value;
        }
      } catch (e) {
        try { diag.bridgeError = String((e && e.message) || e); } catch { /* 忽略 */ }
      }
      return null;
    }

    async function fetchSwarmSnapshot(params, customFetch) {
      const bodyObj = params && typeof params === "object" ? params : {};
      const rpc = resolveRpcCaller(customFetch);
      if (rpc) {
        try {
          const res = await rpc.call(RPC_CHANNEL, RPC_SWARM_METHOD, bodyObj);
          if (res && res.ok && res.value && typeof res.value === "object") {
            setSwarmSnapshot(res.value);
            try { diag.swarmVia = "connection.rpc"; } catch { /* 忽略 */ }
            return res.value;
          }
          const errMsg = String((res && res.error && res.error.message) || "实时拓扑接口返回异常");
          try { diag.swarmError = errMsg; } catch { /* 忽略 */ }
          if (isRouteMissingError(errMsg)) {
            SWARM_ROUTE_MISSING = true;
            SWARM_LAST_ERROR = "";
          } else {
            SWARM_LAST_ERROR = errMsg;
          }
          notifyBridgeWatchers();
        } catch (e) {
          const msg = String((e && e.message) || e);
          try { diag.swarmError = msg; } catch { /* 忽略 */ }
          if (isRouteMissingError(msg)) {
            SWARM_ROUTE_MISSING = true;
            SWARM_LAST_ERROR = "";
          } else {
            SWARM_LAST_ERROR = msg;
          }
          notifyBridgeWatchers();
        }
        return null;
      }
      const fn = resolveFetchFn(customFetch);
      if (!fn) {
        SWARM_LAST_ERROR = "暂未就绪宿主实时通道，请点击右上角「刷新拓扑」重试或从系统托盘重启应用。";
        notifyBridgeWatchers();
        return null;
      }
      try {
        const resp = await fn(BRIDGE_SWARM_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(bodyObj),
        });
        if (!resp) {
          SWARM_LAST_ERROR = "未收到宿主拓扑响应";
          notifyBridgeWatchers();
          return null;
        }
        if (resp.status === 404) {
          SWARM_ROUTE_MISSING = true;
          SWARM_LAST_ERROR = "";
          notifyBridgeWatchers();
          return null;
        }
        if (!resp.ok) {
          SWARM_LAST_ERROR = "拓扑接口响应异常 (HTTP " + resp.status + ")";
          notifyBridgeWatchers();
          return null;
        }
        const data = await resp.json();
        if (data && data.ok && data.value && typeof data.value === "object") {
          setSwarmSnapshot(data.value);
          try { diag.swarmVia = "fetch"; } catch { /* 忽略 */ }
          return data.value;
        }
        SWARM_LAST_ERROR = String((data && data.error) || "拓扑数据格式不完整");
        notifyBridgeWatchers();
      } catch (e) {
        const msg = String((e && e.message) || e);
        try { diag.swarmError = msg; } catch { /* 忽略 */ }
        SWARM_LAST_ERROR = msg;
        notifyBridgeWatchers();
      }
      return null;
    }

    async function postDispatchAction(payload, customFetch) {
      const bodyObj = payload && typeof payload === "object" ? payload : {};
      const rpc = resolveRpcCaller(customFetch);
      if (rpc) {
        let res;
        try {
          res = await rpc.call(RPC_CHANNEL, RPC_ACTION_METHOD, bodyObj);
        } catch (e) {
          const msg = String((e && e.message) || e);
          if (isRouteMissingError(msg)) {
            SWARM_ROUTE_MISSING = true;
            notifyBridgeWatchers();
            throw new Error("后台驻留旧版进程，请先从系统托盘退出 DeepSeek Harness 后重开");
          }
          throw new Error(msg);
        }
        if (res && res.ok) {
          const val = (res.value && typeof res.value === "object") ? res.value : {};
          const snap = (val.snapshot && typeof val.snapshot === "object") ? val.snapshot : null;
          if (snap) setSwarmSnapshot(snap);
          return { ok: true, value: val, snapshot: snap };
        }
        const errSnap = res && res.error && res.error.details && res.error.details.snapshot;
        if (errSnap && typeof errSnap === "object") setSwarmSnapshot(errSnap);
        const errMsg = String((res && res.error && res.error.message) || "操作执行失败");
        if (isRouteMissingError(errMsg)) {
          SWARM_ROUTE_MISSING = true;
          notifyBridgeWatchers();
          throw new Error("后台驻留旧版进程，请先从系统托盘退出 DeepSeek Harness 后重开");
        }
        throw new Error(errMsg);
      }
      const fn = resolveFetchFn(customFetch);
      if (!fn) throw new Error("本地桥接通道未就绪");
      const resp = await fn(BRIDGE_ACTION_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bodyObj),
      });
      if (!resp) throw new Error("未收到后台响应");
      if (resp.status === 404) {
        SWARM_ROUTE_MISSING = true;
        notifyBridgeWatchers();
        throw new Error("后台驻留旧版进程，请先从系统托盘退出 DeepSeek Harness 后重开");
      }
      const data = await resp.json();
      if (data && data.snapshot) setSwarmSnapshot(data.snapshot);
      if (!resp.ok || !data || !data.ok) {
        throw new Error((data && data.error) || ("操作失败 (" + resp.status + ")"));
      }
      return data;
    }

    function isBackendOutdated(desc) {
      if (SWARM_ROUTE_MISSING) return true;
      if (BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.version) {
        if (/^2\.[01]\./.test(BRIDGE_SNAPSHOT.version)) return true;
        return !(BRIDGE_SNAPSHOT.catalog || "").split(";").some((r) => r.trim().startsWith("agy:"));
      }
      const props = propsFromSchema(desc && desc.schema);
      if (!props) return false;
      if (
        !Object.prototype.hasOwnProperty.call(props, "executorStatus")
        || !Object.prototype.hasOwnProperty.call(props, "scoutCommand")
        || !Object.prototype.hasOwnProperty.call(props, "noveltyCommand")
      ) {
        return true;
      }
      const defCat = props.executorCatalog && typeof props.executorCatalog.default === "string"
        ? props.executorCatalog.default
        : "";
      return Boolean(defCat && !defCat.split(";").some((r) => r.trim().startsWith("agy:")));
    }

    function effectiveStatusOf(value, schemaProps) {
      const schemaDefault = schemaProps
        && schemaProps.executorStatus
        && typeof schemaProps.executorStatus.default === "string"
        ? schemaProps.executorStatus.default
        : "";
      const fromSchema = statusOf({ executorStatus: schemaDefault });
      const fromValue = statusOf(value);
      const fromBridge = BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.status
        ? statusOf({ executorStatus: BRIDGE_SNAPSHOT.status })
        : {};
      return { ...fromSchema, ...fromValue, ...fromBridge };
    }

    let LIVE_GROUPS = null;
    let LIVE_CATALOG = null;

    function groupsToCatalog(groups) {
      const ids = [];
      for (const g of groups || []) {
        const prov = String((g && (g.id || g.name)) || "").trim();
        const ms = (g && Array.isArray(g.models)) ? g.models : [];
        for (const m of ms) {
          const mid = String((m && (m.id || m.name)) || "").trim();
          if (!prov || !mid) continue;
          const full = mid.indexOf(prov + "/") === 0 ? mid : (prov + "/" + mid);
          if (!ids.includes(full)) ids.push(full);
        }
      }
      return ids;
    }

    function setLiveGroups(groups) {
      LIVE_GROUPS = groups;
      const ids = groupsToCatalog(groups);
      LIVE_CATALOG = ids.length ? { dsh: ids.slice() } : null;
      notifyWatchers();
    }

    function panelCatalog(value, ctx, schemaProps) {
      const schemaDefault = schemaProps
        && schemaProps.executorCatalog
        && typeof schemaProps.executorCatalog.default === "string"
        ? schemaProps.executorCatalog.default
        : "";
      const bridgeRows = BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.catalog
        ? catalogOf({ executorCatalog: BRIDGE_SNAPSHOT.catalog })
        : [];
      const valueRows = catalogOf(value);
      const schemaRows = schemaDefault ? catalogOf({ executorCatalog: schemaDefault }) : [];
      const layeredRows = mergeCatalogRows(bridgeRows, mergeCatalogRows(valueRows, schemaRows));
      const base = mergeCatalog(layeredRows, readModelDirectories(ctx))
        .filter((c) => c.exec !== "subagent" && c.exec !== "api");
      if (!LIVE_CATALOG) return base;
      const out = base.filter((c) => !Object.prototype.hasOwnProperty.call(LIVE_CATALOG, c.exec));
      for (const [exec, models] of Object.entries(LIVE_CATALOG)) {
        if (models.length) out.push({ exec, models: models.slice() });
      }
      return out;
    }

    function parseVoteRows(raw) {
      const text = String(raw || "").trim();
      if (!text) return [];
      return text.split(",").map((t) => t.trim()).filter(Boolean).map((t) => {
        const i = t.indexOf(":");
        return i < 0 ? { executor: t, model: "" } : { executor: t.slice(0, i).trim(), model: t.slice(i + 1).trim() };
      }).filter((r) => Boolean(r.executor));
    }

    function voteRows(value) {
      return parseVoteRows(value && value.reviewVotes);
    }

    function voteString(rows) {
      if (!rows || rows.length === 0) return "";
      return rows.map((r) => r.executor + ":" + (r.model || "")).join(",");
    }

    function groupedModels(exec, cat) {
      if (!exec) return [{ label: "", items: [] }];
      const flat = (cat.find((c) => c.exec === exec) || { models: [] }).models;
      if (LIVE_GROUPS && exec === "dsh") {
        const out = [];
        for (const g of LIVE_GROUPS) {
          const prov = String((g && (g.id || g.name)) || "").trim();
          const label = String((g && g.name) || prov).trim();
          const ms = (g && Array.isArray(g.models)) ? g.models : [];
          const items = ms.map((m) => {
            const rawId = String((m && (m.id || m.name)) || "").trim();
            const fullVal = rawId.indexOf(prov + "/") === 0 ? rawId : (prov + "/" + rawId);
            return {
              value: rawId ? fullVal : "",
              label: String((m && m.name) || rawId || "").trim(),
            };
          }).filter((x) => x.value && x.label && x.label !== "undefined");
          if (prov && items.length) out.push({ label, items });
        }
        if (out.length) return out;
      }
      return [{ label: "", items: flat.map((m) => ({ value: m, label: m })) }];
    }

    function defaultModelLabel(exec, cat, fallback) {
      if (!exec) return fallback;
      for (const g of groupedModels(exec, cat)) {
        for (const it of g.items) {
          if (/kimi-k3/i.test(it.label)) return fallback;
          return "默认（" + it.label + "）";
        }
      }
      return fallback;
    }

    function flattenGroups(groups) {
      const items = [];
      for (const g of groups || []) {
        for (const it of (g && g.items) || []) items.push(it);
      }
      return items;
    }

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

    function filteredGroups(groups, q) {
      if (!String(q || "").trim()) return groups;
      const out = [];
      for (const g of groups || []) {
        const items = (g.items || []).filter((it) => modelMatch(it, q));
        if (items.length) out.push({ label: g.label, items });
      }
      return out;
    }

    const DEFAULT_MODEL_OPTION = {
      value: "",
      label: "默认（使用该工具自身默认模型）",
      isDefault: true,
    };

    function buildMenuView(groups, q) {
      const rawQ = String(q || "").trim();
      const allPreset = flattenGroups(groups);
      if (!rawQ) {
        const sections = [{ label: "", items: [DEFAULT_MODEL_OPTION] }];
        for (const g of groups || []) {
          if (g && Array.isArray(g.items) && g.items.length > 0) {
            sections.push({ label: g.label || "", items: g.items });
          }
        }
        return {
          sections,
          items: flattenGroups(sections),
          rawQ: "",
          presetCount: allPreset.length,
        };
      }
      const sections = filteredGroups(groups, rawQ).slice();
      const exactExists = allPreset.some((it) => it.value === rawQ);
      if (!exactExists) {
        sections.push({
          label: "",
          items: [{ value: rawQ, label: "使用自定义模型：" + rawQ, isCustom: true }],
        });
      }
      return {
        sections,
        items: flattenGroups(sections),
        rawQ,
        presetCount: allPreset.length,
      };
    }

    function menuProps(state, key, groups, value, onPick) {
      const { menu, setMenu } = state;
      const open = menu.key === key;
      const q = open ? String(menu.q || "") : "";
      const curVal = String(value === undefined || value === null ? "" : value);
      const items = buildMenuView(groups, q).items;
      const idxOf = (v) => {
        for (let i = 0; i < items.length; i++) if (items[i].value === v) return i;
        return -1;
      };
      const hi0 = Math.max(0, idxOf(curVal));
      return {
        open,
        q,
        showSearch: true,
        hi: open ? Math.min(Math.max(0, menu.hi || 0), Math.max(0, items.length - 1)) : hi0,
        onOpen: () => setMenu({ key, hi: hi0, q: "" }),
        onClose: () => setMenu({ key: null, hi: 0, q: "" }),
        onHover: (i) => setMenu({ key, hi: i, q }),
        onQuery: (v) => {
          const next = buildMenuView(groups, v).items;
          const at = curVal ? next.findIndex((it) => it.value === curVal) : -1;
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
      const { value, groups, disabled, placeholder, open, hi, q, onOpen, onClose, onMove, onHover, onPick, onQuery } = props;
      const curVal = String(value === undefined || value === null ? "" : value);
      const all = flattenGroups(groups);
      const cur = all.filter((x) => x.value === curVal)[0];
      const label = cur ? cur.label : (curVal || placeholder);
      const built = buildMenuView(groups, q);
      const view = built.sections;
      const items = built.items;
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
        rows.push(h("input", {
          key: "__q__",
          className: "rdp-menu-search",
          type: "text",
          value: q === undefined ? "" : q,
          placeholder: "搜索已探测模型，或直接输入新模型名回车…",
          autoFocus: true,
          onChange: (e) => onQuery(e.target.value),
          onKeyDown: navKey,
        }));
        view.forEach((g, gi) => {
          rows.push(h("div", { className: "rdp-menu-sec", key: "sec:" + gi },
            g.label ? h("div", { className: "rdp-menu-cap" }, g.label) : null,
            g.items.map((it) => {
              const idx = items.indexOf(it);
              const sel = it.value === curVal && !it.isCustom;
              return h("button", {
                type: "button",
                key: (it.isDefault ? "__default__" : (it.isCustom ? "__custom__:" : "m:")) + it.value,
                className: "rdp-menu-item" + (idx === hi ? " is-hi" : "") + (sel ? " is-sel" : ""),
                role: "option",
                "aria-selected": sel ? "true" : "false",
                title: it.value || "使用工具自身默认模型",
                onMouseEnter: () => onHover(idx),
                onClick: () => onPick(it.value),
              },
                h("span", { className: "rdp-menu-name" }, it.label),
                sel ? h("span", { className: "rdp-menu-tick", "aria-hidden": "true" }, "✓") : null);
            })));
        });
        if (!built.rawQ && built.presetCount === 0) {
          rows.push(h("div", { key: "__empty_hint__", className: "rdp-menu-empty" },
            "暂未探测到本地预设模型，可直接在上方输入框键入任意模型名回车选用"));
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

    function pickerNode(state, key, exec, cat, value, disabled, placeholder, onPick) {
      const groups = groupedModels(exec, cat);
      return ModelPicker(Object.assign(
        { value, groups, disabled, placeholder },
        menuProps(state, key, groups, value, onPick),
      ));
    }

    // ── SVG 拓扑辅助函数与专属矢量图标 ────────────────────────────────────
    const NODE_W = 192;
    const NODE_H = 62;

    function cubicEdgePath(fromNode, toNode) {
      if (!fromNode || !toNode) return "";
      const x1 = Number(fromNode.x || 0) + NODE_W / 2 - 4;
      const y1 = Number(fromNode.y || 0);
      const x2 = Number(toNode.x || 0) - NODE_W / 2 + 4;
      const y2 = Number(toNode.y || 0);
      const dx = Math.max(48, Math.abs(x2 - x1) * 0.48);
      return "M " + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2;
    }

    function nodeAccentColor(node) {
      if (!node) return "#64748b";
      if (node.status === "working") return "#06b6d4";
      if (node.status === "failed") return "#ef4444";
      if (node.seat && SEAT_COLORS[node.seat]) return SEAT_COLORS[node.seat];
      if (node.kind === "hub") return "#6366f1";
      if (node.kind === "gate") return node.status === "done" ? "#10b981" : "#f59e0b";
      if (node.kind === "artifact") return "#0ea5e9";
      return "#64748b";
    }

    function truncSvgText(str, maxLen) {
      const s = String(str || "").trim();
      if (s.length <= maxLen) return s;
      return s.slice(0, Math.max(1, maxLen - 1)) + "…";
    }

    function formatElapsed(startedAt, durationMs) {
      if (Number.isFinite(durationMs) && durationMs > 0) {
        const sec = Math.max(1, Math.round(durationMs / 1000));
        return sec >= 60 ? (Math.floor(sec / 60) + "m" + (sec % 60) + "s") : (sec + "s");
      }
      if (startedAt && Number(startedAt) > 0) {
        const sec = Math.max(1, Math.floor((Date.now() - Number(startedAt)) / 1000));
        return sec >= 60 ? (Math.floor(sec / 60) + "m" + (sec % 60) + "s") : (sec + "s");
      }
      return "";
    }

    function SettingsNavIcon() {
      return h("svg", {
        width: 16,
        height: 16,
        viewBox: "0 0 16 16",
        fill: "none",
        "aria-hidden": "true",
        style: { display: "block", flex: "0 0 auto" },
      },
        h("circle", { cx: 3.2, cy: 8, r: 1.8, stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: 8.2, cy: 3.5, r: 1.7, stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: 8.2, cy: 12.5, r: 1.7, stroke: "currentColor", strokeWidth: 1.4 }),
        h("circle", { cx: 13, cy: 8, r: 1.9, stroke: "currentColor", strokeWidth: 1.4 }),
        h("path", { d: "M4.8 7.1L6.7 4.5M4.8 8.9L6.7 11.5M9.8 4.5L11.5 7M9.8 11.5L11.5 9", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
      );
    }

    // ── /swarm 科研拓扑星图工作台组件（Settings 与会话视图双栖复用）────────
    function SwarmStudio(props) {
      const embedded = Boolean(props.embedded);
      const propRoot = String(props.repoRoot || "").trim();
      const [overrideRoot, setOverrideRoot] = React.useState("");
      const [topic, setTopic] = React.useState("");
      const [focusStage, setFocusStage] = React.useState("");
      const [focusIdeaId, setFocusIdeaId] = React.useState("");
      const [selectedNodeId, setSelectedNodeId] = React.useState("");
      const [verdictChoice, setVerdictChoice] = React.useState("go");
      const [verdictNote, setVerdictNote] = React.useState("");
      const [appendDeadEnd, setAppendDeadEnd] = React.useState(false);
      const [deadEndSummary, setDeadEndSummary] = React.useState("");
      const [busyMsg, setBusyMsg] = React.useState("");
      const [actionFeedback, setActionFeedback] = React.useState(null);
      const [, setSnapSeq] = React.useState(0);

      const effectiveReqRoot = overrideRoot || (!isDshProfilePath(propRoot) ? propRoot : "");

      const loadSnapshot = () => {
        fetchSwarmSnapshot({
          repoRoot: effectiveReqRoot,
          topic,
          focusStage,
          focusIdeaId,
        });
      };

      React.useEffect(() => {
        let alive = true;
        const onSnap = () => { if (alive) setSnapSeq((n) => n + 1); };
        bridgeWatchers.add(onSnap);
        loadSnapshot();
        const intervalMs = SWARM_SNAPSHOT && SWARM_SNAPSHOT.activeWorkerCount > 0 ? 1500 : 5000;
        const iv = setInterval(() => {
          if (!alive) return;
          loadSnapshot();
        }, intervalMs);
        return () => {
          alive = false;
          clearInterval(iv);
          bridgeWatchers.delete(onSnap);
        };
      }, [effectiveReqRoot, topic, focusStage, focusIdeaId, CONN_SEQ, SWARM_SNAPSHOT && SWARM_SNAPSHOT.activeWorkerCount]);

      const snap = SWARM_SNAPSHOT;
      const stages = (snap && Array.isArray(snap.stages)) ? snap.stages : [];
      const ideas = (snap && Array.isArray(snap.ideas)) ? snap.ideas : [];
      const topics = (snap && Array.isArray(snap.topics)) ? snap.topics : [];
      const workspaces = (snap && Array.isArray(snap.workspaces) && snap.workspaces.length > 0)
        ? snap.workspaces
        : ((BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.workspaces) || []);
      const graph = (snap && snap.graph) || { focusStage: "S4", focusIdeaId: "", nodes: [], edges: [] };
      const nodeList = Array.isArray(graph.nodes) ? graph.nodes : [];
      const edgeList = Array.isArray(graph.edges) ? graph.edges : [];
      const nodeById = new Map(nodeList.map((n) => [n.id, n]));

      const selectedNode = (selectedNodeId && nodeById.get(selectedNodeId))
        || nodeList.find((n) => n.kind === "gate")
        || nodeList.find((n) => n.kind === "worker")
        || nodeList[0]
        || null;
      const inspect = (selectedNode && selectedNode.inspect) || null;
      const curStage = graph.focusStage || focusStage || "S4";
      const curIdeaId = graph.focusIdeaId || focusIdeaId || (ideas[0] ? ideas[0].ideaId : "");
      const activeWorkers = Number((snap && snap.activeWorkerCount) || 0);

      const runAction = (payload, label) => {
        setBusyMsg(label || "正在执行…");
        setActionFeedback(null);
        postDispatchAction(Object.assign({
          repoRoot: (snap && snap.repoRoot) || effectiveReqRoot,
          topic: (snap && snap.activeTopic) || topic || "default",
          focusStage: curStage,
          focusIdeaId: curIdeaId,
        }, payload))
          .then((res) => {
            setBusyMsg("");
            const msg = (res && res.value && res.value.verdictRel)
              ? ("已写入裁决：" + res.value.verdictRel)
              : (res && res.value && (res.value.mode === "async" || res.value.async))
                ? ("已在后台沙箱启动派工（PID " + (res.value.pid || "active") + "）")
                : ((res && res.value && res.value.message) || "操作已完成并刷新盘面");
            setActionFeedback({ ok: true, text: msg });
          })
          .catch((err) => {
            setBusyMsg("");
            setActionFeedback({ ok: false, text: String((err && err.message) || err) });
          });
      };

      const actionLabels = {
        init: "初始化课题骨架",
        pool: "汇总文献池",
        summary: "重算降序榜单",
        "run-brief": "启动多票盲审",
        "run-novelty": "发起前置查重",
      };

      return h("div", { className: "rdp-swarm-shell" + (embedded ? " is-embedded" : "") },
        (!embedded && SWARM_ROUTE_MISSING) ? h("div", { className: "rdp-state rdp-warn", key: "swarm-route-warn" },
          "检测到后台仍驻留旧版进程，暂未开放实时拓扑通道。请右键右下角系统托盘中的 DeepSeek Harness 图标选择「退出」后重新打开。") : null,

        // ── 顶部工作区、课题与实时活性状态栏 ──────────────────────────────
        h("div", { className: "rdp-swarm-bar", key: "bar" },
          h("div", { className: "rdp-swarm-bar-l" },
            h("span", { className: "rdp-step-pill rdp-step-ws" }, "WORKSPACE"),
            h("code", null, (snap && snap.repoName) || (effectiveReqRoot ? effectiveReqRoot.split(/[\\/]/).pop() : "正在探测科研工作区…")),
            topics.map((tp) => {
              const tpId = tp.id || tp.slug || "default";
              const active = (snap ? snap.activeTopic : topic) === tpId;
              return h("button", {
                type: "button",
                key: "tp:" + tpId,
                className: "rdp-topic-pill" + (active ? " is-active" : ""),
                onClick: () => { setTopic(tpId); setFocusIdeaId(""); setSelectedNodeId(""); },
              }, tp.label + " (" + tp.briefCount + ")");
            })),
          h("div", { className: "rdp-swarm-bar-r" },
            h("span", { className: "rdp-hdr-pill" + (activeWorkers > 0 ? " is-working" : ""), style: { cursor: "default" } },
              h("span", { className: "rdp-tab-dot" + (activeWorkers > 0 ? " is-working" : "") }),
              activeWorkers > 0 ? (activeWorkers + " 个沙箱 Worker 运行中") : "沙箱空闲就绪"),
            snap && snap.initialized === false ? h("button", {
              type: "button",
              className: "rdp-btn rdp-btn-sm rdp-primary",
              disabled: !!busyMsg,
              onClick: () => runAction({ kind: "init" }, "初始化骨架…"),
            }, "初始化课题骨架") : null,
            h("button", {
              type: "button",
              className: "rdp-btn rdp-btn-sm",
              onClick: loadSnapshot,
            }, "刷新拓扑"))),

        // 若当前工作区非科研项目且存在已发现科研项目，给出 1-Click 工作区快切胶囊
        workspaces.some((w) => w.isResearch) && snap && snap.initialized === false
          ? h("div", { className: "rdp-ws-strip", key: "ws-quick" },
            h("span", { className: "rdp-ws-cap" }, "切换至科研工作区："),
            workspaces.filter((w) => w.isResearch).slice(0, 6).map((ws) => {
              const wsDir = ws.dir || ws.path;
              return h("button", {
                type: "button",
                key: "sws:" + wsDir,
                className: "rdp-ws-pill" + (snap.repoRoot === wsDir ? " is-active" : ""),
                onClick: () => {
                  setOverrideRoot(wsDir);
                  if (typeof props.onSelectRepoRoot === "function") props.onSelectRepoRoot(wsDir);
                },
              }, h("span", { className: "rdp-ws-star" }, "✦"), ws.name);
            }))
          : null,

        // ── S0 → S6 八阶段全链路进度轨 ───────────────────────────────────
        stages.length > 0 ? h("div", { className: "rdp-rail", key: "rail", role: "tablist", "aria-label": "科研闭环阶段轨" },
          stages.map((stg) => {
            const isSel = curStage === stg.id;
            return h("button", {
              type: "button",
              key: stg.id,
              role: "tab",
              "aria-selected": isSel ? "true" : "false",
              className: "rdp-stage-card" + (isSel ? " is-active" : ""),
              onClick: () => { setFocusStage(stg.id); setSelectedNodeId(""); },
            },
              h("div", { className: "rdp-stage-top" },
                h("span", { className: "rdp-stage-id" }, stg.code || stg.id),
                h("span", { className: "rdp-stage-dot st-" + (stg.status || "ready") })),
              h("span", { className: "rdp-stage-name" }, stg.title || stg.label),
              h("span", { className: "rdp-stage-cnt" }, stg.badge || stg.countText || "就绪"));
          })) : null,

        // ── 候选工单降序快捷切换条（按五维 /25 Ranking 排列）──────────────
        ideas.length > 0 && (curStage === "S3" || curStage === "S4" || curStage === "S4.5" || curStage === "S5")
          ? h("div", { className: "rdp-ideas-strip", key: "ideas-strip" },
            ideas.map((it) => {
              const isCur = curIdeaId === it.ideaId;
              const dec = it.humanDecision || (it.verdict && it.verdict !== "pending" ? it.verdict : "");
              const vTag = dec
                ? { cls: "rdp-vtag-" + dec, text: dec }
                : (it.voteCount > 0 ? { cls: "rdp-vtag-pending", text: "待拍板" } : null);
              const scoreLabel = it.meanScore25 !== null && it.meanScore25 !== undefined
                ? (" · " + Number(it.meanScore25).toFixed(1) + "/25")
                : "";
              return h("button", {
                type: "button",
                key: it.ideaId,
                className: "rdp-idea-chip" + (isCur ? " is-active" : ""),
                onClick: () => { setFocusIdeaId(it.ideaId); setSelectedNodeId(""); },
              },
                it.rank ? ("#" + it.rank + " ") : "",
                it.ideaId,
                scoreLabel,
                vTag ? h("span", { className: "rdp-vtag " + vTag.cls }, vTag.text) : null);
            }))
          : null,

        // ── 主体分栏：左侧交互式 SVG /swarm 拓扑画布 + 右侧检查器与人类拍板台 ──
        h("div", { className: "rdp-swarm-body", key: "body" },
          h("div", { className: "rdp-canvas-card" },
            nodeList.length === 0
              ? h("div", {
                className: "rdp-state" + ((!snap && (SWARM_ROUTE_MISSING || SWARM_LAST_ERROR)) ? " rdp-warn" : ""),
                style: { margin: 20 },
              },
                snap
                  ? "当前阶段暂无拓扑节点，请点击上方阶段轨或先初始化课题骨架。"
                  : SWARM_ROUTE_MISSING
                    ? "后台仍驻留旧版进程，请右键右下角系统托盘中的 DeepSeek Harness 图标选择「退出」后重新打开。"
                    : SWARM_LAST_ERROR
                      ? ("实时拓扑同步未成功：" + SWARM_LAST_ERROR + "（可点击右上角「刷新拓扑」重试）")
                      : "正在同步实时科研拓扑盘面…")
              : h("svg", {
                className: "rdp-svg",
                viewBox: "0 0 980 520",
                role: "img",
                "aria-label": "科研派工 Swarm 关系与进度拓扑星图",
              },
                // 顶部分列导引标题
                [
                  { x: 118, t: "① 推式输入源（零污染）" },
                  { x: 342, t: "② 主控派工与门禁" },
                  { x: 590, t: "③ 独立沙箱 Workers" },
                  { x: 848, t: "④ 榜单与人类唯一裁决" },
                ].map((col, ci) => h("text", {
                  key: "colhdr:" + ci,
                  x: col.x,
                  y: 28,
                  textAnchor: "middle",
                  fontSize: 11,
                  fontWeight: 600,
                  fill: "var(--dsw-alias-label-tertiary,#64748b)",
                }, col.t)),

                // 三次贝塞尔平滑连线
                edgeList.map((ed) => {
                  const fn = nodeById.get(ed.from);
                  const tn = nodeById.get(ed.to);
                  const d = cubicEdgePath(fn, tn);
                  if (!d) return null;
                  return h("path", {
                    key: ed.id,
                    d,
                    className: "rdp-edge st-" + (ed.status || "ready"),
                  });
                }),

                // 节点卡片群
                nodeList.map((nd) => {
                  const nx = Number(nd.x || 0) - NODE_W / 2;
                  const ny = Number(nd.y || 0) - NODE_H / 2;
                  const accent = nodeAccentColor(nd);
                  const isSel = selectedNode && selectedNode.id === nd.id;
                  const elapsed = nd.status === "working"
                    ? formatElapsed(nd.startedAt, null)
                    : formatElapsed(null, nd.durationMs);
                  const badgeText = truncSvgText(elapsed ? (nd.badge + " · " + elapsed) : (nd.badge || ""), 16);

                  return h("g", {
                    key: nd.id,
                    transform: "translate(" + nx + "," + ny + ")",
                    className: "rdp-gnode" + (isSel ? " is-selected" : ""),
                    onClick: () => setSelectedNodeId(nd.id),
                  },
                    h("rect", {
                      className: "rdp-gnode-box",
                      x: 0,
                      y: 0,
                      width: NODE_W,
                      height: NODE_H,
                      rx: 12,
                      ry: 12,
                    }),
                    h("rect", {
                      x: 0,
                      y: 10,
                      width: 4.5,
                      height: NODE_H - 20,
                      rx: 2.2,
                      fill: accent,
                    }),
                    h("circle", {
                      cx: 16,
                      cy: 21,
                      r: 4,
                      fill: accent,
                    }),
                    h("text", {
                      x: 26,
                      y: 25,
                      fontSize: 12,
                      fontWeight: 650,
                      fill: "var(--dsw-alias-label-primary,#0f172a)",
                    }, truncSvgText(nd.title, 15)),
                    badgeText ? h("text", {
                      x: NODE_W - 10,
                      y: 24,
                      textAnchor: "end",
                      fontSize: 9.5,
                      fontWeight: 600,
                      fill: accent,
                    }, badgeText) : null,
                    h("text", {
                      x: 14,
                      y: 46,
                      fontSize: 10.5,
                      fill: "var(--dsw-alias-label-tertiary,#64748b)",
                    }, truncSvgText(nd.subtitle || "", 24)),
                  );
                }),
              ),
            h("div", { className: "rdp-canvas-legend" },
              h("div", { className: "rdp-legend-items" },
                h("span", { className: "rdp-legend-i" }, h("span", { className: "rdp-stage-dot st-working" }), "运行中流式脉冲"),
                h("span", { className: "rdp-legend-i" }, h("span", { className: "rdp-stage-dot st-done" }), "已落盘通过校验"),
                h("span", { className: "rdp-legend-i" }, h("span", { className: "rdp-stage-dot st-pending" }), "等待人类拍板")),
              h("span", null, "硬约束：仓外独立临时沙箱推式输入 · 人类唯一裁决权"))),

          // ── 右侧节点检查器、五维雷达条与人类唯一拍板台 ──────────────────
          h("div", { className: "rdp-drawer" },
            inspect ? [
              h("div", { className: "rdp-drawer-h", key: "dh" },
                h("div", { style: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" } },
                  h("span", { className: "rdp-badge" }, inspect.kindLabel || "节点详情"),
                  inspect.sha ? h("code", null, "sha:" + inspect.sha) : null),
                h("h4", { className: "rdp-drawer-t" }, inspect.title || selectedNode.title),
                inspect.fileRel ? h("code", null, inspect.fileRel) : null),

              Array.isArray(inspect.metaRows) && inspect.metaRows.length > 0
                ? h("div", { className: "rdp-kv", key: "kv" },
                  inspect.metaRows.map((pair, pi) => [
                    h("span", { className: "rdp-kv-k", key: "k" + pi }, pair[0]),
                    h("span", { className: "rdp-kv-v", key: "v" + pi }, pair[1]),
                  ]))
                : null,

              Array.isArray(inspect.pushedInputs) && inspect.pushedInputs.length > 0
                ? h("div", { key: "pushed" },
                  h("div", { className: "rdp-sec-cap" }, "推式上下文审计（物理隔离）"),
                  h("div", { className: "rdp-push-list" },
                    inspect.pushedInputs.map((inp, ii) => h("div", { className: "rdp-push-row", key: "pi" + ii },
                      h("span", null, inp.label),
                      h("code", null, inp.rel + (inp.sha ? " #" + inp.sha.slice(0, 6) : ""))))))
                : null,

              inspect.dims ? h("div", { key: "dims" },
                h("div", { className: "rdp-sec-cap" }, "五维正向盲审打分（1–5 分/维）"),
                h("div", { className: "rdp-dim-list" },
                  Object.keys(DIM_LABELS).map((dk) => {
                    const val = inspect.dims[dk];
                    const num = Number.isFinite(Number(val)) ? Number(val) : 0;
                    const pct = Math.min(100, Math.max(0, (num / 5) * 100));
                    const reason = inspect.dimReasons && inspect.dimReasons[dk] ? inspect.dimReasons[dk] : "";
                    return h("div", { className: "rdp-dim-row", key: dk },
                      h("div", { className: "rdp-dim-top" },
                        h("span", null, DIM_LABELS[dk]),
                        h("strong", null, num ? (num + " / 5") : "—")),
                      h("div", { className: "rdp-dim-bar" },
                        h("div", { className: "rdp-dim-fill", style: { width: pct + "%" } })),
                      reason ? h("div", { className: "rdp-dim-reason" }, reason) : null);
                  }))) : null,

              inspect.canVerdict && inspect.ideaId ? h("div", { className: "rdp-verdict-box", key: "verdict" },
                h("div", { className: "rdp-sec-cap", style: { color: "#d97706", marginBottom: 0 } },
                  "👤 人类唯一裁决台 · " + inspect.ideaId),
                h("div", { className: "rdp-verdict-btns" },
                  [
                    { k: "go", label: "✓ GO 立项" },
                    { k: "revise", label: "↻ REVISE 修订" },
                    { k: "kill", label: "✕ KILL 淘汰" },
                  ].map((b) => h("button", {
                    type: "button",
                    key: b.k,
                    className: "rdp-vbtn rdp-vbtn-" + b.k + (verdictChoice === b.k ? " is-sel" : ""),
                    onClick: () => setVerdictChoice(b.k),
                  }, b.label))),
                h("textarea", {
                  className: "rdp-textarea",
                  value: verdictNote,
                  placeholder: "填写人类拍板依据（如：配对统计显著，准予冻结契约；或指明淘汰反例）…",
                  onChange: (e) => setVerdictNote(e.target.value),
                }),
                verdictChoice === "kill" ? h("label", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, cursor: "pointer" } },
                  h("input", {
                    type: "checkbox",
                    checked: appendDeadEnd,
                    onChange: (e) => setAppendDeadEnd(e.target.checked),
                  }),
                  "同步追加至本课题禁入死胡同清单") : null,
                verdictChoice === "kill" && appendDeadEnd ? h("input", {
                  className: "rdp-in",
                  type: "text",
                  value: deadEndSummary,
                  placeholder: "一句话提炼证伪机制（供后续发散避坑）…",
                  onChange: (e) => setDeadEndSummary(e.target.value),
                }) : null,
                h("button", {
                  type: "button",
                  className: "rdp-btn rdp-primary",
                  disabled: !!busyMsg,
                  onClick: () => runAction({
                    kind: "verdict",
                    topic: inspect.topic || (snap && snap.activeTopic) || "default",
                    ideaId: inspect.ideaId,
                    decision: verdictChoice,
                    note: verdictNote,
                    appendDeadEnd: verdictChoice === "kill" && appendDeadEnd,
                    deadEndSummary,
                  }, "正在写入人类裁决…"),
                }, busyMsg || ("确认落盘裁决：" + verdictChoice.toUpperCase()))) : null,

              Array.isArray(inspect.actions) && inspect.actions.length > 0
                ? h("div", { className: "rdp-act-row", key: "acts" },
                  inspect.actions.map((act) => h("button", {
                    type: "button",
                    key: act,
                    className: "rdp-btn rdp-btn-sm",
                    disabled: !!busyMsg,
                    onClick: () => runAction({
                      kind: act,
                      topic: inspect.topic || (snap && snap.activeTopic) || "default",
                      ideaId: inspect.ideaId || curIdeaId,
                    }, "正在执行 " + (actionLabels[act] || act) + "…"),
                  }, actionLabels[act] || act)))
                : null,

              actionFeedback ? h("div", {
                key: "fb",
                className: actionFeedback.ok ? "rdp-ok" : "rdp-bad",
                style: { fontSize: 11.5 },
              }, actionFeedback.text) : null,

              inspect.preview ? h("div", { key: "prev" },
                h("div", { className: "rdp-sec-cap" }, "落盘证据原文预览"),
                h("pre", { className: "rdp-preview" }, inspect.preview)) : null,
            ] : h("div", { className: "rdp-meta" }, "点击左侧拓扑图中的任意输入源、沙箱 Worker 或闸门节点以检视落盘证据与哈希指纹。")),
        ),
      );
    }

    // ── 会话顶栏视图与右上角胶囊槽位包装组件 ──────────────────────────────
    function extractSessionCwd(slotProps) {
      if (!slotProps || typeof slotProps.useSessions !== "function") return "";
      try {
        const cwd = slotProps.useSessions((s) => {
          const sid = slotProps.sessionId;
          if (sid && s && s.byId && s.byId[sid]) return s.byId[sid].cwd || "";
          return "";
        });
        return String(cwd || "").trim();
      } catch {
        return "";
      }
    }

    function ConversationSwarmView(slotProps) {
      const sessionCwd = extractSessionCwd(slotProps);
      return h(SwarmStudio, { repoRoot: sessionCwd, embedded: false });
    }

    function SessionHeaderSwarmPill(slotProps) {
      const sessionCwd = extractSessionCwd(slotProps);
      const [, setSeq] = React.useState(0);
      React.useEffect(() => {
        let alive = true;
        const bump = () => { if (alive) setSeq((n) => n + 1); };
        bridgeWatchers.add(bump);
        if (!SWARM_SNAPSHOT) {
          fetchSwarmSnapshot({ repoRoot: !isDshProfilePath(sessionCwd) ? sessionCwd : "" });
        }
        return () => {
          alive = false;
          bridgeWatchers.delete(bump);
        };
      }, [sessionCwd, CONN_SEQ]);

      const activeWorkers = Number((SWARM_SNAPSHOT && SWARM_SNAPSHOT.activeWorkerCount) || 0);
      const stages = (SWARM_SNAPSHOT && Array.isArray(SWARM_SNAPSHOT.stages)) ? SWARM_SNAPSHOT.stages : [];
      const curStg = stages.find((s) => s.status === "working")
        || stages.find((s) => s.status === "pending")
        || stages.slice().reverse().find((s) => s.status === "done")
        || null;

      return h("button", {
        type: "button",
        className: "rdp-hdr-pill" + (activeWorkers > 0 ? " is-working" : ""),
        title: "打开科研派工 /swarm 实时进度与关系拓扑图",
        onClick: () => {
          if (slotProps && typeof slotProps.openView === "function") {
            slotProps.openView("research-swarm", "");
            return;
          }
          const c = slotProps && slotProps.ctx;
          const cv = c && typeof c.get === "function" ? c.get("conversationView") : null;
          if (cv && typeof cv.openView === "function") cv.openView("research-swarm", "");
        },
      },
        h("span", { className: "rdp-tab-dot" + (activeWorkers > 0 ? " is-working" : "") }),
        h("span", null, activeWorkers > 0
          ? ("科研拓扑 · " + activeWorkers + " 运行中")
          : ("科研拓扑" + (curStg ? (" · " + curStg.id) : ""))));
    }

    // ── 设置页主组件：双模式切换（阵容编排 Bento 工作台 | 科研拓扑 Swarm）──
    function Page(props) {
      const ctx = props.ctx;
      const [st, setSt] = React.useState({ phase: "loading" });
      const [draft, setDraft] = React.useState({});
      const [phase, setPhase] = React.useState("idle");
      const [menu, setMenu] = React.useState({ key: null, hi: 0, q: "" });
      const [activeTab, setActiveTab] = React.useState("lineup");
      const [probing, setProbing] = React.useState(false);
      const [tracker] = React.useState(() => ({ phase: "loading", reqSeq: 0 }));
      const [, setBridgeSeq] = React.useState(0);

      const updateSt = (next) => {
        tracker.phase = next.phase;
        setSt(next);
      };

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const bumpBridge = () => {
          if (alive) setBridgeSeq((n) => n + 1);
        };
        const clearLoadTimer = () => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
        };
        const runLoad = () => {
          const seq = ++tracker.reqSeq;
          readDescriptor(ctx)
            .then((d) => {
              if (!alive || seq !== tracker.reqSeq) return;
              clearLoadTimer();
              if (d) {
                updateSt({ phase: "ready", desc: d });
                const savedRoot = String((d.value && d.value.repoRoot) || "");
                if (savedRoot) fetchBridgeSnapshot(null, { repoRoot: savedRoot, refresh: false });
              } else {
                updateSt({ phase: "nogw", why: "连不上设置服务" });
              }
            })
            .catch((e) => {
              if (!alive || seq !== tracker.reqSeq) return;
              clearLoadTimer();
              if (e && e.code === "NS_MISSING") updateSt({ phase: "nons", why: String(e.message || e) });
              else updateSt({ phase: "nogw", why: String((e && e.message) || e) });
            });
        };
        watchers.add(runLoad);
        bridgeWatchers.add(bumpBridge);
        timer = setTimeout(() => {
          timer = null;
          if (!alive || tracker.phase !== "loading") return;
          tracker.reqSeq += 1;
          updateSt({ phase: "nogw", why: "设置服务 3 秒内没有返回" });
        }, 3000);
        runLoad();
        fetchBridgeSnapshot();
        return () => {
          alive = false;
          clearLoadTimer();
          watchers.delete(runLoad);
          bridgeWatchers.delete(bumpBridge);
        };
      }, []);

      React.useEffect(() => {
        if (CONNECTION && !BRIDGE_SNAPSHOT) {
          fetchBridgeSnapshot(null, { refresh: false });
        }
      }, [CONN_SEQ]);

      const desc = st.phase === "ready" ? st.desc : null;
      const value = (desc && desc.value) || {};
      const user = (desc && desc.user) || {};
      const live = !!desc;
      const allFields = live ? fieldsOf(desc) : FALLBACK_FIELDS;
      const fields = allFields;
      const HIDDEN = new Set([
        "seatsFile",
        "executorCatalog",
        "executorStatus",
        "otherStages",
        "stageOpinions",
        "seatOverrides",
        "seatRoster",
        "defaultBackends",
      ]);
      const DEDICATED = new Set([
        "repoRoot",
        "scoutCommand",
        "scoutModel",
        "divergeCommand",
        "divergeModel",
        "divergeCount",
        "divergeUseDeadEnds",
        "reviewVotes",
        "noveltyCommand",
        "noveltyModel",
      ]);
      const otherFields = allFields.filter((f) => !HIDDEN.has(f.key) && !DEDICATED.has(f.key));
      const text = (f) => (draft[f.key] !== undefined ? draft[f.key] : String(value[f.key] === undefined ? "" : value[f.key]));

      const rawSavedRepoRoot = String(value.repoRoot === undefined ? "" : value.repoRoot);
      const bridgeDefRoot = String((BRIDGE_SNAPSHOT && (BRIDGE_SNAPSHOT.repoRoot || BRIDGE_SNAPSHOT.defaultRepoRoot)) || "");
      const sanitizedSavedRoot = isDshProfilePath(rawSavedRepoRoot) && bridgeDefRoot && !isDshProfilePath(bridgeDefRoot)
        ? bridgeDefRoot
        : rawSavedRepoRoot;
      const curRepoRoot = draft.repoRoot !== undefined ? draft.repoRoot : sanitizedSavedRoot;

      const dirty = live && (
        fields.some((f) => draft[f.key] !== undefined && draft[f.key] !== String(value[f.key] === undefined ? "" : value[f.key]))
        || (draft.repoRoot === undefined && sanitizedSavedRoot !== rawSavedRepoRoot)
      );

      React.useEffect(() => {
        if (typeof document === "undefined" || !document.addEventListener) return undefined;
        const onDocDown = (e) => {
          const t = e && e.target;
          if (t && typeof t.closest === "function" && t.closest(".rdp-pick")) return;
          setMenu({ key: null, hi: 0, q: "" });
        };
        document.addEventListener("mousedown", onDocDown);
        return () => document.removeEventListener("mousedown", onDocDown);
      }, [menu.key]);

      const save = () => {
        if (!live) return;
        const patch = {};
        if (draft.repoRoot === undefined && sanitizedSavedRoot !== rawSavedRepoRoot) {
          patch.repoRoot = sanitizedSavedRoot;
        }
        for (const f of fields) {
          if (draft[f.key] === undefined) continue;
          let nextVal = draft[f.key];
          if (f.key === "divergeCount") {
            const trimmed = String(nextVal).trim();
            if (trimmed === "") {
              nextVal = "";
            } else {
              const parsed = parseInt(trimmed, 10);
              nextVal = Number.isFinite(parsed) ? String(Math.min(50, Math.max(1, parsed))) : "10";
            }
          }
          if (nextVal !== String(value[f.key] === undefined ? "" : value[f.key])) {
            patch[f.key] = nextVal;
          }
        }
        if (Object.keys(patch).length === 0) { setDraft({}); return; }
        const seq = ++tracker.reqSeq;
        setPhase("saving");
        writePatch(ctx, patch, desc.revision)
          .then(() => readDescriptor(ctx))
          .then((d) => {
            if (seq === tracker.reqSeq && d) updateSt({ phase: "ready", desc: d });
            setDraft({});
            setPhase("saved");
            fetchBridgeSnapshot(null, { repoRoot: patch.repoRoot || curRepoRoot, refresh: false });
          })
          .catch((e) => setPhase("failed:" + ((e && e.message) || e)));
      };

      const schemaProps = live ? propsFromSchema(desc && desc.schema) : null;
      const backendOutdated = live && isBackendOutdated(desc);
      const cat = panelCatalog(value, ctx, schemaProps);
      const statusMap = effectiveStatusOf(value, schemaProps);
      const projLineup = (BRIDGE_SNAPSHOT && BRIDGE_SNAPSHOT.projectLineup) || null;
      const workspaces = (BRIDGE_SNAPSHOT && Array.isArray(BRIDGE_SNAPSHOT.workspaces)) ? BRIDGE_SNAPSHOT.workspaces : [];
      const activeWorkers = Number((SWARM_SNAPSHOT && SWARM_SNAPSHOT.activeWorkerCount) || 0);

      const inheritedStageLabel = (stageKey) => {
        if (!projLineup || !projLineup.configured || !projLineup[stageKey]) return "";
        const item = projLineup[stageKey];
        if (!item.seat) return "";
        return item.seat + (item.resolvedModel ? (" · " + item.resolvedModel) : "");
      };

      const renderSingleStageItem = (stageKey, rowLabel, cmdKey, modelKey) => {
        const curExec = draft[cmdKey] !== undefined
          ? draft[cmdKey]
          : String(value[cmdKey] === undefined ? "" : value[cmdKey]);
        const curModel = draft[modelKey] !== undefined
          ? draft[modelKey]
          : String(value[modelKey] === undefined ? "" : value[modelKey]);
        const execOptions = buildExecOptions(curExec, statusMap, "默认（按配置）");
        const modelPlaceholder = curExec
          ? defaultModelLabel(curExec, cat, "默认（用它自己的默认模型）")
          : "默认（随所选工具）";
        const inherited = !curExec ? inheritedStageLabel(stageKey) : "";
        return h("div", { className: "rdp-item", key: "row-" + stageKey },
          h("div", { className: "rdp-item-main" },
            h("span", { className: "rdp-label" }, rowLabel),
            h("span", { className: "rdp-sub" },
              "当前 ",
              h("code", null, (curExec || "默认（按配置）") + " · " + (curModel || "默认")),
              inherited ? h("span", { className: "rdp-inherit" }, "项目默认：" + inherited) : null)),
          h("div", { className: "rdp-ctl" },
            h("div", { className: "rdp-grid2" },
              h("select", {
                className: "rdp-in",
                disabled: !live,
                value: curExec,
                onChange: (e) => setDraft((prev) => ({ ...prev, [cmdKey]: e.target.value, [modelKey]: "" })),
              },
                execOptions.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
              pickerNode({ menu, setMenu }, stageKey, curExec, cat, curModel, !live || !curExec,
                modelPlaceholder,
                (m) => setDraft((prev) => ({ ...prev, [modelKey]: m }))))));
      };

      const curDivergeCount = draft.divergeCount !== undefined
        ? draft.divergeCount
        : (String(value.divergeCount === undefined || value.divergeCount === "" ? "10" : value.divergeCount));

      const rawDeadEnds = draft.divergeUseDeadEnds !== undefined
        ? draft.divergeUseDeadEnds
        : String(value.divergeUseDeadEnds === undefined || value.divergeUseDeadEnds === "" ? "true" : value.divergeUseDeadEnds);
      const curUseDeadEnds = String(rawDeadEnds).trim().toLowerCase() === "false" ? "false" : "true";

      return h("div", { className: "rdp" + (activeTab === "swarm" ? " is-swarm" : "") },
        // ── 顶部旗舰页头：标题 + 视图切换胶囊 + 五大 CLI 状态舰队条 ──────
        h("div", { className: "rdp-hero", key: "head" },
          h("div", { className: "rdp-hero-top" },
            h("div", { className: "rdp-head" },
              h("span", { className: "rdp-eyebrow" }, "RESEARCH DISPATCH STUDIO"),
              h("h2", { className: "rdp-title" }, "科研派工 · 全流程编排与拓扑"),
              h("p", { className: "rdp-lead" }, "按科研闭环自由搭配「文献调研 → 想法发散 → 多票评审 → 前置查重」各环节工具与模型，并通过实时拓扑图追踪每个独立沙箱进度与落盘裁决。")),
            h("div", { className: "rdp-tabs", role: "tablist", "aria-label": "科研派工视图切换" },
              h("button", {
                type: "button",
                role: "tab",
                "aria-selected": activeTab === "lineup" ? "true" : "false",
                className: "rdp-tab" + (activeTab === "lineup" ? " is-active" : ""),
                onClick: () => setActiveTab("lineup"),
              }, "阵容编排"),
              h("button", {
                type: "button",
                role: "tab",
                "aria-selected": activeTab === "swarm" ? "true" : "false",
                className: "rdp-tab" + (activeTab === "swarm" ? " is-active" : ""),
                onClick: () => setActiveTab("swarm"),
              },
                h("span", { className: "rdp-tab-dot" + (activeWorkers > 0 ? " is-working" : "") }),
                "科研拓扑" + (activeWorkers > 0 ? (" (" + activeWorkers + ")") : "")))),

          // 五大本地 CLI 状态舰队条
          h("div", { className: "rdp-fleet" },
            STAGE_SEATS.map((exec) => {
              const row = cat.find((c) => c.exec === exec);
              const mCount = row && Array.isArray(row.models) ? row.models.length : 0;
              const isInstalled = !Object.prototype.hasOwnProperty.call(statusMap, exec) || statusMap[exec] !== false;
              return h("span", {
                key: "fl:" + exec,
                className: "rdp-fleet-chip" + (isInstalled ? "" : " is-off"),
              },
                h("span", { className: "rdp-fleet-dot", style: { background: isInstalled ? (SEAT_COLORS[exec] || "#10b981") : "#94a3b8" } }),
                h("strong", null, exec),
                h("span", { className: "rdp-fleet-cnt" }, isInstalled ? (mCount > 0 ? (mCount + " 模型") : "已就绪") : "未安装"));
            }),
            h("button", {
              type: "button",
              className: "rdp-btn rdp-fleet-refresh",
              disabled: probing,
              onClick: () => {
                setProbing(true);
                fetchBridgeSnapshot(null, { repoRoot: curRepoRoot, refresh: true })
                  .finally(() => setProbing(false));
              },
            }, probing ? "探测中…" : "刷新模型探测"))),

        live ? null : h("div", { className: "rdp-state", key: "state" },
          st.phase === "loading"
            ? "正在连接设置服务…（首次打开会慢一点）"
            : st.phase === "nons"
              ? "设置服务连上了，但本页暂时没有可编辑项。先用默认设置即可；需要改动时请参考项目说明。"
              : "连不上设置服务（原因：" + st.why + "），这一页只能看说明、不能修改。稍后重试，或检查桌面端是否正常运行。"),
        backendOutdated ? h("div", { className: "rdp-state rdp-warn", key: "stale-backend" },
          "检测到插件界面已更新，但后台服务仍在运行旧版进程（Windows 点击右上角关闭仅最小化到右下角系统托盘）。请右键任务栏右下角托盘中的 DeepSeek Harness 图标选择「退出」后再重新打开，即可完成后台刷新并开启实时拓扑通道。") : null,

        // ── 视图 B：科研拓扑 /swarm 全链路进度与关系星图 ──────────────────
        activeTab === "swarm"
          ? h(SwarmStudio, {
            key: "swarm-tab",
            repoRoot: curRepoRoot,
            embedded: true,
            onSelectRepoRoot: (nextDir) => {
              setDraft((prev) => ({ ...prev, repoRoot: nextDir }));
              fetchBridgeSnapshot(null, { repoRoot: nextDir, refresh: false });
            },
          })
          : [
            // ── 视图 A：全流程阵容编排 Bento 工作台 ────────────────────────
            // 1. 工作流项目
            h("div", { className: "rdp-bento", key: "bento-project" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  h("span", { className: "rdp-step-pill rdp-step-ws" }, "PROJECT"),
                  h("h3", { className: "rdp-group-t" }, "工作流项目")),
                h("p", { className: "rdp-group-d" }, "指定当前科研项目所在的文件夹路径。保存本页设置时，下方各环节阵容会自动同步进该项目的配置文件，跨终端与编辑器直接共享生效。")),
              h("div", { className: "rdp-items" },
                h("div", { className: "rdp-item" },
                  h("div", { className: "rdp-item-main" },
                    h("span", { className: "rdp-label" }, "项目文件夹"),
                    h("span", { className: "rdp-sub" }, "当前 ", h("code", null, curRepoRoot || "自动探测当前目录"))),
                  h("div", { className: "rdp-ctl" },
                    h("input", {
                      className: "rdp-in rdp-in-path",
                      type: "text",
                      disabled: !live,
                      value: curRepoRoot,
                      placeholder: "例如 /path/to/my-research（留空自动探测）",
                      onChange: (e) => setDraft((prev) => ({ ...prev, repoRoot: e.target.value })),
                    })))),
              workspaces.length > 0 ? h("div", { className: "rdp-ws-strip" },
                h("span", { className: "rdp-ws-cap" }, "已发现工作区："),
                workspaces.slice(0, 7).map((ws) => h("button", {
                  type: "button",
                  key: "ws:" + ws.dir,
                  disabled: !live,
                  className: "rdp-ws-pill" + (curRepoRoot === ws.dir ? " is-active" : ""),
                  title: ws.dir,
                  onClick: () => {
                    setDraft((prev) => ({ ...prev, repoRoot: ws.dir }));
                    fetchBridgeSnapshot(null, { repoRoot: ws.dir, refresh: false });
                  },
                },
                  ws.isResearch ? h("span", { className: "rdp-ws-star" }, "✦") : null,
                  ws.name))) : null),

            // 2. 文献调研（S0）
            h("div", { className: "rdp-bento", key: "bento-scout" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  h("span", { className: "rdp-step-pill rdp-step-s0" }, "S0"),
                  h("h3", { className: "rdp-group-t" }, "文献调研")),
                h("p", { className: "rdp-group-d" }, "检索相关论文、优先提取源码与核心公式并整理为结构化文献卡片，汇总成文献池供后续环节参考。")),
              h("div", { className: "rdp-items" },
                renderSingleStageItem("scout", "由谁调研", "scoutCommand", "scoutModel"))),

            // 3. 想法发散（S2）
            h("div", { className: "rdp-bento", key: "bento-diverge" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  h("span", { className: "rdp-step-pill rdp-step-s2" }, "S2"),
                  h("h3", { className: "rdp-group-t" }, "想法发散")),
                h("p", { className: "rdp-group-d" }, "基于文献卡片池与基线实验指标，单次产出一批互不串写、可量化证伪的候选研究想法。")),
              h("div", { className: "rdp-items" },
                renderSingleStageItem("diverge", "由谁发散", "divergeCommand", "divergeModel"),
                h("div", { className: "rdp-item", key: "row-diverge-count" },
                  h("div", { className: "rdp-item-main" },
                    h("span", { className: "rdp-label" }, "单轮默认条数"),
                    h("span", { className: "rdp-sub" }, "每次发散默认生成的候选想法数量（范围 1–50，默认 ", h("code", null, "10"), "）")),
                  h("div", { className: "rdp-ctl" },
                    h("input", {
                      className: "rdp-in rdp-in-num",
                      type: "number",
                      min: 1,
                      max: 50,
                      disabled: !live,
                      value: curDivergeCount,
                      placeholder: "10",
                      onChange: (e) => setDraft((prev) => ({ ...prev, divergeCount: e.target.value })),
                    }))),
                h("div", { className: "rdp-item", key: "row-diverge-deadends" },
                  h("div", { className: "rdp-item-main" },
                    h("span", { className: "rdp-label" }, "历史死胡同过滤"),
                    h("span", { className: "rdp-sub" }, "当前 ", h("code", null, curUseDeadEnds === "false" ? "纯空白零历史锚定模式" : "常规挂载已证伪方向"))),
                  h("div", { className: "rdp-ctl" },
                    h("select", {
                      className: "rdp-in rdp-in-mode",
                      disabled: !live,
                      value: curUseDeadEnds,
                      onChange: (e) => setDraft((prev) => ({ ...prev, divergeUseDeadEnds: e.target.value })),
                    },
                      h("option", { key: "true", value: "true" }, "常规挂载已证伪方向（防重复踩坑）"),
                      h("option", { key: "false", value: "false" }, "纯空白零历史锚定模式（跳出既有框架）")))))),

            // 4. 多票评审（S4）
            h("div", { className: "rdp-bento", key: "bento-review" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  h("span", { className: "rdp-step-pill rdp-step-s4" }, "S4"),
                  h("h3", { className: "rdp-group-t" }, "多票评审")),
                h("p", { className: "rdp-group-d" }, "每条候选想法在独立沙箱内交给几位评审员盲审打分，自动汇总五维总分与降序榜单供你裁决。排几票就有几位评审员（支持同一工具排多票配不同模型）；一票都不排，就按配置文件里的默认阵容运行。")),
              (() => {
                const rows = draft.reviewVotes !== undefined ? parseVoteRows(draft.reviewVotes) : voteRows(value);
                const applyVotes = (next) => setDraft((prev) => ({ ...prev, reviewVotes: voteString(next) }));
                const hasReviewCatalog = cat.some((c) => REVIEW_SEATS.includes(c.exec));
                const projReviewSlots = (projLineup && projLineup.configured && Array.isArray(projLineup.review))
                  ? projLineup.review
                  : [];
                const nextSeat = () => {
                  const used = new Set(rows.map((r) => r.executor));
                  for (const s of REVIEW_SEATS) {
                    if (!used.has(s)) return s;
                  }
                  return REVIEW_SEATS[rows.length % REVIEW_SEATS.length];
                };
                return h("div", { key: "votes" },
                  h("div", { className: "rdp-items" },
                    rows.length === 0
                      ? h("div", { className: "rdp-empty", key: "empty-votes" },
                        h("span", null, "当前未单独排票，将按配置文件里的默认评审阵容运行。点下方「+ 加一票」可自由添加评审员。"),
                        projReviewSlots.length > 0 ? h("span", { className: "rdp-slot-pills" },
                          projReviewSlots.map((sl, si) => h("span", { className: "rdp-inherit", key: "ps:" + si },
                            sl.tag + (sl.resolvedModel ? (" · " + sl.resolvedModel) : "")))) : null)
                      : rows.map((row, idx) => {
                        const seatOptions = buildExecOptions(row.executor, statusMap, "");
                        return h("div", { className: "rdp-item", key: "v" + idx },
                          h("div", { className: "rdp-item-main" },
                            h("span", { className: "rdp-label" }, "票 " + (idx + 1)),
                            h("span", { className: "rdp-sub" }, "当前 ", h("code", null, row.executor + " · " + (row.model || "默认")))),
                          h("div", { className: "rdp-ctl" },
                            h("div", { className: "rdp-grid2" },
                              h("select", {
                                className: "rdp-in",
                                disabled: !live,
                                value: row.executor,
                                onChange: (e) => applyVotes(rows.map((r, i) => (i === idx ? { executor: e.target.value, model: "" } : r))),
                              },
                                seatOptions.map((o) => h("option", { key: o.value, value: o.value }, o.label))),
                              pickerNode({ menu, setMenu }, "vote:" + idx, row.executor, cat, row.model, !live,
                                defaultModelLabel(row.executor, cat, "默认（用它自己的默认模型）"),
                                (m) => applyVotes(rows.map((r, i) => (i === idx ? { ...r, model: m } : r))))),
                            h("button", {
                              type: "button",
                              className: "rdp-btn rdp-btn-danger",
                              disabled: !live,
                              title: "删除票 " + (idx + 1),
                              onClick: () => applyVotes(rows.filter((_, i) => i !== idx)),
                            }, "删除")));
                      }),
                    live && !hasReviewCatalog ? h("div", { className: "rdp-empty", key: "nocat" },
                      "暂未探测到预设模型清单。你仍可点击模型框直接输入任意模型名回车保存。") : null),
                  h("div", { className: "rdp-add-wrap", key: "add" },
                    h("button", {
                      type: "button",
                      className: "rdp-btn rdp-add",
                      disabled: !live,
                      onClick: () => applyVotes(rows.concat([{ executor: nextSeat(), model: "" }])),
                    }, "+ 加一票"),
                    rows.length === 0 && projReviewSlots.length > 0 ? h("button", {
                      type: "button",
                      className: "rdp-btn",
                      disabled: !live,
                      onClick: () => applyVotes(projReviewSlots
                        .filter((sl) => STAGE_SEATS.includes(sl.seat))
                        .map((sl) => ({ executor: sl.seat, model: sl.model || "" }))),
                    }, "载入项目默认阵容微调") : null),
                );
              })()),

            // 5. 前置查重（S4.5）
            h("div", { className: "rdp-bento", key: "bento-novelty" },
              h("div", { className: "rdp-group" },
                h("div", { className: "rdp-group-row" },
                  h("span", { className: "rdp-step-pill rdp-step-s45" }, "S4.5"),
                  h("h3", { className: "rdp-group-t" }, "前置查重")),
                h("p", { className: "rdp-group-d" }, "在正式投入长时训练前，对票面占优的入围想法做定向文献查新与撞车排查，出具结构化查重报告。")),
              h("div", { className: "rdp-items" },
                renderSingleStageItem("novelty", "由谁查重", "noveltyCommand", "noveltyModel"))),

            h("p", { className: "rdp-note", key: "seats-hint" }, SEATS_HINT),

            otherFields.length === 0 ? null : h("div", { className: "rdp-bento", key: "adv" },
              h("div", { className: "rdp-group" },
                h("h3", { className: "rdp-group-t" }, "高级项"),
                h("p", { className: "rdp-group-d" }, "这里是没有专用控件的新增项目，日常不用修改。")),
              otherFields.map((f) => h("div", { className: "rdp-item rdp-item-full", key: f.key },
                h("div", { className: "rdp-item-main" },
                  h("span", { className: "rdp-label" }, f.title,
                    live && Object.prototype.hasOwnProperty.call(user, f.key) ? h("span", { className: "rdp-badge" }, "已覆盖") : null),
                  h("input", {
                    className: "rdp-in",
                    type: "text",
                    disabled: !live,
                    value: text(f),
                    placeholder: live ? String(f.default === undefined ? "" : f.default) : "（当前不可编辑）",
                    onChange: (e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value })),
                  }),
                  f.description ? h("span", { className: "rdp-meta" }, f.description) : null)))),

            h("div", { className: "rdp-foot", key: "foot" },
              h("span", { className: "rdp-foot-msg" },
                phase === "saved" ? h("span", { className: "rdp-ok" }, "已保存并同步至项目配置")
                  : phase.indexOf("failed") === 0 ? h("span", { className: "rdp-bad" }, "保存失败：" + phase.slice(7))
                  : (live ? "修改后点击右侧保存，桌面端与命令行即刻共享生效" : "当前不可编辑，保存不可用")),
              h("div", { className: "rdp-foot-ctl" },
                h("button", {
                  className: "rdp-btn",
                  type: "button",
                  disabled: !dirty || phase === "saving",
                  onClick: () => { setDraft({}); setPhase("idle"); },
                }, "放弃"),
                h("button", {
                  className: "rdp-btn rdp-primary",
                  type: "button",
                  disabled: !dirty || phase === "saving",
                  onClick: save,
                }, phase === "saving" ? "保存中" : "保存"))),
          ],
      );
    }

    const name = "research-dispatch";
    const inject = ["slots", "remote", "remote.settings"];

    function apply(ctx) {
      ensureStyleTag();
      GATEWAY = null;
      CONNECTION = null;
      SWARM_LAST_ERROR = "";

      // 0) 优先同步探测 DSH connection 服务（immediately:true 时同步就绪），绝不阻塞无该服务的最小宿主
      try {
        const directConn = (ctx && ctx.connection)
          || (ctx && typeof ctx.get === "function" ? ctx.get("connection") : null);
        if (directConn && ((directConn.rpc && typeof directConn.rpc.call === "function") || typeof directConn.fetch === "function")) {
          setConnection(directConn);
          diag.connectionVia = "ctx.direct";
        }
      } catch { /* cordis 对未在本地 inject 声明的属性读取抛异常时静默跳过 */ }

      // 1) 可选设置左栏矢量图标槽位
      try {
        ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
          name: "settings.section.icon",
          id: "research-dispatch",
          order: 40,
        }, () => h(SettingsNavIcon, null)));
      } catch { /* 最小宿主不支持图标槽位时静默跳过 */ }

      // 2) 可选会话顶栏「科研拓扑」全屏交互视图槽位
      try {
        ctx.slots.inject("conversation.view", () => ctx.slots.register({
          name: "conversation.view",
          id: "research-swarm",
          order: 20,
          label: () => "科研拓扑",
        }, (p) => h(ConversationSwarmView, { ...p, ctx })));
      } catch { /* 静默跳过 */ }

      // 3) 可选会话右上角实时状态胶囊槽位
      try {
        ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register({
          name: "conversation.session.header.utilities",
          id: "research-dispatch-pill",
          order: 50,
          label: () => "科研派工",
        }, (p) => h(SessionHeaderSwarmPill, { ...p, ctx })));
      } catch { /* 静默跳过 */ }

      // 4) 核心设置分区槽位（保持最后注册，兼容单变量 mock 捕获最后一个注册槽位）
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
        console.warn("[research-dispatch] 设置面板注册失败，已跳过：" + (e && e.message));
        return;
      }

      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["connection"], (child) => {
            try {
              const c = (child && child.connection)
                || (child && typeof child.get === "function" ? child.get("connection") : null);
              if (!c) return;
              setConnection(c);
              diag.connectionVia = "ctx.inject";
              const clearConn = () => { if (CONNECTION === c) setConnection(null); };
              if (child && typeof child.on === "function") child.on("dispose", clearConn);
              else if (child && typeof child.effect === "function") child.effect(() => clearConn);
            } catch (e) {
              diag.connectionInjectError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) {
        diag.connectionInjectError = String((e && e.message) || e);
      }

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
              const clearGw = () => { if (GATEWAY === resolved) setGateway(null); };
              if (child && typeof child.on === "function") child.on("dispose", clearGw);
              else if (child && typeof child.effect === "function") child.effect(() => clearGw);
            } catch (e) {
              diag.remoteInjectError = String((e && e.message) || e);
            }
          });
        }
      } catch (e) {
        diag.injectError = String((e && e.message) || e);
      }

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

      const onDispose = () => {
        try { if (STYLE_TAG && typeof STYLE_TAG.remove === "function") STYLE_TAG.remove(); } catch { /* 已移除 */ }
        STYLE_TAG = null;
        GATEWAY = null;
        CONNECTION = null;
        EXTRA_MODELS = null;
        BRIDGE_SNAPSHOT = null;
        SWARM_SNAPSHOT = null;
        SWARM_ROUTE_MISSING = false;
        SWARM_LAST_ERROR = "";
      };
      try {
        if (typeof ctx.effect === "function") ctx.effect(() => onDispose);
        else if (typeof ctx.on === "function") ctx.on("dispose", onDispose);
      } catch (e) { diag.effectError = String((e && e.message) || e); }

      try { pushStep("apply@" + Date.now()); } catch { /* 探针失败不影响功能 */ }
      try { diag.inject = inject.slice(); } catch { /* 同上 */ }
      try { diag.slots = !!(ctx && ctx.slots); } catch { /* 同上 */ }
      try { diag.remoteReachable = !!(ctx && ctx.get && ctx.get("remote")); } catch { /* 同上 */ }
    }

    module.exports = {
      name,
      inject,
      apply,
      __test: {
        readDescriptor,
        writePatch,
        fieldsOf,
        propsFromSchema,
        catalogOf,
        statusOf,
        effectiveStatusOf,
        mergeCatalog,
        mergeCatalogRows,
        readModelDirectories,
        groupsToCatalog,
        panelCatalog,
        setConnection,
        setLiveGroups,
        setBridgeSnapshot,
        fetchBridgeSnapshot,
        setSwarmSnapshot,
        fetchSwarmSnapshot,
        postDispatchAction,
        isBackendOutdated,
        isDshProfilePath,
        cubicEdgePath,
        groupedModels,
        flattenGroups,
        modelMatch,
        filteredGroups,
        buildMenuView,
        messagePlaceholder: null,
        ModelPicker,
        SwarmStudio,
        ConversationSwarmView,
        SessionHeaderSwarmPill,
        SettingsNavIcon,
        menuProps,
        liveGroups: () => LIVE_GROUPS,
        bridgeSnapshot: () => BRIDGE_SNAPSHOT,
        swarmSnapshot: () => SWARM_SNAPSHOT,
        swarmLastError: () => SWARM_LAST_ERROR,
        swarmRouteMissing: () => SWARM_ROUTE_MISSING,
        resetLiveCatalog: () => { LIVE_GROUPS = null; LIVE_CATALOG = null; },
        resetBridgeSnapshot: () => { BRIDGE_SNAPSHOT = null; },
        resetSwarmSnapshot: () => { SWARM_SNAPSHOT = null; SWARM_ROUTE_MISSING = false; SWARM_LAST_ERROR = ""; },
        resetModelDirs: () => { EXTRA_MODELS = null; },
        RPC_CHANNEL,
        RPC_EXEC_METHOD,
        RPC_SWARM_METHOD,
        RPC_ACTION_METHOD,
        BRIDGE_EXEC_PATH,
        BRIDGE_SWARM_PATH,
        BRIDGE_ACTION_PATH,
        STAGE_SEATS,
        REVIEW_SEATS,
        DIVERGE_SEATS,
        SEAT_LABELS,
        SEATS_HINT,
        CSS: () => CSS,
      },
      default: { name, inject, apply },
    };
    return module.exports;
  },
});
