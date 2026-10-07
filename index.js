import {
    eventSource, event_types, setExtensionPrompt, saveSettingsDebounced,
    extension_prompt_types, extension_prompt_roles,
} from '../../../../script.js';
import { extension_settings, getContext } from '../../../extensions.js';

const MODULE = 'aftertaste';
const INJECT_KEY = 'AFTERTASTE_RELATIONSHIP_STATE';
const defaults = {
    enabled: true,
    apiBase: '',
    apiKey: '',
    model: '',
    interval: 5,
    recentMessages: 8,
    maxInjectTokens: 400,
    maxStateChars: 2400,
    temperature: 0.2,
    injectDepth: 2,
    states: {},
    lastAnalyzed: {},
    logs: [],
};
let busy = false;

function s() {
    extension_settings[MODULE] ??= structuredClone(defaults);
    for (const [k,v] of Object.entries(defaults)) if (extension_settings[MODULE][k] === undefined) extension_settings[MODULE][k] = structuredClone(v);
    return extension_settings[MODULE];
}
function chatKey() {
    const c = getContext();
    return String(c.chatId ?? c.getCurrentChatId?.() ?? `${c.characterId ?? 'none'}:${c.groupId ?? 'none'}`);
}
function state() {
    const k = chatKey();
    s().states[k] ??= { version:1, relationships:[], updatedAt:null, sourceMessageId:-1 };
    return s().states[k];
}
function esc(x='') { return String(x).replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])); }
function approxTokens(text='') { return Math.ceil(String(text).length / 3); }
function trimToBudget(text, budget) {
    const maxChars = Math.max(200, Number(budget||400) * 3);
    return text.length <= maxChars ? text : text.slice(0, maxChars).replace(/\s+\S*$/, '') + '\n[余味状态因预算截断]';
}
function buildInjection() {
    if (!s().enabled) return '';
    const st = state();
    if (!Array.isArray(st.relationships) || !st.relationships.length) return '';
    const lines = ['<aftertaste>', '以下是长期互动留下的关系/心理余味。它不是新剧情，也不是角色可直接读取的知识。只在与当前情境相关时自然影响反应；禁止复述、解释或强行触发。'];
    for (const r of st.relationships) {
        lines.push(`\n[${r.pair || '关系'}]`);
        if (r.surface) lines.push(`当前关系: ${r.surface}`);
        if (r.residue) lines.push(`情绪余留: ${r.residue}`);
        if (r.behavior_shift) lines.push(`行为偏移: ${r.behavior_shift}`);
        if (r.unresolved) lines.push(`未解决: ${r.unresolved}`);
        if (r.hidden) lines.push(`未明说/未完全自知: ${r.hidden}`);
        if (r.habit) lines.push(`形成习惯: ${r.habit}`);
    }
    lines.push('\n规则：过去应改变现在的措辞、选择、容忍阈值、注意力或行动优先级，而非机械闪回。没有相关触发时保持安静。', '</aftertaste>');
    return trimToBudget(lines.join('\n'), s().maxInjectTokens);
}
function refreshInjection() {
    const text = buildInjection();
    setExtensionPrompt(INJECT_KEY, text, extension_prompt_types.IN_CHAT, Number(s().injectDepth||2), false, extension_prompt_roles.SYSTEM);
    $('#aftertaste-injected').text(text || '（当前无注入）');
    $('#aftertaste-token-est').text(`约 ${approxTokens(text)} tokens（粗略估算）`);
}
function getRecentMessages() {
    const c = getContext();
    const arr = Array.isArray(c.chat) ? c.chat : [];
    return arr.slice(-Math.max(2, Number(s().recentMessages||8))).map((m,i)=>({
        id: arr.length - Math.max(2, Number(s().recentMessages||8)) + i,
        name: m.name || (m.is_user ? 'User' : 'Character'),
        role: m.is_user ? 'user' : 'assistant',
        text: String(m.mes || '').slice(0, 4000),
    }));
}
function normalizeBase(base) {
    return String(base||'').trim().replace(/\/+$/, '');
}
async function callAPI(messages, maxTokens=700) {
    const cfg=s();
    if (!cfg.apiBase || !cfg.model) throw new Error('请先填写 API Base URL 和模型 ID');
    const targetUrl = normalizeBase(cfg.apiBase).endsWith('/v1') ? `${normalizeBase(cfg.apiBase)}/chat/completions` : `${normalizeBase(cfg.apiBase)}/v1/chat/completions`;
    // Route external API calls through SillyTavern's built-in CORS proxy.
    // Requires enableCorsProxy: true in config.yaml and a server restart.
    const url = `/proxy/${targetUrl}`;
    addLog(`请求路径：SillyTavern CORS Proxy → ${targetUrl.replace(/\\?.*$/, '')}`);
    const headers={'Content-Type':'application/json'};
    if (cfg.apiKey) headers.Authorization=`Bearer ${cfg.apiKey}`;
    const controller = new AbortController();
    const timeoutMs = 120000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
        res = await fetch(url,{method:'POST',headers,body:JSON.stringify({model:cfg.model,messages,temperature:Number(cfg.temperature||0.2),max_tokens:maxTokens,stream:false}),signal:controller.signal});
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error(`API 请求超过 ${timeoutMs/1000} 秒，已自动终止`);
        throw e;
    } finally { clearTimeout(timer); }
    if(!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0,300)}`);
    const rawText = await res.text();
    let data;
    try { data = JSON.parse(rawText); } catch { throw new Error(`API 返回不是 JSON：${rawText.slice(0,220)}`); }
    const content = data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? '';
    if (!content) throw new Error(`API 返回成功但没有可读取的 content：${rawText.slice(0,220)}`);
    return content;
}
function parseJSON(text) {
    const cleaned=String(text).trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
    const a=cleaned.indexOf('{'), b=cleaned.lastIndexOf('}');
    if(a<0||b<a) throw new Error('分析 API 没有返回 JSON');
    return JSON.parse(cleaned.slice(a,b+1));
}
function sanitizeState(obj, sourceId) {
    const rels=Array.isArray(obj?.relationships)?obj.relationships.slice(0,12):[];
    const clean=rels.map(r=>({
        pair:String(r.pair||'').slice(0,100), surface:String(r.surface||'').slice(0,220),
        residue:String(r.residue||'').slice(0,260), behavior_shift:String(r.behavior_shift||'').slice(0,260),
        unresolved:String(r.unresolved||'').slice(0,260), hidden:String(r.hidden||'').slice(0,260), habit:String(r.habit||'').slice(0,220),
        confidence: Math.max(0,Math.min(1,Number(r.confidence??0.7))),
    })).filter(r=>r.pair && r.confidence>=0.55);
    let out={version:1,relationships:clean,updatedAt:new Date().toISOString(),sourceMessageId:sourceId};
    while(JSON.stringify(out).length>Number(s().maxStateChars||2400) && out.relationships.length>1) out.relationships.pop();
    return out;
}
async function analyze(force=false) {
    if(busy||!s().enabled) return;
    const c=getContext(), arr=Array.isArray(c.chat)?c.chat:[];
    if(!arr.length) return;
    const key=chatKey(), last=Number(s().lastAnalyzed[key]??-1), newest=arr.length-1;
    if(!force && newest-last < Number(s().interval||5)) return;
    busy=true; setStatus('准备分析…'); addLog(`开始手动/周期分析：最近 ${Math.min(arr.length, Number(s().recentMessages||8))} 条消息；来源楼层 ${newest}`);
    try {
        const current=state();
        const recent=getRecentMessages();
        addLog(`已读取 ${recent.length} 条消息，约 ${approxTokens(JSON.stringify(recent))} tokens（粗估）`);
        setStatus('请求 API…');
        const system=`你是长期角色扮演的“关系余味状态压缩器”。你的任务不是总结剧情，而是维护一个极小、可更新的关系心理状态。\n\n硬规则：\n1. 没有充分证据就不要新增永久状态；普通寒暄、递东西、一般关心默认不构成长期变化。\n2. 只保留会影响未来行为的残留：关系阶段、未解决矛盾、行为偏移、形成习惯、未明说/未完全自知的情绪。\n3. 不得把推测写成事实；不创造童年创伤、依恋类型、秘密、诊断或过去事件。\n4. 旧状态应更新/合并/删除，不要无限追加。关系已经变化时覆盖旧结论。\n5. 深度不等于戏剧化。允许“无变化”。\n6. 输出必须是严格 JSON，不要 markdown。最多12组关系，每字段尽量一句。confidence<0.55的内容不要保留。\n\nJSON格式：{"changed":true/false,"relationships":[{"pair":"A→B 或 A↔B","surface":"","residue":"","behavior_shift":"","unresolved":"","hidden":"","habit":"","confidence":0.0}]}`;
        const user=`当前已有状态：\n${JSON.stringify(current.relationships)}\n\n最近消息：\n${JSON.stringify(recent.map(m => ({...m, text: m.text.slice(0, 1800)})))}\n\n请基于最近消息更新已有状态。若没有足以留下长期余味的新证据，尽量保持原状态并令 changed=false。`;
        addLog('已发送分析请求，等待 API 返回…');
        const raw=await callAPI([{role:'system',content:system},{role:'user',content:user}],600);
        addLog(`API 已返回：${raw.length} 字符；正在解析 JSON…`);
        setStatus('解析结果…');
        const obj=parseJSON(raw);
        if(obj.changed!==false) s().states[key]=sanitizeState(obj,newest);
        s().lastAnalyzed[key]=newest;
        addLog(`JSON 解析成功；分析完成：${obj.changed===false?'无长期变化':'状态已更新'}；来源楼层 ${newest}`);
        saveSettingsDebounced(); refreshInjection(); renderState(); setStatus('就绪');
    } catch(e) { console.error('[Aftertaste]',e); addLog(`分析失败：${e?.name||'Error'}：${e?.message||String(e)}`); setStatus('错误'); toastr?.error?.(`Aftertaste: ${e.message}`); }
    finally { busy=false; }
}
function addLog(msg){ const x=`${new Date().toLocaleTimeString()} ${msg}`; s().logs.unshift(x); s().logs=s().logs.slice(0,30); $('#aftertaste-log').text(s().logs.join('\n')); }
function setStatus(x){ $('#aftertaste-status').text(x); }
function renderState(){ $('#aftertaste-state').val(JSON.stringify(state(),null,2)); refreshInjection(); }
async function testAPI(){ setStatus('测试中…'); try{ const x=await callAPI([{role:'user',content:'只回复 OK'}],16); setStatus('API 可用'); toastr?.success?.(`Aftertaste API连接成功：${String(x).slice(0,50)}`);}catch(e){setStatus('API失败');toastr?.error?.(e.message);} }
function bind() {
    const cfg=s();
    $('#aftertaste-enabled').prop('checked',cfg.enabled); $('#aftertaste-api-base').val(cfg.apiBase); $('#aftertaste-api-key').val(cfg.apiKey); $('#aftertaste-model').val(cfg.model);
    $('#aftertaste-interval').val(cfg.interval); $('#aftertaste-recent').val(cfg.recentMessages); $('#aftertaste-budget').val(cfg.maxInjectTokens); $('#aftertaste-depth').val(cfg.injectDepth);
    $('#aftertaste-temp').val(cfg.temperature);
    $('#aftertaste-settings input').on('change input', function(){
        cfg.enabled=$('#aftertaste-enabled').prop('checked'); cfg.apiBase=$('#aftertaste-api-base').val().trim(); cfg.apiKey=$('#aftertaste-api-key').val().trim(); cfg.model=$('#aftertaste-model').val().trim();
        cfg.interval=Math.max(1,Number($('#aftertaste-interval').val()||5)); cfg.recentMessages=Math.max(2,Number($('#aftertaste-recent').val()||8)); cfg.maxInjectTokens=Math.max(100,Number($('#aftertaste-budget').val()||400)); cfg.injectDepth=Math.max(0,Number($('#aftertaste-depth').val()||2)); cfg.temperature=Number($('#aftertaste-temp').val()||0.2);
        saveSettingsDebounced(); refreshInjection();
    });
    $('#aftertaste-test').on('click',testAPI); $('#aftertaste-analyze').on('click',()=>analyze(true));
    $('#aftertaste-save-state').on('click',()=>{try{s().states[chatKey()]=sanitizeState(JSON.parse($('#aftertaste-state').val()),state().sourceMessageId);saveSettingsDebounced();renderState();toastr?.success?.('余味状态已保存');}catch(e){toastr?.error?.(`JSON错误：${e.message}`);}});
    $('#aftertaste-clear').on('click',()=>{if(confirm('清空当前聊天的余味状态？')){s().states[chatKey()]={version:1,relationships:[],updatedAt:null,sourceMessageId:-1};s().lastAnalyzed[chatKey()]=-1;saveSettingsDebounced();renderState();}});
    $('#aftertaste-log').text(cfg.logs.join('\n'));
}
function addUI(){
    if($('#aftertaste-settings').length) return;
    $('#extensions_settings').append(`<div id="aftertaste-settings" class="extension_container"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🍷 Aftertaste · 余味</b><span id="aftertaste-status">就绪</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label><input id="aftertaste-enabled" type="checkbox"> 启用</label><p class="notes">只维护“事件留下的关系/心理结果”，不做第二套全文记忆库。</p><label>API Base URL<input id="aftertaste-api-base" class="text_pole" placeholder="https://example.com"></label><label>API Key<input id="aftertaste-api-key" class="text_pole" type="password" autocomplete="off"></label><label>模型 ID<input id="aftertaste-model" class="text_pole" placeholder="gemini-... / gpt-..."></label><div class="aftertaste-grid"><label>每 N 楼分析<input id="aftertaste-interval" type="number" min="1"></label><label>分析最近消息数<input id="aftertaste-recent" type="number" min="2" max="30"></label><label>注入预算(tokens)<input id="aftertaste-budget" type="number" min="100" max="2000"></label><label>注入深度<input id="aftertaste-depth" type="number" min="0" max="20"></label><label>分析温度<input id="aftertaste-temp" type="number" min="0" max="2" step="0.1"></label></div><div class="aftertaste-buttons"><button id="aftertaste-test" class="menu_button">测试 API</button><button id="aftertaste-analyze" class="menu_button">立即分析</button><button id="aftertaste-clear" class="menu_button">清空当前状态</button></div><h4>当前聊天余味状态</h4><textarea id="aftertaste-state" class="text_pole" rows="12"></textarea><button id="aftertaste-save-state" class="menu_button">保存手动修改</button><h4>本轮实际注入</h4><div id="aftertaste-token-est" class="notes"></div><pre id="aftertaste-injected"></pre><h4>运行进度 / 日志（不记录 API Key）</h4><pre id="aftertaste-log"></pre><p class="notes">v0.1.4：外部 API 请求经 SillyTavern CORS Proxy 转发；分析输入额外压缩，并使用 120 秒超时。</p></div></div></div>`);
    bind(); renderState();
}
function reconcileAfterEdit(){
    const st=state(), c=getContext(), newest=(c.chat?.length??0)-1;
    if(Number(st.sourceMessageId)>newest){ s().states[chatKey()]={version:1,relationships:[],updatedAt:null,sourceMessageId:-1}; s().lastAnalyzed[chatKey()]=-1; addLog('检测到消息回退到已分析来源之前：为避免幽灵状态，已清空当前余味；请重新分析。'); saveSettingsDebounced(); }
    refreshInjection(); renderState();
}
export function init(){
    s(); addUI();
    eventSource.on(event_types.GENERATION_STARTED, refreshInjection);
    eventSource.on(event_types.MESSAGE_RECEIVED, ()=>analyze(false));
    eventSource.on(event_types.CHAT_CHANGED, ()=>setTimeout(()=>{renderState();refreshInjection();},100));
    eventSource.on(event_types.MESSAGE_DELETED, reconcileAfterEdit);
    eventSource.on(event_types.MESSAGE_EDITED, reconcileAfterEdit);
    eventSource.on(event_types.MESSAGE_SWIPED, ()=>{ addLog('检测到 swipe：将在下一次分析周期用当前文本更新状态。'); });
    refreshInjection();
    console.log('[Aftertaste] v0.1.4 initialized');
}


// SillyTavern 1.14.0 does not dispatch manifest lifecycle hooks.
// Initialize once on DOM ready, with APP_READY as an idempotent fallback.
let aftertasteInitialized = false;
async function initOnce() {
    if (aftertasteInitialized) return;
    aftertasteInitialized = true;
    try {
        init();
    } catch (error) {
        aftertasteInitialized = false;
        console.error('[Aftertaste] startup failed:', error);
        if (globalThis.toastr?.error) globalThis.toastr.error(`Aftertaste 启动失败: ${error?.message || error}`);
        throw error;
    }
}

jQuery(initOnce);
eventSource.once(event_types.APP_READY, initOnce);
