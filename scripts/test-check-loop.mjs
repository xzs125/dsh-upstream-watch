#!/usr/bin/env node
/**
 * Deterministic tests for the upstream-watch retry scheduler.
 *
 * The 2026-09-11 incident: the plugin checked exactly once at DSH startup, the
 * check landed in the WSL boot network race, both channels failed, and the
 * badge stayed purple until the next restart. These cases pin the behaviour
 * that makes that impossible: a failed check MUST schedule a backoff retry, a
 * recovered check MUST reset the failure counter, and a settled state MUST
 * fall back to the slow periodic re-check.
 *
 * Run: node scripts/test-check-loop.mjs
 */
import assert from 'node:assert/strict'
import { createScheduler } from '../lib/index.js'

const silent = { debug() {}, info() {}, warn() {}, error() {} }

/** Fake timer harness: nothing fires unless the test advances it. */
function makeClock() {
  const queue = []
  const timers = {
    setTimeout: (fn, ms) => {
      const handle = { fn, ms, cancelled: false, fired: false }
      queue.push(handle)
      return handle
    },
    clearTimeout: (handle) => {
      if (handle) handle.cancelled = true
    },
  }
  const pending = () => queue.filter((h) => !h.cancelled && !h.fired)
  const advance = async () => {
    const live = pending()
    const handle = live[live.length - 1]
    if (!handle) throw new Error('advance() called with no scheduled check')
    handle.fired = true
    handle.fn()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { timers, pending, advance }
}

const NOW = '2026-09-11T00:00:00.000Z'
const okState = () => ({ status: 'ok', checkedAt: NOW })
const errState = (message) => ({ status: 'error', error: message, checkedAt: NOW })

const cases = []
function test(name, fn) { cases.push({ name, fn }) }

test('start() never runs the check synchronously and waits initialDelayMs', async () => {
  const clock = makeClock()
  const states = []
  let runs = 0
  const scheduler = createScheduler({
    run: async () => { runs += 1; return okState() },
    initialDelayMs: 8000,
    retryBackoffMs: [15000, 30000],
    intervalMs: 3600000,
    onState: (s) => states.push(s),
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  assert.equal(runs, 0, 'start() must not check synchronously')
  assert.equal(states.length, 0, 'no state before the first check')
  assert.equal(clock.pending().length, 1, 'exactly one check scheduled')
  assert.equal(clock.pending()[0].ms, 8000, 'first check waits initialDelayMs')
  await clock.advance()
  assert.equal(runs, 1)
  assert.equal(states.at(-1).status, 'ok')
  assert.equal(states.at(-1).retrying, false)
  assert.equal(states.at(-1).consecutiveFailures, 0)
  assert.equal(clock.pending()[0].ms, 3600000, 'success schedules the periodic re-check')
})

test('a failed check schedules a backoff retry instead of stopping', async () => {
  const clock = makeClock()
  const states = []
  const scheduler = createScheduler({
    run: async () => errState('fetch failed'),
    initialDelayMs: 8000,
    retryBackoffMs: [15000, 30000],
    intervalMs: 3600000,
    onState: (s) => states.push(s),
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  await clock.advance()
  assert.equal(states.at(-1).status, 'error')
  assert.equal(states.at(-1).retrying, true, 'failure must be flagged as retrying')
  assert.equal(states.at(-1).consecutiveFailures, 1)
  assert.ok(states.at(-1).nextCheckAt, 'a retry must be planned')
  assert.equal(clock.pending().length, 1, 'THE REGRESSION: one failure must still leave a retry scheduled')
  assert.equal(clock.pending()[0].ms, 15000)
})

test('consecutive failures escalate the backoff and the last delay repeats', async () => {
  const clock = makeClock()
  const states = []
  const scheduler = createScheduler({
    run: async () => errState('network down'),
    initialDelayMs: 0,
    retryBackoffMs: [15000, 30000, 60000],
    intervalMs: 3600000,
    onState: (s) => states.push(s),
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(states.length, 1)
  assert.equal(clock.pending()[0].ms, 15000)
  await clock.advance()
  assert.equal(clock.pending()[0].ms, 30000)
  await clock.advance()
  assert.equal(clock.pending()[0].ms, 60000)
  await clock.advance()
  assert.equal(clock.pending()[0].ms, 60000, 'the last backoff entry repeats')
  assert.equal(states.at(-1).consecutiveFailures, 4)
})

test('a recovered check resets the counter and returns to the slow cadence', async () => {
  const clock = makeClock()
  const states = []
  let runs = 0
  const scheduler = createScheduler({
    run: async () => {
      runs += 1
      return runs <= 3 ? errState('boot race') : okState()
    },
    initialDelayMs: 0,
    retryBackoffMs: [15000, 30000],
    intervalMs: 21600000,
    onState: (s) => states.push(s),
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  await clock.advance()
  await clock.advance()
  assert.equal(states.at(-1).status, 'error')
  assert.equal(states.at(-1).consecutiveFailures, 3)
  await clock.advance()
  assert.equal(states.at(-1).status, 'ok', 'the retry must heal the badge')
  assert.equal(states.at(-1).consecutiveFailures, 0)
  assert.equal(states.at(-1).retrying, false)
  assert.equal(clock.pending()[0].ms, 21600000, 'recovery returns to the periodic cadence')
})

test('a thrown error becomes a retryable error state', async () => {
  const clock = makeClock()
  const states = []
  const scheduler = createScheduler({
    run: async () => { throw new Error('boom') },
    initialDelayMs: 0,
    retryBackoffMs: [15000],
    intervalMs: 3600000,
    onState: (s) => states.push(s),
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(states.at(-1).status, 'error')
  assert.equal(states.at(-1).error, 'boom')
  assert.equal(clock.pending()[0].ms, 15000)
})

test('triggerNow() runs a check immediately and shares one in-flight run', async () => {
  const clock = makeClock()
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const scheduler = createScheduler({
    run: async () => { calls += 1; await gate; return okState() },
    initialDelayMs: 8000,
    retryBackoffMs: [15000],
    intervalMs: 3600000,
    onState: () => {},
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  const first = scheduler.triggerNow()
  const second = scheduler.triggerNow()
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(calls, 1, 'concurrent triggers must share one run')
  assert.equal(a, b, 'both callers receive the same state object')
  assert.equal(a.status, 'ok')
})

test('stop() cancels the pending automatic check', async () => {
  const clock = makeClock()
  const scheduler = createScheduler({
    run: async () => errState('nope'),
    initialDelayMs: 0,
    retryBackoffMs: [15000],
    intervalMs: 3600000,
    onState: () => {},
    logger: silent,
    timers: clock.timers,
  })
  scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(clock.pending().length, 1)
  scheduler.stop()
  assert.equal(clock.pending().length, 0, 'stop() must cancel the retry')
})

test('failures log a warn line and recovery logs an info line', async () => {
  const clock = makeClock()
  const warns = []
  const infos = []
  const logger = {
    debug() {},
    info: (...a) => infos.push(a.join(' ')),
    warn: (...a) => warns.push(a.join(' ')),
    error() {},
  }
  let runs = 0
  const scheduler = createScheduler({
    run: async () => {
      runs += 1
      return runs === 1 ? errState('boot race') : okState()
    },
    initialDelayMs: 0,
    retryBackoffMs: [15000],
    intervalMs: 3600000,
    onState: () => {},
    logger,
    timers: clock.timers,
  })
  scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(warns.length, 1, 'a failed check must log exactly one warn line')
  assert.ok(warns[0].indexOf('boot race') >= 0, 'the warn line must carry the failure reason')
  await clock.advance()
  assert.equal(infos.length, 1, 'a recovery must log exactly one info line')
  assert.ok(infos[0].indexOf('恢复') >= 0, 'the recovery line must reach the journal')
})

let failed = 0
for (const c of cases) {
  try {
    await c.fn()
    console.log('PASS  ' + c.name)
  } catch (error) {
    failed += 1
    console.log('FAIL  ' + c.name)
    console.log('      ' + String(error && error.message ? error.message : error))
  }
}
console.log('')
console.log(failed === 0 ? 'ALL ' + cases.length + ' CASES PASSED' : failed + ' of ' + cases.length + ' CASES FAILED')
process.exit(failed === 0 ? 0 : 1)