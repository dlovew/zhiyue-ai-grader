  // src/ui/styles.ts
  var STYLES = `
:host {
  --zygr-primary: #4f46e5;
  --zygr-sky: #0ea5e9;
  --zygr-teal: #14b8a6;
  --zygr-ink: #0f172a;
  --zygr-muted: #475569;
  --zygr-line: rgba(148, 163, 184, .28);
  --zygr-surface: rgba(255, 255, 255, .82);
  --zygr-glow: rgba(79, 70, 229, .18);
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 2147483647;
  font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 13px;
  color: var(--zygr-ink);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .55; }
.zygr-panel {
  width: 380px;
  max-height: calc(100vh - 40px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  border: 1px solid rgba(255, 255, 255, .65);
  background: linear-gradient(160deg, rgba(255,255,255,.92), rgba(238,242,255,.78));
  backdrop-filter: blur(18px) saturate(140%);
  box-shadow: 0 18px 48px rgba(15, 23, 42, .2), inset 0 1px 0 rgba(255,255,255,.7);
  animation: zygr-in .32s cubic-bezier(.2,.8,.2,1);
}
.zygr-head {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 14px 16px;
  color: #fff;
  background: linear-gradient(135deg, #4f46e5 0%, #0ea5e9 100%);
  position: relative;
  overflow: hidden;
}
.zygr-head::after {
  content: ""; position: absolute; inset: -60% -20% auto auto; width: 180px; height: 180px;
  background: radial-gradient(circle, rgba(255,255,255,.35), transparent 70%);
  animation: zygr-float 6s ease-in-out infinite;
}
.zygr-brand { display: flex; align-items: center; gap: 10px; position: relative; z-index: 1; }
.zygr-logo {
  width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px;
  background: rgba(255,255,255,.22); border: 1px solid rgba(255,255,255,.4);
  font-weight: 700; font-size: 17px; letter-spacing: 1px;
}
.zygr-brand strong { display: block; font-size: 16px; letter-spacing: .5px; }
.zygr-title-row { display: flex; align-items: center; gap: 6px; }
.zygr-version {
  flex: none; padding: 2px 6px; border-radius: 999px;
  border: 1px solid rgba(255,255,255,.34); background: rgba(255,255,255,.16);
  font-size: 9px; line-height: 1.2; letter-spacing: .2px; opacity: .92;
}
.zygr-brand small { display: block; opacity: .86; font-size: 11px; margin-top: 2px; }
.zygr-head-actions { display: flex; gap: 6px; position: relative; z-index: 1; }
.zygr-icon {
  width: 28px; height: 28px; border: 1px solid rgba(255,255,255,.32); border-radius: 9px;
  background: rgba(255,255,255,.14); color: #fff; line-height: 1; transition: .18s;
}
.zygr-icon:hover { background: rgba(255,255,255,.28); transform: translateY(-1px); }
.zygr-body { padding: 12px 14px; overflow: auto; display: grid; gap: 10px; }
.zygr-panel.zygr-collapsed .zygr-body,
.zygr-panel.zygr-collapsed .zygr-actions { display: none; }
.zygr-statusbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--zygr-muted); }
#zygr-progress { font-size: 11px; color: var(--zygr-muted); white-space: nowrap; }
.zygr-chip {
  padding: 3px 9px; border-radius: 999px; font-size: 11px; white-space: nowrap;
  background: rgba(79,70,229,.1); color: #4338ca; border: 1px solid rgba(79,70,229,.18);
}
.zygr-chip.zygr-warn { background: rgba(245,158,11,.12); color: #b45309; border-color: rgba(245,158,11,.25); }
.zygr-chip.zygr-ok { background: rgba(22,163,74,.12); color: #15803d; border-color: rgba(22,163,74,.25); }
.zygr-progress { height: 3px; border-radius: 999px; overflow: hidden; background: rgba(148,163,184,.22); }
.zygr-progress i {
  display: block; height: 100%; width: 0; border-radius: inherit;
  background: linear-gradient(90deg, var(--zygr-primary), var(--zygr-sky), var(--zygr-teal));
  transition: width .4s ease;
}
.zygr-card {
  border: 1px solid var(--zygr-line); border-radius: 14px; padding: 12px;
  background: rgba(255,255,255,.62); box-shadow: 0 6px 18px rgba(15,23,42,.05);
}
.zygr-meta { color: var(--zygr-muted); line-height: 1.7; }
.zygr-thumbs { display: flex; gap: 6px; overflow-x: auto; margin-top: 9px; padding-bottom: 2px; }
.zygr-thumbs img {
  width: 54px; height: 54px; flex: none; object-fit: cover; border-radius: 9px;
  border: 1px solid var(--zygr-line); cursor: zoom-in; transition: transform .18s, box-shadow .18s;
}
.zygr-thumbs img:hover { transform: scale(1.08); box-shadow: 0 6px 14px rgba(15,23,42,.14); }
.zygr-score-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
.zygr-score { font-size: 34px; font-weight: 700; line-height: 1; letter-spacing: -1px; background: linear-gradient(135deg, #4f46e5, #0ea5e9); -webkit-background-clip: text; background-clip: text; color: transparent; }
.zygr-score small { font-size: 14px; color: var(--zygr-muted); -webkit-text-fill-color: var(--zygr-muted); }
.zygr-score-input {
  width: 78px; padding: 2px 6px; border: 1px solid rgba(79,70,229,.28); border-radius: 9px;
  background: rgba(255,255,255,.9); color: #3730a3; font-size: 20px; font-weight: 700; line-height: 1.2;
  -webkit-text-fill-color: #3730a3; text-align: center;
}
.zygr-score-input:focus { outline: 2px solid var(--zygr-sky); outline-offset: 1px; }
.zygr-table .zygr-score-input { width: 62px; padding: 3px 5px; font-size: 12px; }
.zygr-badge { padding: 4px 10px; border-radius: 999px; font-size: 11px; background: rgba(20,184,166,.12); color: #0f766e; border: 1px solid rgba(20,184,166,.24); }
.zygr-badge.zygr-risk { background: rgba(220,38,38,.1); color: #b91c1c; border-color: rgba(220,38,38,.22); }
.zygr-reason { margin-top: 10px; color: var(--zygr-muted); line-height: 1.65; }
.zygr-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
.zygr-table th, .zygr-table td { text-align: left; padding: 6px 5px; border-top: 1px solid var(--zygr-line); }
.zygr-table th { color: var(--zygr-muted); font-weight: 500; }
.zygr-reviews { margin-top: 8px; color: #b45309; line-height: 1.6; }
.zygr-error { padding: 9px 11px; border-radius: 10px; background: rgba(220,38,38,.08); color: #b91c1c; border: 1px solid rgba(220,38,38,.18); }
.zygr-actions {
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px 10px;
  border-top: 1px solid var(--zygr-line); background: rgba(255,255,255,.42);
}
.zygr-btn {
  display: inline-flex; align-items: center; justify-content: center; flex: 0 0 auto;
  min-height: 28px; padding: 0 10px; line-height: 1; white-space: nowrap;
  border-radius: 7px; border: 1px solid rgba(79,70,229,.18);
  background: rgba(255,255,255,.78); color: #3730a3; font-size: 11px; transition: .18s;
}
.zygr-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 3px 9px rgba(79,70,229,.14); }
.zygr-btn:focus-visible { outline: 2px solid var(--zygr-sky); outline-offset: 2px; }
.zygr-continuous-cell {
  display: inline-flex; align-items: center; gap: 2px;
  padding: 2px 6px 2px 2px; border: 1px solid var(--zygr-line); border-radius: 9px;
  background: rgba(255,255,255,.58);
}
.zygr-continuous-cell .zygr-btn { border-color: transparent; background: transparent; }
.zygr-limit {
  display: inline-flex; align-items: center; gap: 3px;
  font-size: 10px; line-height: 1; color: var(--zygr-muted); white-space: nowrap;
  cursor: help; user-select: none;
}
.zygr-limit input {
  width: 34px; height: 22px; padding: 0 2px; text-align: center;
  border: 1px solid rgba(79,70,229,.22); border-radius: 6px;
  background: rgba(255,255,255,.9); color: #3730a3; font-size: 11px; font-weight: 600;
  -moz-appearance: textfield;
}
.zygr-limit input::-webkit-inner-spin-button,
.zygr-limit input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
.zygr-limit input:focus-visible { outline: 2px solid var(--zygr-sky); outline-offset: 1px; }
.zygr-limit input:disabled { cursor: not-allowed; }
.zygr-btn.zygr-primary { color: #fff; border-color: transparent; background: linear-gradient(135deg, var(--zygr-primary), var(--zygr-sky)); }
.zygr-btn.zygr-running { color: #fff; border-color: transparent; background: linear-gradient(135deg, #dc2626, #f59e0b); }
.zygr-btn.zygr-ghost { color: var(--zygr-muted); border-color: var(--zygr-line); background: transparent; }
.zygr-submit-cell { display: flex; flex-direction: row; align-items: center; gap: 6px; }
.zygr-mini-check { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; line-height: 1; white-space: nowrap; color: var(--zygr-muted); cursor: pointer; user-select: none; }
.zygr-mini-check input { accent-color: var(--zygr-primary); width: 12px; height: 12px; flex: none; }
.zygr-output {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10px; line-height: 1; color: var(--zygr-muted); white-space: nowrap;
  cursor: help; user-select: none;
}
.zygr-output select {
  height: 22px; padding: 0 2px; cursor: pointer;
  border: 1px solid rgba(79,70,229,.22); border-radius: 6px;
  background: rgba(255,255,255,.9); color: #3730a3; font-size: 11px; font-weight: 600;
}
.zygr-output select:focus-visible { outline: 2px solid var(--zygr-sky); outline-offset: 1px; }
.zygr-output select:disabled { cursor: not-allowed; opacity: .6; }
.zygr-toast {
  position: absolute; left: 50%; bottom: 74px; transform: translateX(-50%); z-index: 2;
  padding: 8px 14px; border-radius: 999px; background: rgba(15,23,42,.9); color: #fff; font-size: 12px;
  animation: zygr-in .2s ease; white-space: nowrap;
}
.zygr-test-status { font-size: 12px; color: var(--zygr-muted); }
.zygr-test-status.zygr-ok { color: #15803d; }
.zygr-test-status.zygr-bad { color: #b91c1c; }
.zygr-overlay {
  position: fixed; inset: 0; z-index: 2147483647; display: grid; place-items: center;
  background: rgba(15,23,42,.38); backdrop-filter: blur(4px); padding: 20px;
}
.zygr-dialog {
  position: relative;
  width: min(680px, 100%); max-height: min(82vh, 760px); display: flex; flex-direction: column;
  border-radius: 20px; overflow: hidden; background: linear-gradient(160deg, #fff, #eef2ff);
  border: 1px solid rgba(255,255,255,.75); box-shadow: 0 24px 70px rgba(15,23,42,.28);
  animation: zygr-in .25s ease;
}
.zygr-dialog.zygr-wide { width: min(840px, 100%); }
.zygr-dialog-head { display: flex; justify-content: space-between; align-items: center; padding: 16px 20px; color: #fff; background: linear-gradient(135deg,#4f46e5,#0ea5e9); }
.zygr-dialog-head h2 { margin: 0; font-size: 17px; }
.zygr-dialog-body { padding: 16px 20px; overflow: auto; display: grid; gap: 14px; }
.zygr-dialog-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--zygr-line); }
.zygr-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--zygr-line); }
.zygr-tab { padding: 8px 14px; border: 0; background: transparent; color: var(--zygr-muted); border-bottom: 2px solid transparent; transition: .18s; }
.zygr-tab.zygr-active { color: var(--zygr-primary); border-color: var(--zygr-primary); }
.zygr-section { display: grid; gap: 10px; }
.zygr-section h3 { margin: 0; font-size: 14px; color: #3730a3; }
.zygr-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
.zygr-field { display: grid; gap: 5px; }
.zygr-field label { font-size: 12px; color: var(--zygr-muted); }
.zygr-field input, .zygr-field select, .zygr-field textarea {
  width: 100%; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--zygr-line);
  background: rgba(255,255,255,.9); outline: none; transition: .18s;
}
.zygr-field input:focus, .zygr-field select:focus { border-color: var(--zygr-primary); box-shadow: 0 0 0 3px var(--zygr-glow); }
.zygr-hint { font-size: 11px; color: var(--zygr-muted); line-height: 1.6; }
.zygr-summary { margin: -6px 0 0; font-size: 11px; color: var(--zygr-muted); line-height: 1.6; }
.zygr-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-model-options] { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
[data-model-options] select { flex: 1; min-width: 0; padding: 7px 9px; border: 1px solid var(--zygr-line); border-radius: 8px; background: #fff; color: var(--zygr-text); font-size: 13px; }
.zygr-list { display: grid; gap: 8px; }
.zygr-item { display: flex; align-items: center; gap: 8px; border: 1px solid var(--zygr-line); border-radius: 12px; padding: 10px 12px; background: rgba(255,255,255,.7); cursor: pointer; transition: .18s; }
.zygr-item:hover { transform: translateY(-1px); box-shadow: 0 8px 18px rgba(15,23,42,.08); }
.zygr-item.zygr-selected { border-color: var(--zygr-primary); box-shadow: 0 0 0 2px var(--zygr-glow); }
.zygr-item-main { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.zygr-jump { flex: none; border: 1px solid var(--zygr-line); border-radius: 8px; padding: 3px 9px; background: #fff; color: var(--zygr-primary); font-size: 11px; line-height: 1.4; cursor: pointer; }
.zygr-jump:hover { border-color: var(--zygr-primary); background: var(--zygr-glow); }
.zygr-detail { white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.7; color: var(--zygr-muted); }
.zygr-empty { text-align: center; color: var(--zygr-muted); padding: 24px; }
.zygr-history-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 12px; align-items: start; }
.zygr-history-list, .zygr-history-detail { max-height: 52vh; overflow: auto; }
.zygr-history-detail { position: sticky; top: 0; }
@media (max-width: 720px) {
  .zygr-history-grid { grid-template-columns: 1fr; }
  .zygr-history-list { max-height: 30vh; }
  .zygr-history-detail { position: static; max-height: none; }
}
.zygr-cache-hint {
  display: block; width: 100%; margin-top: 8px; padding: 5px 9px;
  border-radius: 8px; border: 1px dashed rgba(180,83,9,.45);
  background: rgba(251,191,36,.14); color: #b45309;
  font-size: 11px; line-height: 1.5; text-align: left;
}
.zygr-cache-hint:hover { background: rgba(251,191,36,.24); }
.zygr-dialog.zygr-cache-dialog { width: min(520px, 100%); }
.zygr-dialog-body.zygr-cache-help-body { gap: 12px; font-size: 12px; line-height: 1.7; color: var(--zygr-muted); }
.zygr-cache-help-summary { margin: 0; color: var(--zygr-ink); }
.zygr-cache-help-impact {
  margin: 0; padding: 8px 10px; border-radius: 9px; line-height: 1.6;
  background: rgba(22,163,74,.10); border: 1px solid rgba(22,163,74,.22); color: #15803d;
}
.zygr-cache-help-section { display: grid; gap: 5px; }
.zygr-cache-help-section h3 { margin: 0; font-size: 13px; color: #3730a3; }
.zygr-cache-help-section ul { margin: 0; padding-left: 18px; display: grid; gap: 5px; }
@keyframes zygr-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@keyframes zygr-float { 0%,100% { transform: translate(0,0); } 50% { transform: translate(-18px,18px); } }
@media (max-width: 520px) {
  :host { left: 0; right: 0; bottom: 0; }
  .zygr-panel { width: 100%; max-height: 72vh; border-radius: 18px 18px 0 0; }
  .zygr-grid { grid-template-columns: 1fr; }
}
`;

