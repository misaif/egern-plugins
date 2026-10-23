/**
 * 彩云天气 · Egern generic widget / v1.0.0
 * 单文件、无依赖。必填 ctx.env.REGION（建议完整市区名）。/**
 * 彩云天气 · Egern generic widget / v1.1.0
 * 单文件、无依赖。必填 ctx.env.REGION（建议完整市区名）。
 * 网络只使用 ctx.http，缓存只使用 ctx.storage；不需要 MITM 或登录。
 */
const H5 = 'https://h5.caiyunapp.com';
const GEO = 'https://starplucker.cyapi.cn/v3/geo/geocode';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Origin: H5, Referer: `${H5}/`, Accept: 'application/json' };
const NS = 'caiyun-widget:v1:';
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const STALE_LIMIT = 6 * HOUR;

class WeatherError extends Error {
  constructor(message, auth = false) { super(message); this.name = 'WeatherError'; this.auth = auth; }
}
const number = value => value === null || value === '' || typeof value === 'boolean' || !['number', 'string'].includes(typeof value)
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const temp = value => finite(value) ? `${Object.is(Math.round(value), -0) ? 0 : Math.round(value)}°` : '—';

export function settings(env = {}) {
  const region = String(env.REGION || '').trim().replace(/\s+/g, '');
  const interval = number(env.REFRESH_MINUTES);
  return { region, title: String(env.TITLE || '').trim(),
    refreshMinutes: interval === null || interval <= 0 ? 15 : Math.max(5, Math.min(120, interval)),
    debug: ['true', '1'].includes(String(env.DEBUG || '').toLowerCase()) };
}
function readCache(ctx, key) {
  try {
    const value = ctx.storage?.getJSON ? ctx.storage.getJSON(NS + key) : JSON.parse(ctx.storage?.get(NS + key) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}
function writeCache(ctx, key, value) {
  try {
    if (ctx.storage?.setJSON) ctx.storage.setJSON(NS + key, value);
    else ctx.storage?.set(NS + key, JSON.stringify(value));
  } catch (_) { /* 缓存不可写时仍展示网络结果。 */ }
}
function fresh(cache, duration, now) {
  return finite(cache?.at) && now >= cache.at && now - cache.at < duration;
}
function debug(ctx, config, stage) {
  if (config.debug) console.log(`[彩云天气] ${stage}`); // 不记录 URL、ticket 或原始响应。
}
async function getJSON(ctx, url, options, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new WeatherError('请求超时');
  let response;
  try {
    const { method, ...requestOptions } = options || {};
    const opts = { headers: HEADERS, credentials: 'omit', timeout: Math.min(7000, remaining), ...requestOptions };
    response = options?.body !== undefined || options?.method === 'POST'
      ? await ctx.http.post(url, opts) : await ctx.http.get(url, opts);
  } catch (_) { throw new WeatherError('网络连接失败'); }
  const status = Number(response.status);
  if (status === 401 || status === 403) throw new WeatherError('认证或来源校验失败', true);
  if (!Number.isFinite(status) || status < 200 || status >= 300) throw new WeatherError('天气服务暂不可用');
  let data;
  try { data = await response.json(); } catch (_) { throw new WeatherError('服务未返回有效数据'); }
  if (data?.statusCode === 401 || data?.statusCode === 403 || /auth failed|unauthorized|invalid ticket|ticket expired/i.test(String(data?.message || ''))) {
    throw new WeatherError('临时认证已失效', true);
  }
  return data;
}
async function getCoordinates(ctx, config, deadline) {
  const key = `geo:${encodeURIComponent(config.region)}`;
  const cached = readCache(ctx, key);
  if (fresh(cached, 30 * DAY, Date.now()) && validPoint(cached.point)) return cached.point;
  debug(ctx, config, '地区解析');
  const data = await getJSON(ctx, `${GEO}?query=${encodeURIComponent(config.region)}&limit=1&lang=zh_CN`, {}, deadline);
  const source = data?.items?.[0];
  const point = { longitude: number(source?.longitude), latitude: number(source?.latitude), name: String(source?.name || config.region) };
  if (!validPoint(point)) throw new WeatherError('未找到地区，请填写完整市区名');
  writeCache(ctx, key, { at: Date.now(), point });
  return point;
}
function validPoint(point) {
  return finite(point?.longitude) && finite(point?.latitude) && Math.abs(point.longitude) <= 180 && Math.abs(point.latitude) <= 90;
}
async function getTicket(ctx, deadline, force = false) {
  const cached = readCache(ctx, 'ticket:chrome140');
  if (!force && fresh(cached, 10 * MINUTE, Date.now()) && typeof cached.ticket === 'string' && cached.ticket) return cached.ticket;
  const data = await getJSON(ctx, `${H5}/api/ticket`, { method: 'POST' }, deadline);
  if (typeof data?.ticket !== 'string' || !data.ticket) throw new WeatherError('未获得临时认证');
  writeCache(ctx, 'ticket:chrome140', { at: Date.now(), ticket: data.ticket });
  return data.ticket;
}
async function fetchWeather(ctx, config, deadline) {
  const point = await getCoordinates(ctx, config, deadline);
  let ticket = await getTicket(ctx, deadline);
  const url = `https://api.caiyunapp.com/v2.5/<t2.5>/${point.longitude},${point.latitude}/weather?dailysteps=16&hourlysteps=120&alert=true&begin=${Math.round(Date.now() / 1000) - 86400}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      debug(ctx, config, attempt ? '重新认证后请求天气' : '请求天气');
      const data = await getJSON(ctx, `${H5}/api/?ticket=${encodeURIComponent(ticket)}`, {
        headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      }, deadline);
      assertCurrent(data);
      return { at: Date.now(), point, data };
    } catch (error) {
      if (!(error instanceof WeatherError) || !error.auth || attempt > 0) throw error;
      ticket = await getTicket(ctx, deadline, true);
    }
  }
  throw new WeatherError('临时认证失败');
}
function assertCurrent(data) {
  const current = data?.result?.realtime;
  if (data?.status !== 'ok' || current?.status !== 'ok' || number(current?.temperature) === null) {
    throw new WeatherError('当前天气暂不可用');
  }
}

// ---------- 日期与数据归一化：始终使用地区时间，按时间戳关联各数组 ----------
export function localParts(ms, meta) {
  try {
    if (meta.timezone && typeof Intl !== 'undefined') {
      const fields = new Intl.DateTimeFormat('en-GB', { timeZone: meta.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      const p = Object.fromEntries(fields.map(v => [v.type, v.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
    }
  } catch (_) { /* 旧 JSCore 不支持该时区时用接口 tzshift。 */ }
  const shifted = new Date(ms + meta.shift * 1000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() };
}
function indexRows(rows, key) {
  return new Map((Array.isArray(rows) ? rows : []).filter(r => typeof r?.[key] === 'string').map(r => [r[key], r]));
}
function minutes(time) {
  if (!/^\d{2}:\d{2}$/.test(String(time))) return null;
  const [h, m] = time.split(':').map(Number);
  return h < 24 && m < 60 ? h * 60 + m : null;
}
function daytime(ms, astro, meta, code = '') {
  const p = localParts(ms, meta);
  const entry = astro.find(v => v.date?.slice(0, 10) === p.date);
  const rise = minutes(entry?.sunrise?.time), set = minutes(entry?.sunset?.time);
  if (rise !== null && set !== null && rise < set) return p.hour * 60 + p.minute >= rise && p.hour * 60 + p.minute < set;
  if (code.endsWith('_NIGHT')) return false;
  if (code.endsWith('_DAY')) return true;
  return p.hour >= 6 && p.hour < 18;
}
export function condition(code) {
  const known = {
    CLEAR_DAY: ['晴', 'clear'], CLEAR_NIGHT: ['晴', 'clear'],
    PARTLY_CLOUDY_DAY: ['多云', 'partly'], PARTLY_CLOUDY_NIGHT: ['多云', 'partly'], CLOUDY: ['阴', 'cloud'],
    LIGHT_HAZE: ['轻度雾霾', 'haze'], MODERATE_HAZE: ['中度雾霾', 'haze'], HEAVY_HAZE: ['重度雾霾', 'haze'],
    LIGHT_RAIN: ['小雨', 'rain'], MODERATE_RAIN: ['中雨', 'rain'], HEAVY_RAIN: ['大雨', 'rain'], STORM_RAIN: ['暴雨', 'rain'],
    RAIN: ['雨', 'rain'], LIGHT_SNOW: ['小雪', 'snow'], MODERATE_SNOW: ['中雪', 'snow'], HEAVY_SNOW: ['大雪', 'snow'], STORM_SNOW: ['暴雪', 'snow'], SNOW: ['雪', 'snow'],
    FOG: ['雾', 'fog'], DUST: ['浮尘', 'haze'], SAND: ['沙尘', 'haze'], WIND: ['大风', 'wind'], THUNDER_SHOWER: ['雷阵雨', 'storm'],
  };
  const [label, kind] = known[code] || ['天气未知', 'cloud'];
  return { label, kind };
}
function dayLabel(date, today) {
  const difference = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);
  if (difference === 0) return '今天';
  if (difference === 1) return '明天';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
}
export function normalizeWeather(data, config, now = Date.now()) {
  assertCurrent(data);
  const result = data.result;
  const meta = { timezone: typeof data.timezone === 'string' ? data.timezone : '', shift: number(data.tzshift) ?? 28800 };
  const localNow = localParts(now, meta);
  const daily = result.daily?.status === 'ok' ? result.daily : {};
  const hourly = result.hourly?.status === 'ok' ? result.hourly : {};
  const astro = Array.isArray(daily.astro) ? daily.astro : [];
  const skyDaily = indexRows(daily.skycon, 'date');
  const dayTemperatures = Array.isArray(daily.temperature) ? daily.temperature : [];
  const days = [...indexRows(dayTemperatures, 'date').values()].filter(r => /^\d{4}-\d{2}-\d{2}/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date)).filter(r => r.date.slice(0, 10) >= localNow.date).slice(0, 5)
    .map(r => ({ date: r.date.slice(0, 10), label: dayLabel(r.date.slice(0, 10), localNow.date),
      low: number(r.min), high: number(r.max), code: skyDaily.get(r.date)?.value || '', day: true }));
  const today = dayTemperatures.find(r => r?.date?.slice(0, 10) === localNow.date);
  const currentHour = now - (localNow.minute * 60 + localNow.second) * 1000 - now % 1000;
  // 用解析后的绝对时间做连接，避免各数组顺序或时区表示不同导致错配。
  const hourSky = new Map([...indexRows(hourly.skycon, 'datetime')].map(([k, v]) => [Date.parse(k), v.value]));
  const hours = [...indexRows(hourly.temperature, 'datetime').values()]
    .map(r => ({ time: Date.parse(r.datetime), temperature: number(r.value) }))
    .filter(r => finite(r.time) && r.time >= currentHour).sort((a, b) => a.time - b.time).slice(0, 6)
    .map(r => { const code = hourSky.get(r.time) || ''; return { ...r, code,
      label: r.time === currentHour ? '现在' : `${String(localParts(r.time, meta).hour).padStart(2, '0')}时`,
      day: daytime(r.time, astro, meta, code) }; });
  const code = String(result.realtime.skycon || '');
  const title = config.title || config.region.split(/市|自治区|自治州|地区/).filter(Boolean).pop() || config.region;
  const description = result.minutely?.status === 'ok' && /RAIN|SNOW/.test(code) ? String(result.minutely.description || '') : '';
  return { title, region: config.region, temperature: number(result.realtime.temperature), code, ...condition(code),
    high: number(today?.max), low: number(today?.min), hours, days, description,
    isDay: daytime(now, astro, meta, code), meta };
}

// ---------- 本地矢量图标与温度条；不下载素材 ----------
// 使用 ASCII Base64 SVG，避免标准 URI 解析把颜色中的 # 当作片段。
function svgData(markup) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let i = 0; i < markup.length; i += 3) {
    const a = markup.charCodeAt(i), b = markup.charCodeAt(i + 1) || 0, c = markup.charCodeAt(i + 2) || 0;
    const bits = (a << 16) | (b << 8) | c;
    output += alphabet[(bits >> 18) & 63] + alphabet[(bits >> 12) & 63]
      + (i + 1 < markup.length ? alphabet[(bits >> 6) & 63] : '=')
      + (i + 2 < markup.length ? alphabet[bits & 63] : '=');
  }
  return 'data:image/svg+xml;base64,' + output;
}
const svgURI = body => svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 56'>${body}</svg>`);
const CLOUD = "<defs><linearGradient id='cloudTone' x2='0' y2='1'><stop stop-color='#FFFFFF'/><stop offset='1' stop-color='#CFDEEC'/></linearGradient></defs><path d='M16 35C8 35 5 30 5 25S9 15 15 15C18 7 28 5 35 9C39 11 41 14 42 18C50 16 58 21 58 27C58 32 54 35 48 35Z' fill='url(#cloudTone)'/>";
const SUN = "<g stroke='#FFD879' stroke-width='3' stroke-linecap='round'><path d='M32 5V0M32 56v-5M9 28H4M60 28h-5M16 12l-4-4M52 48l-4-4M48 12l4-4M12 48l4-4'/></g><circle cx='32' cy='28' r='14' fill='#FFD879'/>";
const MOON = "<path d='M45 5C27 3 17 18 23 33C28 47 45 51 56 40C41 42 29 28 35 15C37 10 40 7 45 5Z' fill='#FFF3C8'/>";
export function iconURI(code, day = true) {
  const { kind } = condition(code);
  if (kind === 'clear') return svgURI(day ? SUN : MOON);
  if (kind === 'partly') return svgURI((day ? "<circle cx='44' cy='17' r='12' fill='#FFD879'/>" : "<path d='M46 3C28 5 29 27 48 28C38 19 39 12 46 3Z' fill='#FFF3C8'/>") + `<g transform='translate(-2 6)'>${CLOUD}</g>`);
  if (kind === 'rain' || kind === 'storm') return svgURI(CLOUD + (kind === 'storm'
    ? "<path d='M34 34L23 47h9l-5 9 18-17h-10l5-5Z' fill='#FFD879'/>"
    : "<g stroke='#9ED9FF' stroke-width='2.8' stroke-linecap='round'><path d='M21 41l-3 7M33 41l-3 7M45 41l-3 7'/></g>"));
  if (kind === 'snow') return svgURI(CLOUD + "<g fill='#E2F5FF'><circle cx='20' cy='44' r='2'/><circle cx='32' cy='48' r='2'/><circle cx='44' cy='43' r='2'/></g>");
  if (kind === 'fog' || kind === 'haze') return svgURI(CLOUD + `<path d='M10 43h44M16 50h34' stroke='${kind === 'fog' ? '#DDE6EC' : '#E6D6B1'}' stroke-width='3' stroke-linecap='round'/>`);
  if (kind === 'wind') return svgURI("<path d='M5 20h35c15 0 15-18 4-15M5 30h44c14 0 14 17 4 17M11 40h18' fill='none' stroke='#ECF4FA' stroke-width='4' stroke-linecap='round'/>");
  return svgURI(CLOUD);
}
export function themeFor(model) {
  const themes = {
    clear: model.isDay ? ['#1C68B6', '#378ED1', '#75B3DF'] : ['#10213D', '#1E3659', '#344D72'],
    partly: model.isDay ? ['#2B6597', '#5B8EB6', '#94B3C9'] : ['#152A45', '#304867', '#536C88'],
    cloud: ['#435B72', '#6F879B', '#9EAFBD'], rain: ['#233E5C', '#426784', '#7193AC'],
    snow: ['#58748D', '#8BA4B7', '#B6C9D4'], fog: ['#566877', '#82939F', '#A5B4BD'],
    haze: ['#655E58', '#8A8173', '#B2AA98'], wind: ['#34546C', '#607C90', '#90A8B6'],
    storm: ['#273246', '#46546D', '#687C95'],
  };
  let colors = themes[model.kind] || themes.cloud;
  if (!model.isDay && !['clear', 'partly'].includes(model.kind)) colors = ['#142A46', '#2E4C68', '#577992'];
  return { type: 'linear', colors, stops: [0, 0.55, 1], startPoint: { x: 0, y: 0 }, endPoint: { x: 0.8, y: 1 } };
}
function rangeURI(day, allDays, current) {
  const values = allDays.flatMap(d => [d.low, d.high]).filter(finite);
  const min = Math.min(...values), max = Math.max(...values);
  const valid = finite(day.low) && finite(day.high) && day.high >= day.low && values.length;
  const x = value => 3 + (max === min ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)))) * 114;
  let body = "<defs><linearGradient id='bar'><stop stop-color='#73D6D2'/><stop offset='.5' stop-color='#ADD6AD'/><stop offset='1' stop-color='#EBD17F'/></linearGradient></defs><rect x='3' y='3' width='114' height='4' rx='2' fill='white' fill-opacity='.16'/>";
  if (valid) {
    const left = x(day.low), right = x(day.high);
    body += `<rect x='${left}' y='3' width='${Math.max(3, right - left)}' height='4' rx='2' fill='url(#bar)'/>`;
    if (finite(current) && current >= day.low && current <= day.high) body += `<circle cx='${x(current)}' cy='5' r='2.8' fill='white' stroke='#557A91' stroke-width='1'/>`;
  }
  return svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 10'>${body}</svg>`);
}

// ---------- 原生 Widget DSL · v1.1 ----------
// flex 只分配剩余空间；不再与同轴的固定尺寸混用。文字容器留出完整行高。
function text(value, size = 13, options = {}) {
  return { type: 'text', text: String(value), font: { size, weight: 'regular' }, textColor: '#FFFFFF', maxLines: 1, minScale: 0.72, ...options };
}
function row(children, options = {}) { return { type: 'stack', direction: 'row', alignItems: 'center', children, ...options }; }
function column(children, options = {}) { return { type: 'stack', direction: 'column', alignItems: 'start', children, ...options }; }
const space = length => length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
const image = (src, size, options = {}) => ({ type: 'image', src, width: size, height: size, resizeMode: 'contain', ...options });
function weatherIcon(code, day, size) { return image(iconURI(code, day), size); }
function rule() {
  return { type: 'image', src: svgData("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 1'><path d='M0 .5H320' stroke='white' stroke-opacity='.12'/></svg>"), height: 1, resizeMode: 'cover' };
}
function highLow(model, size = 11) { return text(`最高 ${temp(model.high)}  最低 ${temp(model.low)}`, size, { opacity: 0.86 }); }
function staleRow(at) {
  return row([text('缓存 ·', 9, { textColor: '#FFF0C2' }), { type: 'date', date: new Date(at).toISOString(), format: 'relative', font: { size: 9 }, textColor: '#FFF0C2', maxLines: 1, minScale: 0.7 }], { gap: 3, height: 12 });
}
function hourlyRow(model, large) {
  const height = large ? 54 : 48;
  if (!model.hours.length) return row([text('小时预报暂不可用', 11, { opacity: 0.72 })], { height });
  // 六列始终等宽。缺少预报时留空列，不把其余列拉伸成不同宽度。
  const slots = Array.from({ length: 6 }, (_, i) => model.hours[i]);
  return row(slots.map(h => column(h ? [
    text(h.label, large ? 11 : 10, { opacity: 0.72, textAlign: 'center' }),
    weatherIcon(h.code, h.day, large ? 20 : 18),
    text(temp(h.temperature), large ? 14 : 13, { font: { size: large ? 14 : 13, weight: 'medium' }, textAlign: 'center' }),
  ] : [text('—', 12, { opacity: 0.45 })], { flex: 1, alignItems: 'center', gap: 1 })), { height });
}
function fixedCell(value, width, opacity = 1, align = 'end') {
  return column([text(value, 12, { opacity, textAlign: align === 'end' ? 'right' : 'left' })], { width, alignItems: align });
}
function dailyTable(model) {
  if (!model.days.length) return row([text('多日预报暂不可用', 11, { opacity: 0.72 })], { height: 139 });
  const children = [];
  for (let i = 0; i < 5; i++) {
    const day = model.days[i];
    if (day) {
      children.push(row([
        fixedCell(day.label, 29, 1, 'start'),
        weatherIcon(day.code, true, 22),
        fixedCell(temp(day.low), 27, 0.60),
        // 高度固定，宽度只由 flex 决定；不设置固定宽度，也不裁切温度范围。
        { type: 'image', src: rangeURI(day, model.days, i === 0 && day.label === '今天' ? model.temperature : null), height: 9, flex: 1, resizeMode: 'contain' },
        fixedCell(temp(day.high), 27),
      ], { gap: 6, height: 27 }));
    } else children.push(row([text('—', 12, { opacity: 0.4 })], { height: 27 }));
    if (i < 4) children.push(space(), rule(), space());
  }
  // 行高固定，额外高度只交给行间 spacer；不会拉伸文字或图标。
  return column(children, { flex: 1 });
}
export function renderWidget(model, family, config, status, now = Date.now()) {
  const small = family === 'systemSmall';
  const large = family === 'systemLarge';
  const root = { type: 'widget', padding: 14, gap: 0, backgroundGradient: themeFor(model),
    refreshAfter: new Date(now + (status.stale ? 5 : config.refreshMinutes) * MINUTE).toISOString(),
    url: `${H5}/h5?city=${encodeURIComponent(config.region)}`, children: [] };
  if (small) {
    // 最小 155pt 组件仍能容纳内容；大温度的行高不再被 54pt 容器压缩。
    root.children = [row([text(model.title, 15, { font: { size: 15, weight: 'medium' }, flex: 1 })], { height: 18 }),
      row([text(temp(model.temperature), status.stale ? 40 : 50, { font: { size: status.stale ? 40 : 50, weight: 'light' } })], { height: status.stale ? 48 : 60 }),
      space(), column([weatherIcon(model.code, model.isDay, 20), text(model.label, 12), highLow(model, 10)], { gap: 0, height: 47 }),
      ...(status.stale ? [staleRow(status.at)] : [])];
    return root;
  }
  const headerHeight = large ? (status.stale ? 72 : 84) : (status.stale ? 58 : 70);
  const temperatureSize = large ? (status.stale ? 42 : 52) : (status.stale ? 30 : 40);
  const titleSize = large ? 17 : 15;
  const header = row([
    column([text(model.title, titleSize, { font: { size: titleSize, weight: 'medium' } }),
      text(temp(model.temperature), temperatureSize, { font: { size: temperatureSize, weight: 'light' } })], { flex: 1, gap: 0 }),
    column([weatherIcon(model.code, model.isDay, large ? 40 : (status.stale ? 22 : 28)),
      text(model.label, large ? 12 : 10, { textAlign: 'right' }), highLow(model, large ? 11 : 10)],
      { alignItems: 'end', gap: 1 }),
  ], { height: headerHeight, gap: 10, alignItems: 'start' });
  root.children = [header];
  if (large) root.children.push(row([text(model.description || '今日天气', 12, { opacity: 0.86, flex: 1 })], { height: 20 }));
  root.children.push(space(large ? 3 : 4), rule(), space(large ? 5 : 4), hourlyRow(model, large));
  if (large) root.children.push(space(5), rule(), space(5), dailyTable(model));
  if (!large) root.children.push(space());
  if (status.stale) root.children.push(staleRow(status.at));
  return root;
}
function messageWidget(title, message, family, config, now) {
  return { type: 'widget', padding: 16, backgroundGradient: themeFor({ kind: 'cloud', isDay: false }),
    refreshAfter: new Date(now + 5 * MINUTE).toISOString(),
    ...(config.region ? { url: `${H5}/h5?city=${encodeURIComponent(config.region)}` } : {}),
    children: [text(title, 15, { font: { size: 15, weight: 'medium' } }), space(),
      text('—', family === 'systemSmall' ? 43 : 50, { font: { size: 43, weight: 'light' } }),
      text(message, 12, { opacity: 0.85, maxLines: 3 }), space()] };
}

export default async function weatherWidget(ctx) {
  const now = Date.now();
  const config = settings(ctx.env);
  const family = ctx.widgetFamily || 'systemSmall';
  if (!['systemSmall', 'systemMedium', 'systemLarge'].includes(family)) return messageWidget('彩云天气', '请选桌面小、中或大号组件', family, config, now);
  if (!config.region) return messageWidget('配置地区', '请在环境变量 REGION 填写完整市区名', family, config, now);
  const key = `weather:${encodeURIComponent(config.region)}`;
  const cached = readCache(ctx, key);
  let record, stale = false;
  try {
    if (fresh(cached, config.refreshMinutes * MINUTE, now)) {
      assertCurrent(cached.data); record = cached; debug(ctx, config, '使用天气缓存');
    }
  } catch (_) { /* 损坏缓存不影响在线更新。 */ }
  if (!record) {
    try {
      record = await fetchWeather(ctx, config, now + 25000);
      writeCache(ctx, key, record);
    } catch (error) {
      debug(ctx, config, '更新失败');
      try {
        if (!fresh(cached, STALE_LIMIT, now)) throw error;
        assertCurrent(cached.data);
        record = cached; stale = true;
      } catch (_) {
        return messageWidget(config.title || config.region, error instanceof WeatherError ? error.message : '天气暂不可用', family, config, now);
      }
    }
  }
  try {
    const model = normalizeWeather(record.data, config, Date.now());
    const widget = renderWidget(model, family, config, { stale, at: record.at }, Date.now());
    return widget;
  } catch (_) { return messageWidget(config.title || config.region, '天气数据暂不可用', family, config, Date.now()); }
}

 * 网络只使用 ctx.http，缓存只使用 ctx.storage；不需要 MITM 或登录。
 */
const H5 = 'https://h5.caiyunapp.com';
const GEO = 'https://starplucker.cyapi.cn/v3/geo/geocode';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Origin: H5, Referer: `${H5}/`, Accept: 'application/json' };
const NS = 'caiyun-widget:v1:';
const MINUTE = 60000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
const STALE_LIMIT = 6 * HOUR;

class WeatherError extends Error {
  constructor(message, auth = false) { super(message); this.name = 'WeatherError'; this.auth = auth; }
}
const number = value => value === null || value === '' || typeof value === 'boolean' || !['number', 'string'].includes(typeof value)
  ? null : (Number.isFinite(Number(value)) ? Number(value) : null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const temp = value => finite(value) ? `${Object.is(Math.round(value), -0) ? 0 : Math.round(value)}°` : '—';

export function settings(env = {}) {
  const region = String(env.REGION || '').trim().replace(/\s+/g, '');
  const interval = number(env.REFRESH_MINUTES);
  return { region, title: String(env.TITLE || '').trim(),
    refreshMinutes: interval === null || interval <= 0 ? 15 : Math.max(5, Math.min(120, interval)),
    debug: ['true', '1'].includes(String(env.DEBUG || '').toLowerCase()) };
}
function readCache(ctx, key) {
  try {
    const value = ctx.storage?.getJSON ? ctx.storage.getJSON(NS + key) : JSON.parse(ctx.storage?.get(NS + key) || 'null');
    return value && typeof value === 'object' ? value : null;
  } catch (_) { return null; }
}
function writeCache(ctx, key, value) {
  try {
    if (ctx.storage?.setJSON) ctx.storage.setJSON(NS + key, value);
    else ctx.storage?.set(NS + key, JSON.stringify(value));
  } catch (_) { /* 缓存不可写时仍展示网络结果。 */ }
}
function fresh(cache, duration, now) {
  return finite(cache?.at) && now >= cache.at && now - cache.at < duration;
}
function debug(ctx, config, stage) {
  if (config.debug) console.log(`[彩云天气] ${stage}`); // 不记录 URL、ticket 或原始响应。
}
async function getJSON(ctx, url, options, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new WeatherError('请求超时');
  let response;
  try {
    const { method, ...requestOptions } = options || {};
    const opts = { headers: HEADERS, credentials: 'omit', timeout: Math.min(7000, remaining), ...requestOptions };
    response = options?.body !== undefined || options?.method === 'POST'
      ? await ctx.http.post(url, opts) : await ctx.http.get(url, opts);
  } catch (_) { throw new WeatherError('网络连接失败'); }
  const status = Number(response.status);
  if (status === 401 || status === 403) throw new WeatherError('认证或来源校验失败', true);
  if (!Number.isFinite(status) || status < 200 || status >= 300) throw new WeatherError('天气服务暂不可用');
  let data;
  try { data = await response.json(); } catch (_) { throw new WeatherError('服务未返回有效数据'); }
  if (data?.statusCode === 401 || data?.statusCode === 403 || /auth failed|unauthorized|invalid ticket|ticket expired/i.test(String(data?.message || ''))) {
    throw new WeatherError('临时认证已失效', true);
  }
  return data;
}
async function getCoordinates(ctx, config, deadline) {
  const key = `geo:${encodeURIComponent(config.region)}`;
  const cached = readCache(ctx, key);
  if (fresh(cached, 30 * DAY, Date.now()) && validPoint(cached.point)) return cached.point;
  debug(ctx, config, '地区解析');
  const data = await getJSON(ctx, `${GEO}?query=${encodeURIComponent(config.region)}&limit=1&lang=zh_CN`, {}, deadline);
  const source = data?.items?.[0];
  const point = { longitude: number(source?.longitude), latitude: number(source?.latitude), name: String(source?.name || config.region) };
  if (!validPoint(point)) throw new WeatherError('未找到地区，请填写完整市区名');
  writeCache(ctx, key, { at: Date.now(), point });
  return point;
}
function validPoint(point) {
  return finite(point?.longitude) && finite(point?.latitude) && Math.abs(point.longitude) <= 180 && Math.abs(point.latitude) <= 90;
}
async function getTicket(ctx, deadline, force = false) {
  const cached = readCache(ctx, 'ticket:chrome140');
  if (!force && fresh(cached, 10 * MINUTE, Date.now()) && typeof cached.ticket === 'string' && cached.ticket) return cached.ticket;
  const data = await getJSON(ctx, `${H5}/api/ticket`, { method: 'POST' }, deadline);
  if (typeof data?.ticket !== 'string' || !data.ticket) throw new WeatherError('未获得临时认证');
  writeCache(ctx, 'ticket:chrome140', { at: Date.now(), ticket: data.ticket });
  return data.ticket;
}
async function fetchWeather(ctx, config, deadline) {
  const point = await getCoordinates(ctx, config, deadline);
  let ticket = await getTicket(ctx, deadline);
  const url = `https://api.caiyunapp.com/v2.5/<t2.5>/${point.longitude},${point.latitude}/weather?dailysteps=16&hourlysteps=120&alert=true&begin=${Math.round(Date.now() / 1000) - 86400}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      debug(ctx, config, attempt ? '重新认证后请求天气' : '请求天气');
      const data = await getJSON(ctx, `${H5}/api/?ticket=${encodeURIComponent(ticket)}`, {
        headers: { ...HEADERS, 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      }, deadline);
      assertCurrent(data);
      return { at: Date.now(), point, data };
    } catch (error) {
      if (!(error instanceof WeatherError) || !error.auth || attempt > 0) throw error;
      ticket = await getTicket(ctx, deadline, true);
    }
  }
  throw new WeatherError('临时认证失败');
}
function assertCurrent(data) {
  const current = data?.result?.realtime;
  if (data?.status !== 'ok' || current?.status !== 'ok' || number(current?.temperature) === null) {
    throw new WeatherError('当前天气暂不可用');
  }
}

// ---------- 日期与数据归一化：始终使用地区时间，按时间戳关联各数组 ----------
export function localParts(ms, meta) {
  try {
    if (meta.timezone && typeof Intl !== 'undefined') {
      const fields = new Intl.DateTimeFormat('en-GB', { timeZone: meta.timezone,
        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
      const p = Object.fromEntries(fields.map(v => [v.type, v.value]));
      return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second) };
    }
  } catch (_) { /* 旧 JSCore 不支持该时区时用接口 tzshift。 */ }
  const shifted = new Date(ms + meta.shift * 1000);
  return { date: shifted.toISOString().slice(0, 10), hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(), second: shifted.getUTCSeconds() };
}
function indexRows(rows, key) {
  return new Map((Array.isArray(rows) ? rows : []).filter(r => typeof r?.[key] === 'string').map(r => [r[key], r]));
}
function minutes(time) {
  if (!/^\d{2}:\d{2}$/.test(String(time))) return null;
  const [h, m] = time.split(':').map(Number);
  return h < 24 && m < 60 ? h * 60 + m : null;
}
function daytime(ms, astro, meta, code = '') {
  const p = localParts(ms, meta);
  const entry = astro.find(v => v.date?.slice(0, 10) === p.date);
  const rise = minutes(entry?.sunrise?.time), set = minutes(entry?.sunset?.time);
  if (rise !== null && set !== null && rise < set) return p.hour * 60 + p.minute >= rise && p.hour * 60 + p.minute < set;
  if (code.endsWith('_NIGHT')) return false;
  if (code.endsWith('_DAY')) return true;
  return p.hour >= 6 && p.hour < 18;
}
export function condition(code) {
  const known = {
    CLEAR_DAY: ['晴', 'clear'], CLEAR_NIGHT: ['晴', 'clear'],
    PARTLY_CLOUDY_DAY: ['多云', 'partly'], PARTLY_CLOUDY_NIGHT: ['多云', 'partly'], CLOUDY: ['阴', 'cloud'],
    LIGHT_HAZE: ['轻度雾霾', 'haze'], MODERATE_HAZE: ['中度雾霾', 'haze'], HEAVY_HAZE: ['重度雾霾', 'haze'],
    LIGHT_RAIN: ['小雨', 'rain'], MODERATE_RAIN: ['中雨', 'rain'], HEAVY_RAIN: ['大雨', 'rain'], STORM_RAIN: ['暴雨', 'rain'],
    RAIN: ['雨', 'rain'], LIGHT_SNOW: ['小雪', 'snow'], MODERATE_SNOW: ['中雪', 'snow'], HEAVY_SNOW: ['大雪', 'snow'], STORM_SNOW: ['暴雪', 'snow'], SNOW: ['雪', 'snow'],
    FOG: ['雾', 'fog'], DUST: ['浮尘', 'haze'], SAND: ['沙尘', 'haze'], WIND: ['大风', 'wind'], THUNDER_SHOWER: ['雷阵雨', 'storm'],
  };
  const [label, kind] = known[code] || ['天气未知', 'cloud'];
  return { label, kind };
}
function dayLabel(date, today) {
  const difference = Math.round((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / DAY);
  if (difference === 0) return '今天';
  if (difference === 1) return '明天';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(`${date}T12:00:00Z`).getUTCDay()];
}
export function normalizeWeather(data, config, now = Date.now()) {
  assertCurrent(data);
  const result = data.result;
  const meta = { timezone: typeof data.timezone === 'string' ? data.timezone : '', shift: number(data.tzshift) ?? 28800 };
  const localNow = localParts(now, meta);
  const daily = result.daily?.status === 'ok' ? result.daily : {};
  const hourly = result.hourly?.status === 'ok' ? result.hourly : {};
  const astro = Array.isArray(daily.astro) ? daily.astro : [];
  const skyDaily = indexRows(daily.skycon, 'date');
  const dayTemperatures = Array.isArray(daily.temperature) ? daily.temperature : [];
  const days = [...indexRows(dayTemperatures, 'date').values()].filter(r => /^\d{4}-\d{2}-\d{2}/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date)).filter(r => r.date.slice(0, 10) >= localNow.date).slice(0, 5)
    .map(r => ({ date: r.date.slice(0, 10), label: dayLabel(r.date.slice(0, 10), localNow.date),
      low: number(r.min), high: number(r.max), code: skyDaily.get(r.date)?.value || '', day: true }));
  const today = dayTemperatures.find(r => r?.date?.slice(0, 10) === localNow.date);
  const currentHour = now - (localNow.minute * 60 + localNow.second) * 1000 - now % 1000;
  // 用解析后的绝对时间做连接，避免各数组顺序或时区表示不同导致错配。
  const hourSky = new Map([...indexRows(hourly.skycon, 'datetime')].map(([k, v]) => [Date.parse(k), v.value]));
  const hours = [...indexRows(hourly.temperature, 'datetime').values()]
    .map(r => ({ time: Date.parse(r.datetime), temperature: number(r.value) }))
    .filter(r => finite(r.time) && r.time >= currentHour).sort((a, b) => a.time - b.time).slice(0, 6)
    .map(r => { const code = hourSky.get(r.time) || ''; return { ...r, code,
      label: r.time === currentHour ? '现在' : `${String(localParts(r.time, meta).hour).padStart(2, '0')}时`,
      day: daytime(r.time, astro, meta, code) }; });
  const code = String(result.realtime.skycon || '');
  const title = config.title || config.region.split(/市|自治区|自治州|地区/).filter(Boolean).pop() || config.region;
  const description = result.minutely?.status === 'ok' && /RAIN|SNOW/.test(code) ? String(result.minutely.description || '') : '';
  return { title, region: config.region, temperature: number(result.realtime.temperature), code, ...condition(code),
    high: number(today?.max), low: number(today?.min), hours, days, description,
    isDay: daytime(now, astro, meta, code), meta };
}

// ---------- 本地矢量图标与温度条；不下载素材 ----------
// 使用 ASCII Base64 SVG，避免标准 URI 解析把颜色中的 # 当作片段。
function svgData(markup) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let i = 0; i < markup.length; i += 3) {
    const a = markup.charCodeAt(i), b = markup.charCodeAt(i + 1) || 0, c = markup.charCodeAt(i + 2) || 0;
    const bits = (a << 16) | (b << 8) | c;
    output += alphabet[(bits >> 18) & 63] + alphabet[(bits >> 12) & 63]
      + (i + 1 < markup.length ? alphabet[(bits >> 6) & 63] : '=')
      + (i + 2 < markup.length ? alphabet[bits & 63] : '=');
  }
  return 'data:image/svg+xml;base64,' + output;
}
const svgURI = body => svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 56'>${body}</svg>`);
const CLOUD = "<path d='M16 35C8 35 5 30 5 25S9 15 15 15C18 7 28 5 35 9C39 11 41 14 42 18C50 16 58 21 58 27C58 32 54 35 48 35Z' fill='#F4F8FC'/>";
const SUN = "<g stroke='#FFD879' stroke-width='3' stroke-linecap='round'><path d='M32 5V0M32 56v-5M9 28H4M60 28h-5M16 12l-4-4M52 48l-4-4M48 12l4-4M12 48l4-4'/></g><circle cx='32' cy='28' r='14' fill='#FFD879'/>";
const MOON = "<path d='M45 5C27 3 17 18 23 33C28 47 45 51 56 40C41 42 29 28 35 15C37 10 40 7 45 5Z' fill='#FFF3C8'/>";
export function iconURI(code, day = true) {
  const { kind } = condition(code);
  if (kind === 'clear') return svgURI(day ? SUN : MOON);
  if (kind === 'partly') return svgURI((day ? "<circle cx='44' cy='17' r='12' fill='#FFD879'/>" : "<path d='M46 3C28 5 29 27 48 28C38 19 39 12 46 3Z' fill='#FFF3C8'/>") + `<g transform='translate(-2 6)'>${CLOUD}</g>`);
  if (kind === 'rain' || kind === 'storm') return svgURI(CLOUD + (kind === 'storm'
    ? "<path d='M34 34L23 47h9l-5 9 18-17h-10l5-5Z' fill='#FFD879'/>"
    : "<g stroke='#9ED9FF' stroke-width='3.2' stroke-linecap='round'><path d='M21 41l-3 7M33 41l-3 7M45 41l-3 7'/></g>"));
  if (kind === 'snow') return svgURI(CLOUD + "<g fill='#E2F5FF'><circle cx='20' cy='44' r='2'/><circle cx='32' cy='48' r='2'/><circle cx='44' cy='43' r='2'/></g>");
  if (kind === 'fog' || kind === 'haze') return svgURI(CLOUD + `<path d='M10 43h44M16 50h34' stroke='${kind === 'fog' ? '#DDE6EC' : '#E6D6B1'}' stroke-width='3' stroke-linecap='round'/>`);
  if (kind === 'wind') return svgURI("<path d='M5 20h35c15 0 15-18 4-15M5 30h44c14 0 14 17 4 17M11 40h18' fill='none' stroke='#ECF4FA' stroke-width='4' stroke-linecap='round'/>");
  return svgURI(CLOUD);
}
export function themeFor(model) {
  const themes = {
    clear: model.isDay ? ['#1C68B6', '#378ED1', '#75B3DF'] : ['#10213D', '#1E3659', '#344D72'],
    partly: model.isDay ? ['#2B6597', '#5B8EB6', '#94B3C9'] : ['#152A45', '#304867', '#536C88'],
    cloud: ['#435B72', '#6F879B', '#9EAFBD'], rain: ['#233E5C', '#426784', '#7193AC'],
    snow: ['#58748D', '#8BA4B7', '#B6C9D4'], fog: ['#566877', '#82939F', '#A5B4BD'],
    haze: ['#655E58', '#8A8173', '#B2AA98'], wind: ['#34546C', '#607C90', '#90A8B6'],
    storm: ['#273246', '#46546D', '#687C95'],
  };
  let colors = themes[model.kind] || themes.cloud;
  if (!model.isDay && !['clear', 'partly'].includes(model.kind)) colors = ['#18283D', '#30455F', '#526A80'];
  return { type: 'linear', colors, stops: [0, 0.55, 1], startPoint: { x: 0, y: 0 }, endPoint: { x: 0.8, y: 1 } };
}
function rangeURI(day, allDays, current) {
  const values = allDays.flatMap(d => [d.low, d.high]).filter(finite);
  const min = Math.min(...values), max = Math.max(...values);
  const valid = finite(day.low) && finite(day.high) && day.high >= day.low && values.length;
  const x = value => 3 + (max === min ? 0.5 : Math.max(0, Math.min(1, (value - min) / (max - min)))) * 114;
  let body = "<defs><linearGradient id='bar'><stop stop-color='#73D6D2'/><stop offset='.5' stop-color='#ADD6AD'/><stop offset='1' stop-color='#EBD17F'/></linearGradient></defs><rect x='3' y='3' width='114' height='4' rx='2' fill='white' fill-opacity='.16'/>";
  if (valid) {
    const left = x(day.low), right = x(day.high);
    body += `<rect x='${left}' y='3' width='${Math.max(3, right - left)}' height='4' rx='2' fill='url(#bar)'/>`;
    if (finite(current) && current >= day.low && current <= day.high) body += `<circle cx='${x(current)}' cy='5' r='2.8' fill='white' stroke='#557A91' stroke-width='1'/>`;
  }
  return svgData(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 10'>${body}</svg>`);
}

// ---------- 原生 Widget DSL ----------
function text(value, size = 13, options = {}) {
  return { type: 'text', text: String(value), font: { size, weight: 'regular' }, textColor: '#FFFFFF', maxLines: 1, minScale: 0.65, ...options };
}
function row(children, options = {}) { return { type: 'stack', direction: 'row', alignItems: 'center', children, ...options }; }
function column(children, options = {}) { return { type: 'stack', direction: 'column', alignItems: 'start', children, ...options }; }
const space = length => length === undefined ? { type: 'spacer' } : { type: 'spacer', length };
const image = (src, size, options = {}) => ({ type: 'image', src, width: size, height: size, resizeMode: 'contain', ...options });
function weatherIcon(code, day, size) { return image(iconURI(code, day), size); }
function rule() { return { type: 'image', src: svgData("<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 320 1'><path d='M0 .5H320' stroke='white' stroke-opacity='.18'/></svg>"), height: 1, flex: 0, resizeMode: 'cover' }; }
function highLow(model, size = 11) { return text(`最高 ${temp(model.high)}  最低 ${temp(model.low)}`, size, { opacity: 0.9 }); }
function staleRow(at) {
  return row([text('缓存 ·', 9, { textColor: '#FFF0C2' }), { type: 'date', date: new Date(at).toISOString(), format: 'relative', font: { size: 9 }, textColor: '#FFF0C2', maxLines: 1, minScale: 0.7 }], { gap: 3, height: 12 });
}
function hourlyRow(model) {
  if (!model.hours.length) return row([text('小时预报暂不可用', 11, { opacity: 0.72 })], { height: 58 });
  return row(model.hours.map(h => column([
    text(h.label, 10, { opacity: 0.85, textAlign: 'center' }), weatherIcon(h.code, h.day, 23),
    text(temp(h.temperature), 14, { font: { size: 14, weight: 'medium' }, textAlign: 'center' }),
  ], { flex: 1, alignItems: 'center', gap: 2 })), { height: 50 });
}
function dailyRows(model) {
  if (!model.days.length) return [row([text('多日预报暂不可用', 11, { opacity: 0.72 })], { height: 25 })];
  return model.days.flatMap((day, i) => [row([
    column([text(day.label, 12, { font: { size: 12, weight: 'medium' } })], { width: 31 }),
    weatherIcon(day.code, true, 23),
    column([text(temp(day.low), 12, { opacity: 0.65, textAlign: 'right' })], { width: 28, alignItems: 'end' }),
    image(rangeURI(day, model.days, i === 0 && day.label === '今天' ? model.temperature : null), 120, { height: 10, flex: 1 }),
    column([text(temp(day.high), 12, { textAlign: 'right' })], { width: 28, alignItems: 'end' }),
  ], { gap: 6, height: 24, flex: 1 }), ...(i < model.days.length - 1 ? [rule()] : [])]);
}
export function renderWidget(model, family, config, status, now = Date.now()) {
  const small = family === 'systemSmall';
  const large = family === 'systemLarge';
  const root = { type: 'widget', padding: 16, gap: 0, backgroundGradient: themeFor(model),
    refreshAfter: new Date(now + (status.stale ? 5 : config.refreshMinutes) * MINUTE).toISOString(),
    url: `${H5}/h5?city=${encodeURIComponent(config.region)}`, children: [] };
  if (small) {
    root.children = [row([text(model.title, 15, { font: { size: 15, weight: 'medium' }, flex: 1 })], { height: 18 }),
      row([text(temp(model.temperature), status.stale ? 43 : 52, { font: { size: status.stale ? 43 : 52, weight: 'light' } })], { height: status.stale ? 43 : 54 }),
      space(), column([weatherIcon(model.code, model.isDay, 23), text(model.label, 12), highLow(model, 10.5)], { gap: 1, height: 51 }),
      ...(status.stale ? [staleRow(status.at)] : [])];
    return root;
  }
  const headerHeight = large ? (status.stale ? 74 : 82) : (status.stale ? 52 : 64);
  const temperatureSize = large ? (status.stale ? 45 : 52) : (status.stale ? 28 : 38);
  const header = row([
    column([text(model.title, large ? 17 : 15, { font: { size: large ? 17 : 15, weight: 'medium' } }),
      text(temp(model.temperature), temperatureSize, { font: { size: temperatureSize, weight: 'light' } })], { flex: 1, gap: 0 }),
    column([weatherIcon(model.code, model.isDay, large ? 40 : (status.stale ? 22 : 28)), text(model.label, large ? 12 : 10, { textAlign: 'right' }), highLow(model, large ? 11 : 10)], { alignItems: 'end', gap: 1 }),
  ], { height: headerHeight, gap: 8 });
  root.children = [header];
  if (large) root.children.push(row([text(model.description || '今日天气', 12, { opacity: 0.92, flex: 1 })], { height: 20 }));
  root.children.push(space(large ? 6 : 3), rule(), space(large ? 6 : 4), hourlyRow(model));
  if (large) root.children.push(space(7), rule(), space(7), column(dailyRows(model), { flex: 1 }));
  if (status.stale) root.children.push(staleRow(status.at));
  return root;
}
function messageWidget(title, message, family, config, now) {
  return { type: 'widget', padding: 16, backgroundGradient: themeFor({ kind: 'cloud', isDay: false }),
    refreshAfter: new Date(now + 5 * MINUTE).toISOString(),
    ...(config.region ? { url: `${H5}/h5?city=${encodeURIComponent(config.region)}` } : {}),
    children: [text(title, 15, { font: { size: 15, weight: 'medium' } }), space(),
      text('—', family === 'systemSmall' ? 43 : 50, { font: { size: 43, weight: 'light' } }),
      text(message, 12, { opacity: 0.85, maxLines: 3 }), space()] };
}

export default async function weatherWidget(ctx) {
  const now = Date.now();
  const config = settings(ctx.env);
  const family = ctx.widgetFamily || 'systemSmall';
  if (!['systemSmall', 'systemMedium', 'systemLarge'].includes(family)) return messageWidget('彩云天气', '请选桌面小、中或大号组件', family, config, now);
  if (!config.region) return messageWidget('配置地区', '请在环境变量 REGION 填写完整市区名', family, config, now);
  const key = `weather:${encodeURIComponent(config.region)}`;
  const cached = readCache(ctx, key);
  let record, stale = false;
  try {
    if (fresh(cached, config.refreshMinutes * MINUTE, now)) {
      assertCurrent(cached.data); record = cached; debug(ctx, config, '使用天气缓存');
    }
  } catch (_) { /* 损坏缓存不影响在线更新。 */ }
  if (!record) {
    try {
      record = await fetchWeather(ctx, config, now + 25000);
      writeCache(ctx, key, record);
    } catch (error) {
      debug(ctx, config, '更新失败');
      try {
        if (!fresh(cached, STALE_LIMIT, now)) throw error;
        assertCurrent(cached.data);
        record = cached; stale = true;
      } catch (_) {
        return messageWidget(config.title || config.region, error instanceof WeatherError ? error.message : '天气暂不可用', family, config, now);
      }
    }
  }
  try {
    const model = normalizeWeather(record.data, config, Date.now());
    const widget = renderWidget(model, family, config, { stale, at: record.at }, Date.now());
    return widget;
  } catch (_) { return messageWidget(config.title || config.region, '天气数据暂不可用', family, config, Date.now()); }
}
