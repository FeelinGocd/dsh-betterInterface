import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from 'dsh-better-interface/price-monitor'

const pricingUrl = 'https://fixture.example/pricing'
const balanceUrl = 'https://fixture.example/balance'
const pricingPage = `
  <p>北京时间周一至周五（不含中国法定节假日）9:00 - 12:00 为高峰时段；</p>
  <table>
    <tr><td>模型</td><td>flash</td><td>pro</td></tr>
    <tr><td>百万tokens输入（缓存命中）</td><td>空闲时段</td><td>0.1元</td><td>0.2元</td></tr>
    <tr><td>高峰时段</td><td>0.2元</td><td>0.4元</td></tr>
    <tr><td>百万tokens输入（缓存未命中）</td><td>空闲时段</td><td>1元</td><td>2元</td></tr>
    <tr><td>高峰时段</td><td>2元</td><td>4元</td></tr>
    <tr><td>百万tokens输出</td><td>空闲时段</td><td>2元</td><td>6元</td></tr>
    <tr><td>高峰时段</td><td>4元</td><td>12元</td></tr>
  </table>`

test('the bundled monitor serves pricing, balance, and the sidebar route', async (t) => {
  let balanceRequests = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === pricingUrl) return new Response(pricingPage)
    assert.equal(url, balanceUrl)
    assert.equal(options.headers.authorization, 'Bearer fixture-key')
    balanceRequests++
    return Response.json({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '42.00', granted_balance: '0.00', topped_up_balance: '42.00' }],
    })
  })
  const tools = new Map()
  const routes = new Map()
  const disposers = []
  await apply({
    tools: { register: (tool) => tools.set(tool.name, tool) },
    credentials: { resolve: async () => ({ value: ' fixture-key\r\n', source: 'test' }) },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    effect: (create) => disposers.push(create()),
  }, { pricingUrl, balanceUrl, refreshIntervalMs: 0 })

  const status = await tools.get('price_status').execute({ model: 'flash' }, {})
  assert.deepEqual(Object.keys(status.prices), ['flash'])
  assert.deepEqual(status.prices.flash.output, { offPeak: 2, peak: 4 })
  assert.deepEqual(status.peakDays, [1, 2, 3, 4, 5])
  assert.ok(status.holidayCaveat)
  await assert.rejects(tools.get('price_status').execute({ model: 'unknown' }, {}), /unknown/)
  const balance = await tools.get('price_balance').execute({}, {})
  assert.equal(balance.balances[0].totalBalance, '42.00')

  async function callRoute(host, method = 'GET') {
    let statusCode
    let payload
    const headers = {}
    await routes.get('/price-monitor/status')({ method, headers: { host } }, {
      setHeader: (name, value) => { headers[name] = value },
      writeHead: (code, values) => { statusCode = code; Object.assign(headers, values) },
      end: (body) => { payload = JSON.parse(body) },
    })
    return { statusCode, headers, payload }
  }

  assert.equal((await callRoute('evil.example')).statusCode, 403)
  const invalidMethod = await callRoute('localhost:3080', 'POST')
  assert.equal(invalidMethod.statusCode, 405)
  assert.equal(invalidMethod.headers.allow, 'GET')
  const panel = await callRoute('127.0.0.1:3080')
  assert.equal(panel.statusCode, 200)
  assert.equal(panel.headers['cache-control'], 'no-store')
  assert.equal(panel.payload.balance.balances[0].totalBalance, '42.00')
  assert.deepEqual(panel.payload.prices.flash.output, { offPeak: 2, peak: 4 })
  assert.equal((await callRoute('[::1]:3080')).statusCode, 200)
  assert.equal(balanceRequests, 2, 'the second panel request uses the cached balance')
  for (const dispose of disposers) dispose()
  assert.equal(routes.size, 0)
})
