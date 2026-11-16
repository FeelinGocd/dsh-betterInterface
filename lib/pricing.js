/**
 * Parse the official DeepSeek pricing page (https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
 * into a structured pricing snapshot: models, per-model prices for input cache
 * hit / input cache miss / output under both off-peak and peak periods, and the
 * peak time windows expressed in Beijing time.
 *
 * Nothing here is hardcoded: every value is read from the page. If the page
 * structure changes, parsing fails loudly with a diagnostic instead of
 * returning wrong numbers.
 */

const ROW_RE = /<tr[^>]*>([\s\S]*?)<\/tr>/gi
const CELL_RE = /<td[^>]*>([\s\S]*?)<\/td>/gi

/**
 * Strip tags and decode the minimal entities a Docusaurus table cell contains.
 * Superscript footnotes ("<sup>(1)</sup>", seen on the current page's model
 * header: "deepseek-flash<sup>(1)</sup>") are dropped with their marker text —
 * the marker is a prose reference, not part of the model name.
 */
export function cellText(html) {
  return html
    .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Split one <tr> into its raw <td> cell bodies (colspan/rowspan ignored here). */
function rowCells(rowHtml) {
  const cells = []
  for (const m of rowHtml.matchAll(CELL_RE)) cells.push(m[1])
  return cells
}

/** Parse "0.05元" -> 0.05; throws when the cell is not a plain price. */
function parsePrice(text) {
  const m = String(text).match(/^([0-9]+(?:\.[0-9]+)?)\s*元?$/)
  if (!m) throw new Error(`unparseable price cell "${text}"`)
  return Number(m[1])
}

/** Identify the pricing kind from the item label cell. */
function kindOf(label) {
  if (label.includes('输入') && label.includes('缓存命中')) return 'inputCacheHit'
  if (label.includes('输入') && label.includes('缓存未命中')) return 'inputCacheMiss'
  if (label.includes('输出')) return 'output'
  return undefined
}

/** Day-of-week qualifier -> JS weekday numbers (Sunday=0 … Saturday=6). */
const DAY_MAP = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

const DAY_RANGE_RE = /(?:周|星期|礼拜)([一二三四五六日天])\s*至\s*(?:周|星期|礼拜)([一二三四五六日天])/

/**
 * Parse the weekday qualifier of the peak-window sentence, e.g. "周一至周五"
 * or "星期一至星期五". Returns the JS weekday set the windows apply to, or
 * undefined when the sentence has no qualifier (windows apply every day).
 * "每天/每日/工作日" variants are also recognized.
 */
export function parseDayQualifier(text) {
  if (/工作日/.test(text)) return [1, 2, 3, 4, 5]
  if (/每天|每日|全天/.test(text)) return [0, 1, 2, 3, 4, 5, 6]
  const m = text.match(DAY_RANGE_RE)
  if (!m) return undefined
  const from = DAY_MAP[m[1]]
  const to = DAY_MAP[m[2]]
  if (from === undefined || to === undefined) return undefined
  const days = []
  let d = from
  for (;;) {
    days.push(d)
    if (d === to) break
    d = (d + 1) % 7
  }
  return days
}

/** Human label for a peak-window weekday set, e.g. [1..5] -> "周一至周五"; all days -> "". */
export function peakDaysLabel(days) {
  if (days === undefined || days === null || days.length === 7) return ''
  if (days.length === 5 && days.includes(1) && days.includes(5) && !days.includes(0) && !days.includes(6)) {
    return '周一至周五'
  }
  const order = [1, 2, 3, 4, 5, 6, 0]
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const sorted = [...days].sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return sorted.map((d) => names[d]).join('、')
}

/**
 * Sentence shapes the pricing page has used for the peak-window definition:
 *   - current (2026-09): "北京时间周一至周五（不含中国法定节假日）9:00 - 12:00、
 *     14:00 - 18:00 为高峰时段；其余时段…"
 *   - earlier: "高峰时段为北京时间周一至周五 9:00 - 12:00、14:00 - 18:00（其余为空闲时段）。"
 * Both capture the span between the Beijing-time marker and the peak-window
 * label; the sentence may end with "；" instead of "。", so both are accepted.
 */
const PEAK_SENTENCE_RES = [
  /北京时间\s*([^。；]{0,160}?)\s*为高峰时段/,
  /高峰时段为\s*北京时间\s*([^。；]+)/,
]

/**
 * Parse the peak-window sentence. Returns { windows, days, excludeHolidays }
 * where windows are [{ startHour, startMinute, endHour, endMinute }] in Beijing
 * time, days is the JS weekday set the windows apply to (undefined = every day),
 * and excludeHolidays reports whether the page carves Chinese statutory holidays
 * out of the peak window (they are billed off-peak, like weekends).
 */
export function parsePeakWindows(pageText) {
  let text
  for (const re of PEAK_SENTENCE_RES) {
    const match = pageText.match(re)
    if (match) {
      text = match[1]
      break
    }
  }
  if (text === undefined) return { windows: [], days: undefined, excludeHolidays: false }
  // The weekday qualifier may carry a parenthetical caveat ("（不含中国法定节假日）").
  const excludeHolidays = /(法定节假日|法定假日)/.test(text)
  const days = parseDayQualifier(text)
  const rest = text
    .replace(DAY_RANGE_RE, '')
    .replace(/工作日|每天|每日/g, '')
    .replace(/[（(][^）)]*[）)]/g, ' ')
  const pairs = rest.split(/[、，,]/)
  const windows = []
  for (const pair of pairs) {
    const m = pair.match(/(\d{1,2})\s*[:：]?\s*(\d{2})?\s*[-—–~至]\s*(\d{1,2})\s*[:：]?\s*(\d{2})?/)
    if (!m) continue
    windows.push({
      startHour: Number(m[1]),
      startMinute: Number(m[2] ?? 0),
      endHour: Number(m[3]),
      endMinute: Number(m[4] ?? 0),
    })
  }
  return { windows, days, excludeHolidays }
}

/**
 * Parse the weekend off-peak rule the pricing page may announce, e.g.
 * "我们将于北京时间2026年8月23日（周日）00:00起，对峰谷计费规则做出调整，
 *  周末（周六、周日）全天不再区分峰谷时段，统一按照低谷时段价格收取调用费用。"
 * Returns { effectiveAt, days } where effectiveAt is the UTC epoch at which the
 * rule starts (Beijing wall time converted) and days are JS weekday numbers
 * (Sunday=0 … Saturday=6) that become off-peak all day from then on.
 * Returns undefined when the page carries no such rule (or the wording is not
 * recognized) — the plugin then keeps the plain weekday windows.
 */
export function parseWeekendRule(pageText) {
  const when = pageText.match(/北京时间\s*(\d{4})年(\d{1,2})月(\d{1,2})日[^。，,]*?(\d{1,2})\s*[:：]?\s*(\d{2})?\s*起/)
  if (!when) return undefined
  const effectiveAt = Date.UTC(
    Number(when[1]),
    Number(when[2]) - 1,
    Number(when[3]),
    Number(when[4] ?? 0) - 8,
    Number(when[5] ?? 0),
  )
  const daysMatch = pageText.match(/周末\s*[（(]\s*([^）)]+?)\s*[）)]/)
  if (!daysMatch) return undefined
  const dayNames = { 星期日: 0, 周日: 0, 星期天: 0, 星期六: 6, 周六: 6 }
  const days = []
  for (const [label, jsDay] of Object.entries(dayNames)) {
    if (daysMatch[1].includes(label)) days.push(jsDay)
  }
  if (days.length === 0) return undefined
  // Only accept the rule when the prose right after the effective instant
  // actually describes an off-peak weekend.
  const tail = pageText.slice(when.index, when.index + 240)
  if (!/(低谷|空闲)[^。，,]{0,12}价格/.test(tail)) return undefined
  return { effectiveAt, days: [...new Set(days)] }
}

/**
 * Parse the whole pricing page. Returns:
 * {
 *   models: string[],
 *   pricePerMillionTokens: { [model]: {
 *     inputCacheHit: { offPeak, peak }, inputCacheMiss: { offPeak, peak }, output: { offPeak, peak }
 *   } },
 *   peakWindows: [{ startHour, startMinute, endHour, endMinute }],  // Beijing time
 *   peakDays: number[],  // JS weekdays the windows apply to (0=Sunday)
 *   excludeHolidays: boolean,  // Chinese statutory holidays are billed off-peak
 *   weekendRule?: { effectiveAt, days },  // off-peak weekdays, when announced
 * }
 * Throws with a diagnostic when the expected structure is missing.
 */
export function parsePricingPage(html) {
  if (typeof html !== 'string' || html.length === 0) {
    throw new Error('定价页内容为空')
  }

  const table = html.match(/<table[^>]*>([\s\S]*?)<\/table>/i)
  if (!table) throw new Error('定价页中未找到价格表格（<table>）')
  const tableHtml = table[0]

  // 1. Model names from the header row ("模型 | deepseek-v4-flash | deepseek-v4-pro").
  let models = []
  for (const row of tableHtml.matchAll(ROW_RE)) {
    const cells = rowCells(row[1]).map(cellText)
    if (cells.length >= 2 && cells[0] === '模型') {
      models = cells.slice(1).filter(Boolean)
      break
    }
  }
  if (models.length === 0) throw new Error('定价页表格中未找到模型名（表头行）')
  if (models.length < 2) throw new Error(`定价页模型列不足：${models.join(', ')}`)

  // 2. Price rows. The pricing block uses rowspan: the "百万tokens…" item label
  // appears only on the first row of each pair, so the current kind carries over
  // to the following "空闲时段/高峰时段" row.
  const prices = Object.fromEntries(models.map((m) => [m, {
    inputCacheHit: { offPeak: null, peak: null },
    inputCacheMiss: { offPeak: null, peak: null },
    output: { offPeak: null, peak: null },
  }]))

  let currentKind = undefined
  for (const row of tableHtml.matchAll(ROW_RE)) {
    const cells = rowCells(row[1]).map(cellText)
    const kindCell = cells.find((c) => c.includes('百万tokens'))
    if (kindCell !== undefined) {
      const kind = kindOf(kindCell)
      if (kind !== undefined) currentKind = kind
    }
    if (currentKind === undefined) continue
    const periodCell = cells.find((c) => c === '空闲时段' || c === '高峰时段')
    if (periodCell === undefined) continue
    const priceCells = cells.filter((c) => /^[0-9]+(?:\.[0-9]+)?\s*元?$/.test(c))
    if (priceCells.length !== models.length) {
      throw new Error(`价格行单元格数与模型数不符（${priceCells.length} vs ${models.length}）：${cells.join(' | ')}`)
    }
    const period = periodCell === '高峰时段' ? 'peak' : 'offPeak'
    models.forEach((model, i) => {
      prices[model][currentKind][period] = parsePrice(priceCells[i])
    })
  }

  // Every model must have both periods for all three kinds.
  for (const model of models) {
    for (const kind of ['inputCacheHit', 'inputCacheMiss', 'output']) {
      const entry = prices[model][kind]
      if (entry.offPeak === null || entry.peak === null) {
        throw new Error(`模型 ${model} 的 ${kind} 缺少峰/谷价格（offPeak=${entry.offPeak}, peak=${entry.peak}）`)
      }
    }
  }

  // 3. Peak windows from the page prose (Beijing time), including the weekday
  // qualifier (e.g. "周一至周五"): the windows may apply only on certain days.
  const pageText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
  const { windows, days, excludeHolidays } = parsePeakWindows(pageText)
  if (windows.length === 0) {
    throw new Error('定价页中未找到高峰时段（北京时间 … 为高峰时段）的时段定义')
  }
  const weekendRule = parseWeekendRule(pageText)

  return {
    models,
    pricePerMillionTokens: prices,
    peakWindows: windows,
    peakDays: days ?? [0, 1, 2, 3, 4, 5, 6],
    excludeHolidays,
    weekendRule,
  }
}

/**
 * Decide whether a given instant is inside a peak window, interpreted in
 * Beijing time (UTC+8, no DST). Returns 'peak' or 'offPeak'.
 * Windows are half-open [start, end); a window may cross midnight.
 * peakDays is the JS weekday set the windows apply to (all days when omitted).
 * A weekendRule (standalone announcement), when supplied and already effective,
 * makes its listed Beijing weekdays off-peak all day and takes precedence.
 * `holidays` is an optional Set of Beijing calendar dates ("YYYY-MM-DD"). A hit
 * is off-peak and outranks BOTH the weekday qualifier and the windows, because
 * the official rule bills Chinese statutory holidays at the off-peak price —
 * a weekday holiday inside a peak window is therefore off-peak, not peak.
 */
export function periodAt(date, peakWindows, weekendRule, peakDays, holidays) {
  const utcMs = date.getTime()
  const bj = new Date(utcMs + 8 * 3600 * 1000)
  if (holidays instanceof Set && holidays.size > 0 && holidays.has(beijingDateKey(date))) {
    return 'offPeak'
  }
  if (weekendRule !== undefined && weekendRule !== null && utcMs >= weekendRule.effectiveAt) {
    if (weekendRule.days.includes(bj.getUTCDay())) return 'offPeak'
  }
  if (peakDays !== undefined && peakDays !== null && !peakDays.includes(bj.getUTCDay())) {
    return 'offPeak'
  }
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  for (const w of peakWindows) {
    const start = w.startHour * 60 + w.startMinute
    const end = w.endHour * 60 + w.endMinute
    if (start === end) continue
    const inside = start < end
      ? minutes >= start && minutes < end
      : minutes >= start || minutes < end
    if (inside) return 'peak'
  }
  return 'offPeak'
}

/**
 * Beijing calendar date of an instant, as "YYYY-MM-DD" — the key shape accepted
 * by periodAt's `holidays` set. Beijing is UTC+8 with no DST, so shifting the
 * instant and reading its UTC fields yields the local calendar date.
 */
export function beijingDateKey(date) {
  return new Date(date.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

/**
 * Whether a weekendRule currently applies to the given instant (already
 * effective AND the Beijing weekday is one of the rule's days).
 */
export function weekendRuleActive(rule, date) {
  if (rule === undefined || rule === null) return false
  const utcMs = date.getTime()
  if (utcMs < rule.effectiveAt) return false
  const bj = new Date(utcMs + 8 * 3600 * 1000)
  return rule.days.includes(bj.getUTCDay())
}
