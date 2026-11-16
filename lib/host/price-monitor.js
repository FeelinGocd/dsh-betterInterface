/**
 * dsh-better-interface — DeepSeek API 价格监控插件（含峰谷时段判定）。
 *
 * Host half:
 *   - price_balance: account balance / quota from the official /user/balance API
 *   - price_status:  current price snapshot and whether the present instant is
 *                    peak or off-peak, from the official pricing page
 *   - GET /price-monitor/status: JSON endpoint feeding the browser live panel
 *
 * The pricing page is fetched at startup and then re-checked on a timer
 * (default every 24h, configurable via refreshIntervalMs); the snapshot is
 * swapped automatically only when the page content actually changed. Balance is
 * queried live per call through ctx.credentials.
 *
 * The plugin depends only on services the host already provides (`tools`,
 * `credentials`, `webServer`) plus the Node 22 global fetch — no npm
 * dependencies. The browser half (lib/client.js) is loaded by dsh-client-modules
 * through the bundle's main client entry.
 */

import { parsePricingPage, periodAt, weekendRuleActive, peakDaysLabel } from '../pricing.js'
import { isLoopback, sendJson } from './guards.js'

export const name = 'dsh-better-interface/price-monitor'
export const inject = ['tools', 'credentials', 'webServer']

export async function apply(ctx, config = {}) {
  const {
    apiKeyEnv = 'DEEPSEEK_API_KEY',
    balanceUrl = 'https://api.deepseek.com/user/balance',
    pricingUrl = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
    fetchTimeoutMs = 15000,
    balanceCacheMs = 60000,
    refreshIntervalMs = 24 * 60 * 60 * 1000,
    holidays = [],
  } = config

  // ── statutory-holiday calendar ──────────────────────────────────────────────
  // The official rule bills Chinese statutory holidays at the off-peak price.
  // The list is republished every year by the State Council, so this plugin
  // deliberately does NOT ship one: a hardcoded calendar rots silently and turns
  // a wrong answer into a confident one. Supplying dates here makes the
  // peak/off-peak judgement exact; leaving it empty keeps the answer honest via
  // `holidayCaveat`, which every surface (tool text, tool JSON, browser panel)
  // reports.
  const holidaySet = new Set(
    (Array.isArray(holidays) ? holidays : [])
      .map((d) => String(d).trim())
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)),
  )
  const holidayCaveatFor = (snap) =>
    snap.excludeHolidays === true && holidaySet.size === 0
      ? '官方规则把中国法定节假日按低谷计费，但本插件未配置节假日日历（holidays），'
        + '因此若今天是法定节假日，此处会误报为高峰。'
        + '在插件配置的 holidays 中按 YYYY-MM-DD 补上日期即可精确判定。'
      : null
  // The official page is authoritative. A locally configured calendar only fills
  // in the DATES the page's holiday exemption refers to — it must never keep
  // granting the discount after the page stops offering it, or a stale local
  // list would silently diverge from the live rule it was meant to implement.
  const activeHolidaysFor = (snap) => (snap.excludeHolidays === true ? holidaySet : undefined)

  // ── pricing snapshot: fetched at startup, then re-fetched on a timer ───────
  // The official page may change prices, peak windows, or the weekend rule at
  // any time; the timer re-checks it (default every 24h) and swaps the snapshot
  // only when the content actually changed, so no user/agent action is needed.
  let snapshot = null
  let snapshotError = null
  let lastPricingHash = undefined
  // When the snapshot was last actually parsed from the official page, and the
  // last auto-refresh failure (if any) — surfaced so a stuck old price table
  // after a page-structure change is never silent.
  let syncedAt = null
  let syncError = null

  async function fetchWithTimeout(url, opts = {}) {
    const signal = opts.signal
    const headers = opts.headers || {}
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), fetchTimeoutMs)
    signal?.addEventListener('abort', () => ctrl.abort(), { once: true })
    try {
      return await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'dsh-better-interface/0.2 (DeepSeek pricing monitor)', ...headers },
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async function refreshSnapshot(signal) {
    const res = await fetchWithTimeout(pricingUrl, { signal })
    if (!res.ok) throw new Error(`定价页请求失败：HTTP ${res.status} ${res.statusText}`)
    const html = await res.text()
    const parsed = parsePricingPage(html) // may throw; hash only advances on success
    snapshot = parsed
    snapshotError = null
    syncedAt = new Date().toISOString()
    syncError = null
    lastPricingHash = hashText(html)
    return snapshot
  }

  // Periodic re-check: fetch the page, and only when its content hash differs
  // from the last successful parse, re-parse and swap the snapshot. A fetch or
  // parse failure keeps the current snapshot working and logs a warning.
  async function refreshIfChanged(signal) {
    let html
    try {
      const res = await fetchWithTimeout(pricingUrl, { signal })
      if (!res.ok) throw new Error(`定价页请求失败：HTTP ${res.status} ${res.statusText}`)
      html = await res.text()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('[dsh-better-interface/price-monitor] 定时刷新定价页失败：' + message)
      syncError = '自动同步失败：' + message
      return
    }
    const hash = hashText(html)
    if (hash === lastPricingHash) return // unchanged — nothing to do
    try {
      const parsed = parsePricingPage(html)
      snapshot = parsed
      snapshotError = null
      syncedAt = new Date().toISOString()
      syncError = null
      lastPricingHash = hash
      const windows = parsed.peakWindows
        .map((w) => `${w.startHour}:${String(w.startMinute).padStart(2, '0')} - ${w.endHour}:${String(w.endMinute).padStart(2, '0')}`)
        .join('、')
      ctx.logger?.info?.(
        '[dsh-better-interface/price-monitor] 定价页已自动更新：模型 ' + parsed.models.join('、') +
        '；高峰窗口 ' + windows + (parsed.weekendRule ? '；周末低谷规则已生效' : ''),
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.('[dsh-better-interface/price-monitor] 定时刷新解析失败（保留旧数据）：' + message)
      syncError = '自动同步解析失败，价格表可能已过期：' + message
    }
  }

  // One startup fetch; a failure is recorded and surfaced by the tools rather
  // than crashing the plugin (the plugin stays loaded; price_status reports it).
  try {
    await refreshSnapshot()
  } catch (error) {
    snapshotError = error instanceof Error ? error : new Error(String(error))
    ctx.logger?.warn?.('[dsh-better-interface/price-monitor] 启动时拉取定价页失败：' + snapshotError.message)
  }

  // Auto-refresh timer (refreshIntervalMs = 0 disables it). Bound to the plugin
  // fiber so stop/unload clears it.
  if (refreshIntervalMs > 0) {
    const timer = setInterval(() => { refreshIfChanged() }, refreshIntervalMs)
    ctx.effect(() => () => clearInterval(timer), 'price-monitor: pricing auto-refresh timer')
  }

  // ── balance helper: resolve the credential per call, never cache ───────────
  async function queryBalance(signal) {
    const ref = apiKeyEnv // CredentialRef is a branded string; validation below.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
      throw new Error(`无效的凭证引用 "${ref}"（须为 POSIX 标识符）`)
    }
    // credentials.resolve returns a ResolvedCredential { value, source } (or
    // undefined while unconfigured). Accept both shapes so the balance works
    // against any provider implementation.
    const resolved = await ctx.credentials.resolve(ref)
    let key
    let source
    if (resolved !== undefined && typeof resolved === 'object') {
      key = resolved.value
      source = resolved.source
    } else if (typeof resolved === 'string') {
      key = resolved
    }
    // Fall back to the DSH process environment itself (the key DSH runs on),
    // so the balance works even when the credentials store misses.
    if ((key === undefined || key === '') && typeof process !== 'undefined' && process.env && process.env[ref]) {
      key = process.env[ref]
      source = 'env'
    }
    if (key === undefined || key === '') {
      throw new Error(
        `未配置凭证 ${apiKeyEnv}。请在 $DSH_HOME/.credentials.yaml 中写入 ${apiKeyEnv}: <你的 key>，` +
        '或设置同名环境变量，或通过插件配置 apiKeyEnv 指向其它凭证名。',
      )
    }
    // Normalize exactly like dsh-llm's normalizeApiKey: a key arriving from the
    // credentials seam, a .env line, or a shell export can carry surrounding
    // whitespace (e.g. a trailing CR from CRLF). DSH's own LLM adapters trim it
    // silently before use; sending it raw makes the Authorization header carry
    // garbage and the API gateway answers 401 "Authentication Fails (governor)".
    const normalized = normalizeKey(key)
    if (normalized === null) {
      throw new Error(
        `凭证 ${apiKeyEnv} 的值无法用于 HTTP 请求头（含空白或非 ASCII 字符，来源：${source ?? 'unknown'}）。` +
        `请在 $DSH_HOME/.credentials.yaml 中写入 ${apiKeyEnv}: <你的 key>，或修正同名环境变量。`,
      )
    }
    key = normalized
    const res = await fetchWithTimeout(balanceUrl, {
      signal,
      headers: { authorization: 'Bearer ' + key, accept: 'application/json' },
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`余额接口请求失败：HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`)
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(`余额接口返回了非 JSON 内容（HTTP ${res.status}）：${text.slice(0, 200)}`)
    }
    return { body, source }
  }

  // ── tools ───────────────────────────────────────────────────────────────────

  ctx.tools.register({
    name: 'price_balance',
    description: '查询 DeepSeek 账户的余额与额度（总余额、赠送额度、充值额度、币种、账户可用状态），来自官方 /user/balance 接口。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          isAvailable: { type: 'boolean' },
          balances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                currency: { type: 'string' },
                totalBalance: { type: 'string' },
                grantedBalance: { type: 'string' },
                toppedUpBalance: { type: 'string' },
              },
            },
          },
          raw: { type: 'object' },
        },
      },
      render: (args, value) => [{ type: 'text', text: formatBalance(value) }],
    },
    async execute(_args, exec) {
      const { body } = await queryBalance(exec.signal)
      return {
        isAvailable: body.is_available === true,
        balances: (body.balance_infos ?? []).map((b) => ({
          currency: b.currency,
          totalBalance: b.total_balance,
          grantedBalance: b.granted_balance,
          toppedUpBalance: b.topped_up_balance,
        })),
        raw: body,
      }
    },
  })

  ctx.tools.register({
    name: 'price_status',
    description: '查询 DeepSeek API 当前价格与状态：当前处于高峰还是空闲时段、各模型当前生效单价（输入缓存命中/未命中、输出，元/百万 tokens）。价格表与时段来自官方定价页（启动时拉取，之后每 24 小时自动重检，页面变化自动更新）。',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: '可选：只返回指定模型（如 deepseek-flash）的价格。省略则返回全部模型。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          now: { type: 'string' },
          period: { type: 'string' },
          peakWindows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                startHour: { type: 'number' },
                startMinute: { type: 'number' },
                endHour: { type: 'number' },
                endMinute: { type: 'number' },
              },
            },
          },
          peakDays: { type: 'array', items: { type: 'number' } },
          peakDayLabel: { type: 'string' },
          excludeHolidays: { type: 'boolean' },
          holidayCaveat: { type: 'string' },
          prices: { type: 'object' },
          sourceUrl: { type: 'string' },
          syncedAt: { type: 'string' },
          syncError: { type: 'string' },
          weekendRule: {
            type: 'object',
            properties: {
              effectiveAt: { type: 'number' },
              days: { type: 'array', items: { type: 'number' } },
            },
          },
        },
      },
      render: (args, value) => [{ type: 'text', text: formatStatus(value) }],
    },
    async execute(args, exec) {
      if (snapshot === null) {
        // Pricing data is missing (startup fetch failed). Try once on demand,
        // then report the original failure if it still cannot load.
        if (snapshotError !== null) {
          const retry = await refreshSnapshot(exec.signal).catch((error) => error)
          if (retry instanceof Error) {
            throw new Error('定价数据未加载（启动时拉取失败，重试亦失败）：' + retry.message)
          }
        }
      }
      if (snapshot === null) {
        throw new Error('定价数据尚未加载，请稍后重试。')
      }

      const period = periodAt(new Date(), snapshot.peakWindows, snapshot.weekendRule, snapshot.peakDays, activeHolidaysFor(snapshot))
      const selected = args.model === undefined
        ? snapshot.pricePerMillionTokens
        : pickModel(snapshot, String(args.model))

      const result = {
        now: new Date().toISOString(),
        period,
        peakWindows: snapshot.peakWindows,
        peakDays: snapshot.peakDays,
        peakDayLabel: peakDaysLabel(snapshot.peakDays),
        excludeHolidays: snapshot.excludeHolidays === true,
        prices: selected,
        sourceUrl: pricingUrl,
        syncedAt,
      }
      if (syncError !== null) result.syncError = syncError
      const holidayCaveat = holidayCaveatFor(snapshot)
      if (holidayCaveat !== null) result.holidayCaveat = holidayCaveat
      if (snapshot.weekendRule !== undefined && snapshot.weekendRule !== null) {
        result.weekendRule = snapshot.weekendRule
      }
      return result
    },
  })

  ctx.logger?.info?.('[dsh-better-interface/price-monitor] 已注册 price_balance / price_status')

  // ── browser live panel: JSON endpoint fed by the client half ───────────────
  // The browser panel polls this endpoint every 30s. Balance is cached for
  // balanceCacheMs so polling does not hit the upstream API on every tick.
  let balanceCache = null
  let balanceCacheAt = 0

  async function readBalanceCached(signal) {
    const now = Date.now()
    if (balanceCache !== null && now - balanceCacheAt < balanceCacheMs) {
      return balanceCache
    }
    let body
    let error = null
    let source
    try {
      const result = await queryBalance(signal)
      body = result.body
      source = result.source
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    const value = { body: body ?? null, error, source }
    if (error !== null) {
      ctx.logger?.warn?.('[dsh-better-interface/price-monitor] 余额查询失败（来源 ' + (source ?? 'unknown') + '）：' + error)
    }
    balanceCache = value
    balanceCacheAt = now
    return value
  }

  const disposer = ctx.webServer.register({
    kind: 'exact',
    path: '/price-monitor/status',
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        sendJson(res, 403, { error: 'forbidden' })
        return
      }
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendJson(res, 405, { error: 'method-not-allowed' })
        return
      }
      let payload
      try {
        if (snapshot === null) {
          if (snapshotError !== null) {
            const retry = await refreshSnapshot().catch((error) => error)
            if (retry instanceof Error) {
              throw new Error('定价数据未加载（启动时拉取失败，重试亦失败）：' + retry.message)
            }
          }
        }
        if (snapshot === null) throw new Error('定价数据尚未加载，请稍后重试。')
        const balance = await readBalanceCached()
        const now = new Date()
        const bj = new Date(now.getTime() + 8 * 3600 * 1000)
        const peakDays = snapshot.peakDays ?? [0, 1, 2, 3, 4, 5, 6]
        payload = {
          now: now.toISOString(),
          period: periodAt(now, snapshot.peakWindows, snapshot.weekendRule, snapshot.peakDays, activeHolidaysFor(snapshot)),
          peakWindows: snapshot.peakWindows,
          peakDays,
          peakDayLabel: peakDaysLabel(peakDays),
          // The page carves Chinese statutory holidays out of the peak window
          // (they bill off-peak, like weekends) — surfaced so the panel does
          // not imply the windows apply unconditionally.
          excludeHolidays: snapshot.excludeHolidays === true,
          holidayCaveat: holidayCaveatFor(snapshot),
          // Today is off-peak because the peak windows do not apply to this
          // Beijing weekday (e.g. 周一至周五 → weekends).
          weekdayOffPeak: peakDays.length < 7 && !peakDays.includes(bj.getUTCDay()),
          weekendRule: snapshot.weekendRule ?? null,
          weekendActive: weekendRuleActive(snapshot.weekendRule, now),
          prices: snapshot.pricePerMillionTokens,
          balance: balance.body === null ? null : {
            isAvailable: balance.body.is_available === true,
            balances: (balance.body.balance_infos ?? []).map((b) => ({
              currency: b.currency,
              totalBalance: b.total_balance,
              grantedBalance: b.granted_balance,
              toppedUpBalance: b.topped_up_balance,
            })),
          },
          balanceError: balance.error,
          balanceSource: balance.source,
          sourceUrl: pricingUrl,
          syncedAt,
          syncError,
        }
      } catch (error) {
        payload = {
          now: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        }
      }
      sendJson(res, 200, payload)
    },
  })
  ctx.effect(() => disposer, 'price-monitor: /price-monitor/status route')
}

/**
 * Normalize a resolved API key exactly like dsh-llm's normalizeApiKey: trim
 * surrounding whitespace (credentials seam, .env lines and shell exports all
 * pick it up) and require printable ASCII only — an illegal character cannot
 * ride an HTTP header and would otherwise surface as an opaque gateway 401.
 * Returns null when the value cannot be used.
 */
function normalizeKey(raw) {
  const value = raw.trim()
  if (value.length === 0) return null
  if (!/^[\x21-\x7E]+$/.test(value)) return null
  return value
}

/** FNV-1a content hash (no dependencies); used to detect pricing-page changes. */
export function hashText(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

function pickModel(snapshot, model) {
  const exact = snapshot.pricePerMillionTokens[model]
  if (exact) return { [model]: exact }
  const normalized = model.toLowerCase()
  const match = Object.entries(snapshot.pricePerMillionTokens)
    .find(([key]) => key.toLowerCase() === normalized)
  if (match) return { [match[0]]: match[1] }
  throw new Error(
    `未知模型 "${model}"。可用模型：${Object.keys(snapshot.pricePerMillionTokens).join('、')}`,
  )
}

function formatBalance(value) {
  const lines = []
  if (!value.isAvailable) lines.push('账户不可用（is_available=false）')
  else lines.push('账户可用')
  for (const b of value.balances) {
    lines.push(`币种 ${b.currency}：总余额 ${b.totalBalance} = 赠送额度 ${b.grantedBalance} + 充值额度 ${b.toppedUpBalance}`)
  }
  if (lines.length === 0) lines.push('（接口未返回余额明细）')
  return lines.join('\n')
}

function formatStatus(value) {
  const periodLabel = value.period === 'peak' ? '高峰时段（价格翻倍）' : '空闲时段（半价）'
  const windows = value.peakWindows
    .map((w) => `${w.startHour}:${String(w.startMinute).padStart(2, '0')} - ${w.endHour}:${String(w.endMinute).padStart(2, '0')}`)
    .join('、')
  const windowLabel = value.peakDayLabel ? value.peakDayLabel + ' ' : ''
  const lines = [
    `当前：${periodLabel}（北京时间高峰窗口：${windowLabel}${windows}${value.excludeHolidays ? '，中国法定节假日除外' : ''}）`,
    `查询时间(UTC)：${value.now}`,
    '价格（元/百万 tokens）：',
  ]
  if (value.syncedAt !== undefined && value.syncedAt !== null) {
    const bj = new Date(new Date(value.syncedAt).getTime() + 8 * 3600 * 1000)
    const time = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')} ${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`
    lines.push(`价格表同步于：${time}（北京时间）`)
  }
  if (value.syncError) {
    lines.push(`⚠ ${value.syncError}——当前显示的价格表可能已过期`)
  }
  if (value.holidayCaveat) {
    lines.push(`⚠ ${value.holidayCaveat}`)
  }
  if (value.weekendRule !== undefined && value.weekendRule !== null) {
    const bj = new Date(value.weekendRule.effectiveAt + 8 * 3600 * 1000)
    const dateStr = `${bj.getUTCFullYear()}-${String(bj.getUTCMonth() + 1).padStart(2, '0')}-${String(bj.getUTCDate()).padStart(2, '0')}`
    const timeStr = `${String(bj.getUTCHours()).padStart(2, '0')}:${String(bj.getUTCMinutes()).padStart(2, '0')}`
    const days = value.weekendRule.days.map((n) => (n === 0 ? '周日' : n === 6 ? '周六' : `周${n}`)).join('、')
    lines.push(`周末规则：自 ${dateStr} ${timeStr}（北京时间）起，${days} 全天按低谷价计费，不再区分峰谷`)
  }
  for (const [model, kinds] of Object.entries(value.prices)) {
    lines.push(`  ${model}:`)
    lines.push(`    输入(缓存命中): 高峰 ${kinds.inputCacheHit.peak} / 空闲 ${kinds.inputCacheHit.offPeak}`)
    lines.push(`    输入(缓存未命中): 高峰 ${kinds.inputCacheMiss.peak} / 空闲 ${kinds.inputCacheMiss.offPeak}`)
    lines.push(`    输出: 高峰 ${kinds.output.peak} / 空闲 ${kinds.output.offPeak}`)
  }
  lines.push(`价格来源：${value.sourceUrl}`)
  return lines.join('\n')
}
