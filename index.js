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
    maxActiveRelationships: 3,
    logs: [],
    generationAudit: {},
    // ST-iPhonie companion: keep the main RP prompt tiny, then direct TTS prosody only when a line is actually generated.
    iphonieCompactPrompt: true,
    iphonieDirectorEnabled: true,
    iphonieDirectorMaxContext: 2200,
};
let busy = false;

const iphonieRuntime = {
    cache: new Map(),
    lastPrompt: null,
    lastDirector: null,
    fetchWrapped: false,
    nativeFetch: null,
};

const IPHONE_COMPACT_RULE = [
    '【ST-iPhonie 配音格式 · 低 Token】',
    '正文与叙事照常写，不改变角色人设、文风或剧情。',
    '每次角色真正说出口的中文台词写成：“台词”<tts>实际角色名|同一句台词</tts>。',
    '旁白、动作、环境、心理活动保持普通正文；未说出口的内容不要加标签。',
    '不要在正文里写情绪标签、TTS 厂商标签、呼吸声标签或停顿码；这些由播放时的情绪导演单独处理。'
].join('\n');

function compactIphonieText(text) {
    let out = String(text ?? '');
    const before = out;
    // Shipped ST-iPhonie default prompt.
    out = out.replace(
        /正常续写正文与叙事，不要改变角色人设或写作风格。\s*每一次角色真正说出口的台词，[\s\S]*?不要解释规则或输出代码块，不为未说出口的内容生成语音标签。/g,
        ''
    );
    // Huge per-engine emotion / sound-tag manuals.
    out = out.replace(
        /各说话者的朗读规则（只用于台词，不改变人物设定）：[\s\S]*?(?=\n\n【对白输出硬性规则】)/g,
        ''
    );
    // Long format contract.
    out = out.replace(
        /【对白输出硬性规则】[\s\S]*?直接输出检查后的正文，不输出核对过程。/g,
        IPHONE_COMPACT_RULE
    );
    if (out !== before && !out.includes('ST-iPhonie 配音格式 · 低 Token')) {
        out = out.trim() + '\n\n' + IPHONE_COMPACT_RULE;
    }
    return { text: out, changed: out !== before, saved: Math.max(0, before.length - out.length) };
}

function compactIphonieRequest(data) {
    if (!s().iphonieCompactPrompt || !Array.isArray(data?.messages)) return;
    let changed = 0, saved = 0;
    for (const message of data.messages) {
        if (!message || typeof message.content !== 'string') continue;
        const source = message.content;
        if (!source.includes('各说话者的朗读规则') && !source.includes('【对白输出硬性规则】') && !source.includes('每一次角色真正说出口的台词')) continue;
        const result = compactIphonieText(source);
        if (!result.changed) continue;
        message.content = result.text;
        changed++;
        saved += result.saved;
    }
    if (changed) {
        iphonieRuntime.lastPrompt = { at: Date.now(), changed, saved };
        renderIphonieStatus();
    }
}

function decodeVoiceText(text='') {
    return String(text)
        .replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

const MINI_CUES = new Set(['laughs','chuckle','coughs','clear-throat','groans','breath','pant','inhale','exhale','gasps','sniffs','sighs','snorts','burps','lip-smacking','humming','hissing','emm','sneezes']);
const GENERIC_CUES = new Set(['breath','sigh','chuckle','laugh','inhale','exhale','gasp','sniff','emm']);
const DIRECTOR_EMOTIONS = new Set(['neutral','happy','sad','angry','fearful','disgusted','surprised','calm']);

function stripKnownProsody(text='') {
    return String(text)
        .replace(/<#\d+(?:\.\d+)?#>/g, '')
        .replace(/\(([^()]{1,40})\)/g, (m, inner) => MINI_CUES.has(String(inner).trim().toLowerCase()) ? '' : m)
        .replace(/\[[a-z][^\]\n]{0,70}\]/gi, '')
        .replace(/^\s*\((?:开心|悲伤|愤怒|恐惧|惊讶|兴奋|委屈|平静|冷漠|怅然|欣慰|无奈|愧疚|释然|嫉妒|厌倦|忐忑|动情|温柔|高冷|活泼|严肃|慵懒|俏皮|深沉|干练|凌厉)\)\s*/u, '')
        .trim();
}

function canonicalSpeech(text='') {
    return stripKnownProsody(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function taggedVoiceLines(raw='') {
    const list = [];
    for (const match of String(raw).matchAll(/<tts>([^<]{1,6000}?)<\/tts>/gi)) {
        const parts = match[1].split('|');
        if (parts.length < 2 || parts.length > 3) continue;
        const role = decodeVoiceText(parts[0]).trim();
        const emotion = parts.length === 3 ? decodeVoiceText(parts[1]).trim() : '';
        const text = decodeVoiceText(parts.at(-1)).trim();
        if (!role || !text) continue;
        list.push({ index: list.length, at: match.index ?? 0, end: (match.index ?? 0) + match[0].length, role, emotion, text });
    }
    return list;
}

function trimPlainContext(raw, at, end, maxChars) {
    const half = Math.max(500, Math.floor(maxChars / 2));
    const from = Math.max(0, Number(at || 0) - half);
    const to = Math.min(String(raw).length, Number(end || 0) + half);
    return String(raw).slice(from, to)
        .replace(/<tts>[^<]*<\/tts>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s{3,}/g, '\n\n')
        .trim()
        .slice(0, maxChars);
}

function findIphonieStoryContext(targetText) {
    const ctx = getContext();
    const chat = Array.isArray(ctx?.chat) ? ctx.chat : [];
    const wanted = canonicalSpeech(targetText);
    if (!wanted) return null;
    for (let i = chat.length - 1; i >= Math.max(0, chat.length - 20); i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        const raw = String(message.mes || '');
        const lines = taggedVoiceLines(raw);
        for (const line of lines) {
            const got = canonicalSpeech(line.text);
            if (!got || !(got === wanted || (Math.min(got.length, wanted.length) >= 6 && (got.includes(wanted) || wanted.includes(got))))) continue;
            let previousUser = '';
            for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
                if (chat[j]?.is_user) { previousUser = String(chat[j].mes || ''); break; }
            }
            const speaker = line.role;
            const card = ctx.characters?.find?.(c => c?.name === speaker);
            const profile = card ? [card.description, card.personality].filter(Boolean).join('\n').slice(0, 800) : '';
            return {
                chat: chatKey(), messageId: i, lineIndex: line.index, speaker,
                target: stripKnownProsody(targetText),
                current: trimPlainContext(raw, line.at, line.end, Number(s().iphonieDirectorMaxContext || 2200)),
                previousUser: previousUser.replace(/<[^>]+>/g, ' ').slice(-700),
                profile,
            };
        }
    }
    return null;
}

function directorCacheSet(key, value) {
    iphonieRuntime.cache.delete(key);
    iphonieRuntime.cache.set(key, value);
    while (iphonieRuntime.cache.size > 120) iphonieRuntime.cache.delete(iphonieRuntime.cache.keys().next().value);
}

function stripGenericTokens(text='') {
    return String(text).replace(/<(?:pause=\d+(?:\.\d+)?|breath|sigh|chuckle|laugh|inhale|exhale|gasp|sniff|emm)>/gi, '');
}

function sanitizeDirectorAnnotated(original, annotated) {
    let count = 0;
    let text = String(annotated || original).replace(/<(pause=\d+(?:\.\d+)?|breath|sigh|chuckle|laugh|inhale|exhale|gasp|sniff|emm)>/gi, (whole, token) => {
        if (++count > 5) return '';
        const lower = String(token).toLowerCase();
        if (lower.startsWith('pause=')) {
            const n = Math.max(0.12, Math.min(0.9, Number(lower.slice(6)) || 0.3));
            return '<pause=' + Math.round(n * 100) / 100 + '>';
        }
        return GENERIC_CUES.has(lower) ? '<' + lower + '>' : '';
    });
    // Drop any invented angle-bracket instruction. The spoken words themselves must stay the same.
    text = text.replace(/<(?!pause=|breath>|sigh>|chuckle>|laugh>|inhale>|exhale>|gasp>|sniff>|emm>)[^>\n]{1,80}>/gi, '');
    const plainOriginal = canonicalSpeech(original);
    const plainDirected = stripGenericTokens(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    return plainOriginal && plainOriginal === plainDirected ? text : original;
}

function parseDirectorJSON(raw, original) {
    const obj = parseJSON(raw);
    const emotion = DIRECTOR_EMOTIONS.has(String(obj.emotion || '').toLowerCase()) ? String(obj.emotion).toLowerCase() : 'neutral';
    const delivery = /^[a-z][a-z ,'-]{0,70}$/i.test(String(obj.delivery_en || '').trim()) ? String(obj.delivery_en).trim().toLowerCase() : '';
    const style = String(obj.style_zh || '').replace(/[()（）[\]<>]/g, '').trim().slice(0, 12);
    const annotated = sanitizeDirectorAnnotated(original, obj.annotated);
    return { emotion, delivery, style, annotated };
}

async function directIphonieLine(engine, model, story) {
    if (!s().iphonieDirectorEnabled || !story || !s().apiBase || !s().model) return null;
    const key = [story.chat, story.messageId, story.lineIndex, engine, model, canonicalSpeech(story.target)].join('|');
    if (iphonieRuntime.cache.has(key)) {
        const hit = iphonieRuntime.cache.get(key);
        iphonieRuntime.lastDirector = { ...hit, at: Date.now(), cached: true, speaker: story.speaker, engine, model };
        renderIphonieStatus();
        return hit;
    }
    const system = [
        '你是中文角色扮演的 TTS 表演导演。只决定“这句话怎么念”，不改剧情、不改台词。',
        '根据角色、上一轮用户、当前回复里的动作/旁白和目标台词判断真实口语表演。',
        '真人感优先：不要把每句话都演得很重；没有明确情绪时 emotion=neutral。亲密、嘴硬、疲惫、犹豫等细节优先用少量自然停顿或呼吸体现，而不是夸张标签。',
        'annotated 必须保留目标台词的全部文字和顺序，只允许插入以下标记：<pause=0.30>、<breath>、<sigh>、<chuckle>、<laugh>、<inhale>、<exhale>、<gasp>、<sniff>、<emm>。',
        '一条台词最多 5 个标记，通常 0–2 个就够。不要机械地每句叹气、喘息、耳语或加停顿。pause 建议 0.15–0.65 秒，只有明显停顿才更长。',
        'emotion 只能是 neutral, happy, sad, angry, fearful, disgusted, surprised, calm 之一。',
        'delivery_en 用 1–6 个英文词描述声音表演，例如 soft, slightly tired；style_zh 用 1–2 个中文词概括语气。',
        '只输出严格 JSON：{"emotion":"neutral","delivery_en":"","style_zh":"","annotated":"原台词"}，不要 Markdown。'
    ].join('\n');
    const user = [
        '说话者：' + story.speaker,
        story.profile ? '角色设定摘要：' + story.profile : '',
        story.previousUser ? '上一轮用户：' + story.previousUser : '',
        '当前回复片段：' + story.current,
        '目标台词：' + story.target,
        '当前语音引擎：' + engine + ' ' + model
    ].filter(Boolean).join('\n\n');
    try {
        const raw = await callAPI([{role:'system',content:system},{role:'user',content:user}], 220, true);
        const result = parseDirectorJSON(raw, story.target);
        directorCacheSet(key, result);
        iphonieRuntime.lastDirector = { ...result, at: Date.now(), cached: false, speaker: story.speaker, engine, model };
        renderIphonieStatus();
        return result;
    } catch (error) {
        iphonieRuntime.lastDirector = { at: Date.now(), error: error?.message || String(error), speaker: story.speaker, engine, model };
        renderIphonieStatus();
        return null;
    }
}

function genericTokenMap(text, engine, model) {
    const miniMap = {breath:'breath',sigh:'sighs',chuckle:'chuckle',laugh:'laughs',inhale:'inhale',exhale:'exhale',gasp:'gasps',sniff:'sniffs',emm:'emm'};
    const fishS1Map = {breath:'',sigh:'(sighing)',chuckle:'(chuckling)',laugh:'(laughing)',inhale:'',exhale:'',gasp:'(gasping)',sniff:'',emm:''};
    const mimoMap = {breath:'[深呼吸]',sigh:'[叹气]',chuckle:'[轻笑]',laugh:'[笑]',inhale:'[吸气]',exhale:'[呼气]',gasp:'[震惊]',sniff:'[鼻音]',emm:'[心虚]'};
    return String(text).replace(/<(pause=\d+(?:\.\d+)?|breath|sigh|chuckle|laugh|inhale|exhale|gasp|sniff|emm)>/gi, (whole, token) => {
        const lower = String(token).toLowerCase();
        if (lower.startsWith('pause=')) {
            const sec = Math.max(0.12, Math.min(0.9, Number(lower.slice(6)) || 0.3));
            if (engine === 'mini') return '<#' + (Math.round(sec * 100) / 100) + '#>';
            if (engine === 'fish' && String(model).includes('s1')) return sec >= 0.5 ? '(long-break)' : '(break)';
            return sec >= 0.45 ? '……' : '…';
        }
        if (engine === 'mini') return String(model).startsWith('speech-2.8') && miniMap[lower] ? '(' + miniMap[lower] + ')' : '';
        if (engine === 'mimo') return mimoMap[lower] || '';
        if (engine === 'fish' && String(model).includes('s1')) return fishS1Map[lower] || '';
        const square = {breath:'breath',sigh:'sigh',chuckle:'chuckles',laugh:'laughs',inhale:'inhales',exhale:'exhales',gasp:'gasps',sniff:'sniffs',emm:'hesitates'}[lower];
        return square ? '[' + square + '] ' : '';
    });
}

function directedTextFor(engine, model, result) {
    let text = genericTokenMap(result.annotated, engine, model);
    if (engine === 'fish' && !String(model).includes('s1') && result.delivery) text = '[' + result.delivery + '] ' + text;
    if (engine === 'eleven' && /^eleven_v[34]/.test(String(model)) && result.delivery) text = '[' + result.delivery + '] ' + text;
    if (engine === 'mimo' && result.style) text = '(' + result.style + ')' + text;
    if (engine === 'fish' && String(model).includes('s1') && result.emotion !== 'neutral') {
        const allowed = new Set(['happy','sad','angry','excited','calm','nervous','confident','surprised','satisfied','delighted','scared','worried','upset','frustrated','depressed','empathetic','embarrassed','disgusted','moved','proud','relaxed','grateful','curious','sarcastic','disdainful','unhappy','anxious','hysterical','indifferent','uncertain','doubtful','confused','disappointed','regretful','guilty','ashamed','jealous','envious','hopeful','optimistic','pessimistic','nostalgic','lonely','bored','contemptuous','sympathetic','compassionate','determined','resigned']);
        const e = result.emotion === 'fearful' ? 'scared' : result.emotion;
        if (allowed.has(e)) text = '(' + e + ') ' + text;
    }
    return text;
}

function iphonieTtsInfo(url, body) {
    const u = String(url || '');
    if (body?.model && /^speech-/.test(body.model) && /\/v1\/t2a_v2(?:\?|$)/i.test(u) && typeof body.text === 'string') return {engine:'mini', model:body.model, text:body.text};
    if (body?.model && /^mimo-v2\.5-tts/.test(body.model) && /chat\/completions/i.test(u) && Array.isArray(body.messages)) {
        const msg = [...body.messages].reverse().find(m => m?.role === 'assistant' && typeof m.content === 'string');
        if (msg) return {engine:'mimo', model:body.model, text:msg.content, message:msg};
    }
    if (typeof body?.model_id === 'string' && /^eleven_/.test(body.model_id) && /\/v1\/text-to-speech\//i.test(u) && typeof body.text === 'string') return {engine:'eleven', model:body.model_id, text:body.text};
    if (typeof body?.input === 'string' && /audio\/speech/i.test(u)) {
        const model = String(body.model || body.provider?.options?.['fish-audio']?.model || '');
        if (/fish|s2|s1|drama/i.test(model) || body.provider?.options?.['fish-audio']) return {engine:'fish', model:model.replace(/^fish-audio\//,''), text:body.input};
    }
    return null;
}

async function maybeDirectIphonieFetch(input, init) {
    if (!s().iphonieDirectorEnabled || typeof init?.body !== 'string') return init;
    let body;
    try { body = JSON.parse(init.body); } catch { return init; }
    const info = iphonieTtsInfo(typeof input === 'string' ? input : input?.url, body);
    if (!info) return init;
    const cleanTarget = stripKnownProsody(info.text);
    const story = findIphonieStoryContext(cleanTarget);
    if (!story) return init; // engine auditions / phone calls / unrelated TTS are untouched.
    const directed = await directIphonieLine(info.engine, info.model, { ...story, target: cleanTarget });
    if (!directed) return init;
    const next = structuredClone(body);
    const spoken = directedTextFor(info.engine, info.model, directed);
    if (info.engine === 'mini') {
        next.text = spoken;
        next.voice_setting ??= {};
        if (!next.voice_setting.emotion && directed.emotion !== 'neutral') next.voice_setting.emotion = directed.emotion;
    } else if (info.engine === 'fish') {
        next.input = spoken;
    } else if (info.engine === 'eleven') {
        next.text = spoken;
    } else if (info.engine === 'mimo') {
        const msg = [...next.messages].reverse().find(m => m?.role === 'assistant' && typeof m.content === 'string');
        if (msg) msg.content = spoken;
    }
    return { ...init, body: JSON.stringify(next) };
}

function installIphonieFetchDirector() {
    if (iphonieRuntime.fetchWrapped) return;
    iphonieRuntime.fetchWrapped = true;
    iphonieRuntime.nativeFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async function(input, init) {
        let next = init;
        try { next = await maybeDirectIphonieFetch(input, init); } catch (error) {
            iphonieRuntime.lastDirector = { at: Date.now(), error: error?.message || String(error) };
            renderIphonieStatus();
        }
        return iphonieRuntime.nativeFetch(input, next);
    };
}

function renderIphonieStatus() {
    const box = $('#aftertaste-iphonie-status');
    if (!box.length) return;
    const detected = !!document.querySelector('#sttts-extension-entry');
    const p = iphonieRuntime.lastPrompt, d = iphonieRuntime.lastDirector;
    const lines = [
        'ST-iPhonie：' + (detected ? '已检测到' : '暂未检测到'),
        '低 Token：' + (s().iphonieCompactPrompt ? '开' : '关') + (p ? ' · 最近压缩约 ' + Math.ceil((p.saved || 0) / 3) + ' tokens（粗估）' : ''),
        '情绪导演：' + (s().iphonieDirectorEnabled ? '开' : '关') + (s().apiBase && s().model ? ' · 使用上方 Aftertaste API' : ' · 未配置上方 API')
    ];
    if (d?.error) lines.push('最近导演：失败 · ' + d.error);
    else if (d) {
        lines.push('最近导演：' + (d.speaker || '') + ' · ' + (d.engine || '') + ' ' + (d.model || '') + ' · emotion=' + d.emotion + (d.cached ? ' · 缓存' : ''));
        lines.push('实际表演稿：' + String(d.annotated || '').slice(0, 260));
    }
    box.text(lines.join('\n'));
}

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
    s().states[k] ??= { version:2, relationships:[], updatedAt:null, sourceMessageId:-1 };
    if (s().states[k].version !== 2) {
        s().states[k] = { ...s().states[k], version:2, relationships:(s().states[k].relationships||[]).map(r=>({...r,status:r.status||'dormant',lastTouched:r.lastTouched??s().states[k].sourceMessageId??-1})) };
    }
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
    const active = st.relationships.filter(r=>r.status==='active').slice(0, Number(s().maxActiveRelationships||3));
    if (!active.length) return '';
    for (const r of active) {
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
function currentActivePairs() {
    return state().relationships.filter(r=>r.status==='active').slice(0, Number(s().maxActiveRelationships||3)).map(r=>r.pair);
}
function recordGenerationInjection() {
    const key=chatKey(), text=buildInjection(), c=getContext(), newest=(c.chat?.length??0)-1;
    const rec={time:new Date().toISOString(), sourceMessageId:newest, injected:!!text, pairs:currentActivePairs(), approxTokens:approxTokens(text), placement:'IN_CHAT / depth '+Number(s().injectDepth||2)+' / SYSTEM'};
    s().generationAudit[key]=rec; saveSettingsDebounced(); renderGenerationAudit();
}
function renderGenerationAudit() {
    const rec=s().generationAudit?.[chatKey()];
    if(!rec){ $('#aftertaste-generation-audit').text('（尚无生成记录）'); return; }
    $('#aftertaste-generation-audit').text(`${new Date(rec.time).toLocaleTimeString()}\n生成来源楼层：${rec.sourceMessageId}\n注入：${rec.injected?'是':'否'}\n关系：${rec.pairs?.join('、')||'无'}\n实际注入：约 ${rec.approxTokens} tokens\n位置：${rec.placement}`);
}
function wakeDormantFromRecentText() {
    const st=state(), c=getContext(), arr=Array.isArray(c.chat)?c.chat:[];
    const text=arr.slice(-2).map(m=>`${m.name||''}\n${m.mes||''}`).join('\n');
    let changed=false;
    for(const r of st.relationships){
        if(r.status!=='dormant') continue;
        const names=String(r.pair||'').split(/[↔→←&、,，/|]+/).map(x=>x.trim()).filter(x=>x.length>=2);
        if(names.some(n=>text.includes(n))){ r.status='active'; changed=true; }
    }
    if(changed){ st.updatedAt=new Date().toISOString(); saveSettingsDebounced(); addLog('检测到休眠关系角色重新出现：已提前唤醒对应余味，无需等待5楼分析。'); }
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
async function callAPI(messages, maxTokens=700, quiet=false) {
    const cfg=s();
    if (!cfg.apiBase || !cfg.model) throw new Error('请先填写 API Base URL 和模型 ID');
    const targetUrl = normalizeBase(cfg.apiBase).endsWith('/v1') ? `${normalizeBase(cfg.apiBase)}/chat/completions` : `${normalizeBase(cfg.apiBase)}/v1/chat/completions`;
    // Route external API calls through SillyTavern's built-in CORS proxy.
    // Requires enableCorsProxy: true in config.yaml and a server restart.
    const url = `/proxy/${targetUrl}`;
    if (!quiet) addLog(`请求路径：SillyTavern CORS Proxy → ${targetUrl.replace(/\\?.*$/, '')}`);
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
function cleanRel(r, sourceId) {
    return {
        pair:String(r.pair||'').slice(0,100), surface:String(r.surface||'').slice(0,220),
        residue:String(r.residue||'').slice(0,260), behavior_shift:String(r.behavior_shift||'').slice(0,260),
        unresolved:String(r.unresolved||'').slice(0,260), hidden:String(r.hidden||'').slice(0,260), habit:String(r.habit||'').slice(0,220),
        confidence:Math.max(0,Math.min(1,Number(r.confidence??0.7))),
        status:r.status==='active'?'active':'dormant', lastTouched:Number(r.lastTouched??sourceId),
    };
}
function mergeState(obj, sourceId) {
    const prev=state();
    const map=new Map((prev.relationships||[]).map(r=>[String(r.pair||'').trim(),{...r,status:'dormant'}]));
    for (const raw of (Array.isArray(obj?.relationships)?obj.relationships:[])) {
        const r=cleanRel(raw,sourceId); if(!r.pair||r.confidence<0.55) continue;
        const old=map.get(r.pair)||{};
        map.set(r.pair,{...old,...r,status:'active',lastTouched:sourceId});
    }
    for (const pair of (Array.isArray(obj?.resolved)?obj.resolved:[])) map.delete(String(pair).trim());
    let rels=[...map.values()].sort((x,y)=>(y.status==='active')-(x.status==='active')||(y.lastTouched??-1)-(x.lastTouched??-1));
    // Storage may be larger than injection; cap only pathological growth.
    rels=rels.slice(0,40);
    return {version:2,relationships:rels,updatedAt:new Date().toISOString(),sourceMessageId:sourceId};
}
function sanitizeState(obj, sourceId) {
    const rels=(Array.isArray(obj?.relationships)?obj.relationships:[]).map(r=>cleanRel(r,sourceId)).filter(r=>r.pair&&r.confidence>=0.55).slice(0,40);
    return {version:2,relationships:rels,updatedAt:new Date().toISOString(),sourceMessageId:sourceId};
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
        const system=`你是长期角色扮演的“关系余味状态压缩器”。你的任务不是总结剧情，而是维护一个极小、可更新的关系心理状态。\n\n硬规则：\n1. 没有充分证据就不要新增永久状态；普通寒暄、递东西、一般关心默认不构成长期变化。\n2. 只保留会影响未来行为的残留：关系阶段、未解决矛盾、行为偏移、形成习惯、未明说/未完全自知的情绪。\n3. 不得把推测写成事实；不创造童年创伤、依恋类型、秘密、诊断或过去事件。\n4. 你只返回“最近消息中实际被触碰/改变的关系”，不要重写全部旧关系。未出现的角色不要返回，也绝不能视为遗忘。
5. 只有当某段旧余味在最近消息中被明确解决、失效或推翻时，才把对应 pair 放进 resolved 数组。角色离场、最近没出现，不算 resolved。\n5. 深度不等于戏剧化。允许“无变化”。\n6. 输出必须是严格 JSON，不要 markdown。最多12组关系，每字段尽量一句。confidence<0.55的内容不要保留。\n\nJSON格式：{"changed":true/false,"relationships":[{"pair":"A→B 或 A↔B","surface":"","residue":"","behavior_shift":"","unresolved":"","hidden":"","habit":"","confidence":0.0}]}`;
        const user=`当前已有状态：\n${JSON.stringify(current.relationships)}\n\n最近消息：\n${JSON.stringify(recent.map(m => ({...m, text: m.text.slice(0, 1800)})))}\n\n请基于最近消息输出“增量更新”。旧状态只是参考：没有在最近消息中出现的旧关系不要复制到 relationships，也不要删除；只有真正解决才写入 resolved。若没有足以留下长期余味的新证据，令 changed=false。`;
        addLog('已发送分析请求，等待 API 返回…');
        const raw=await callAPI([{role:'system',content:system},{role:'user',content:user}],600);
        addLog(`API 已返回：${raw.length} 字符；正在解析 JSON…`);
        setStatus('解析结果…');
        const obj=parseJSON(raw);
        if(obj.changed!==false) s().states[key]=mergeState(obj,newest);
        s().lastAnalyzed[key]=newest;
        addLog(`JSON 解析成功；分析完成：${obj.changed===false?'无长期变化':'增量状态已合并'}；来源楼层 ${newest}`);
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
    $('#aftertaste-iphonie-compact').prop('checked',cfg.iphonieCompactPrompt !== false);
    $('#aftertaste-iphonie-director').prop('checked',cfg.iphonieDirectorEnabled !== false);
    $('#aftertaste-settings input').on('change input', function(){
        cfg.enabled=$('#aftertaste-enabled').prop('checked'); cfg.apiBase=$('#aftertaste-api-base').val().trim(); cfg.apiKey=$('#aftertaste-api-key').val().trim(); cfg.model=$('#aftertaste-model').val().trim();
        cfg.interval=Math.max(1,Number($('#aftertaste-interval').val()||5)); cfg.recentMessages=Math.max(2,Number($('#aftertaste-recent').val()||8)); cfg.maxInjectTokens=Math.max(100,Number($('#aftertaste-budget').val()||400)); cfg.injectDepth=Math.max(0,Number($('#aftertaste-depth').val()||2)); cfg.temperature=Number($('#aftertaste-temp').val()||0.2);
        cfg.iphonieCompactPrompt=$('#aftertaste-iphonie-compact').prop('checked'); cfg.iphonieDirectorEnabled=$('#aftertaste-iphonie-director').prop('checked');
        saveSettingsDebounced(); refreshInjection(); renderIphonieStatus();
    });
    $('#aftertaste-test').on('click',testAPI); $('#aftertaste-analyze').on('click',()=>analyze(true));
    $('#aftertaste-save-state').on('click',()=>{try{s().states[chatKey()]=sanitizeState(JSON.parse($('#aftertaste-state').val()),state().sourceMessageId);saveSettingsDebounced();renderState();toastr?.success?.('余味状态已保存');}catch(e){toastr?.error?.(`JSON错误：${e.message}`);}});
    $('#aftertaste-clear').on('click',()=>{if(confirm('清空当前聊天的余味状态？')){s().states[chatKey()]={version:2,relationships:[],updatedAt:null,sourceMessageId:-1};s().lastAnalyzed[chatKey()]=-1;saveSettingsDebounced();renderState();}});
    $('#aftertaste-log').text(cfg.logs.join('\n')); renderGenerationAudit(); renderIphonieStatus();
}
function addUI(){
    if($('#aftertaste-settings').length) return;
    $('#extensions_settings').append(`<div id="aftertaste-settings" class="extension_container"><div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header"><b>🍷 Aftertaste · 余味</b><span id="aftertaste-status">就绪</span><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label><input id="aftertaste-enabled" type="checkbox"> 启用</label><p class="notes">只维护“事件留下的关系/心理结果”，不做第二套全文记忆库。</p><label>API Base URL<input id="aftertaste-api-base" class="text_pole" placeholder="https://example.com"></label><label>API Key<input id="aftertaste-api-key" class="text_pole" type="password" autocomplete="off"></label><label>模型 ID<input id="aftertaste-model" class="text_pole" placeholder="gemini-... / gpt-..."></label><div class="aftertaste-grid"><label>每 N 楼分析<input id="aftertaste-interval" type="number" min="1"></label><label>分析最近消息数<input id="aftertaste-recent" type="number" min="2" max="30"></label><label>注入预算(tokens)<input id="aftertaste-budget" type="number" min="100" max="2000"></label><label>注入深度<input id="aftertaste-depth" type="number" min="0" max="20"></label><label>分析温度<input id="aftertaste-temp" type="number" min="0" max="2" step="0.1"></label></div><div class="aftertaste-buttons"><button id="aftertaste-test" class="menu_button">测试 API</button><button id="aftertaste-analyze" class="menu_button">立即分析</button><button id="aftertaste-clear" class="menu_button">清空当前状态</button></div><h4>🎙 ST-iPhonie · 低 Token 情绪导演</h4><label><input id="aftertaste-iphonie-compact" type="checkbox"> 低 Token 配音提示词</label><label><input id="aftertaste-iphonie-director" type="checkbox"> 点击朗读时 AI 情绪导演</label><p class="notes">低 Token 模式只让正文模型标记“谁说了哪句话”，不再常驻注入 Fish / MiniMax / MiMo / ElevenLabs 的整套情绪标签说明。第一次真正生成某句正文语音时，情绪导演才用上方同一个 Aftertaste API 单独看当前台词与附近上下文，生成少量停顿、呼吸、叹气、轻笑等表演指令；重播走语音缓存，不重复分析。</p><pre id="aftertaste-iphonie-status">等待检测…</pre><h4>当前聊天余味状态</h4><textarea id="aftertaste-state" class="text_pole" rows="12"></textarea><button id="aftertaste-save-state" class="menu_button">保存手动修改</button><h4>本轮实际注入</h4><div id="aftertaste-token-est" class="notes"></div><pre id="aftertaste-injected"></pre><h4>最近一次生成注入记录</h4><pre id="aftertaste-generation-audit">（尚无生成记录）</pre><h4>运行进度 / 日志（不记录 API Key）</h4><pre id="aftertaste-log"></pre><p class="notes">v0.3.0：保留余味 v0.2.1 的持久关系状态；新增 ST-iPhonie 低 Token 兼容层与按需 AI 情绪导演。正文不再需要常驻携带各家 TTS 的大段标签说明，只有实际生成新语音时才做一次小型表演分析。</p></div></div></div>`);
    bind(); renderState();
}
function reconcileAfterEdit(){
    const st=state(), c=getContext(), newest=(c.chat?.length??0)-1;
    if(Number(st.sourceMessageId)>newest){ s().states[chatKey()]={version:1,relationships:[],updatedAt:null,sourceMessageId:-1}; s().lastAnalyzed[chatKey()]=-1; addLog('检测到消息回退到已分析来源之前：为避免幽灵状态，已清空当前余味；请重新分析。'); saveSettingsDebounced(); }
    refreshInjection(); renderState();
}
export function init(){
    s(); addUI(); installIphonieFetchDirector();
    if (event_types.CHAT_COMPLETION_SETTINGS_READY) eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, compactIphonieRequest);
    eventSource.on(event_types.GENERATION_STARTED, ()=>{ wakeDormantFromRecentText(); refreshInjection(); recordGenerationInjection(); });
    eventSource.on(event_types.MESSAGE_RECEIVED, ()=>analyze(false));
    eventSource.on(event_types.CHAT_CHANGED, ()=>setTimeout(()=>{renderState();refreshInjection();},100));
    eventSource.on(event_types.MESSAGE_DELETED, ()=>{ iphonieRuntime.cache.clear(); reconcileAfterEdit(); });
    eventSource.on(event_types.MESSAGE_EDITED, ()=>{ iphonieRuntime.cache.clear(); reconcileAfterEdit(); });
    eventSource.on(event_types.MESSAGE_SWIPED, ()=>{ iphonieRuntime.cache.clear(); addLog('检测到 swipe：将在下一次分析周期用当前文本更新状态。'); });
    refreshInjection();
    console.log('[Aftertaste] v0.3.0 initialized · ST-iPhonie low-token director ready');
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
