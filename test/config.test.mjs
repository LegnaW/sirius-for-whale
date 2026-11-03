import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { candidateTokenPaths, findBridgeCredentials, findBridgeTokenCandidates, normalizeConfig, parseBridgeToml } from '../src/config.mjs'

const SAMPLE = `# sirius-bridge configuration
# token: shared secret
port = 8765
token = "deadbeef"
input_enabled = true
rate_limit_per_sec = 20   # 行尾注释
permission = "full"
`

test('解析 sirius_bridge.toml 的关键键（含注释与行尾注释）', () => {
  const parsed = parseBridgeToml(SAMPLE)
  assert.equal(parsed.port, 8765)
  assert.equal(parsed.token, 'deadbeef')
  assert.equal(parsed.input_enabled, true)
  assert.equal(parsed.rate_limit_per_sec, 20)
  assert.equal(parsed.permission, 'full')
})

test('空值/异常输入不炸', () => {
  assert.deepEqual(parseBridgeToml(''), {})
  assert.deepEqual(parseBridgeToml(undefined), {})
  assert.deepEqual(parseBridgeToml('没有等号的行'), {})
})

test('normalizeConfig 只规范认识的字段并保留其它', () => {
  const config = normalizeConfig({ timeoutMs: '5000', discoverDirs: ['a', '', 'b'], extra: 1 })
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.discoverDirs.length, 2)
  assert.equal(config.extra, 1)
  assert.equal(config.url, 'ws://127.0.0.1:8765')
})

test('token 优先级：显式 token > tokenPath > gameDir', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfw-cfg-'))
  try {
    const gameDir = join(dir, 'game')
    mkdirSync(join(gameDir, 'config'), { recursive: true })
    writeFileSync(join(gameDir, 'config', 'sirius_bridge.toml'), 'port = 9000\ntoken = "from-game"\n')
    const tomlPath = join(dir, 'other.toml')
    writeFileSync(tomlPath, 'token = "from-path"\n')

    assert.equal(findBridgeCredentials(normalizeConfig({ token: 'explicit' }), {}).token, 'explicit')

    const byPath = findBridgeCredentials(normalizeConfig({ tokenPath: tomlPath }), {})
    assert.equal(byPath.token, 'from-path')

    const byGameDir = findBridgeCredentials(normalizeConfig({ gameDir }), {})
    assert.equal(byGameDir.token, 'from-game')
    assert.equal(byGameDir.port, 9000)
    assert.ok(byGameDir.path.endsWith('sirius_bridge.toml'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('找不到时报错并给出尝试过的路径', () => {
  const result = findBridgeCredentials(normalizeConfig({}), { APPDATA: join(tmpdir(), 'sfw-no-such-appdata') })
  assert.ok(result.error)
  assert.ok(Array.isArray(result.tried) && result.tried.length >= 1)
})

test('candidateTokenPaths 去重且包含 env 与 discoverDirs', () => {
  const paths = candidateTokenPaths(
    normalizeConfig({ gameDir: 'mock/g1', discoverDirs: ['mock/g2'] }),
    { APPDATA: 'mock/AppData', SIRIUS_BRIDGE_CONFIG: 'mock/x/bridge.toml' },
  )
  assert.ok(paths.some((p) => p.endsWith('bridge.toml')))
  assert.ok(paths.filter((p) => p.includes('g1')).length === 1)
  assert.equal(new Set(paths).size, paths.length)
})

test('findBridgeTokenCandidates：多来源按顺序收集并去重（同 token 只留第一次）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sfw-cand-'))
  try {
    const a = join(dir, 'a')
    const b = join(dir, 'b')
    mkdirSync(join(a, 'config'), { recursive: true })
    mkdirSync(join(b, 'config'), { recursive: true })
    writeFileSync(join(a, 'config', 'sirius_bridge.toml'), 'port = 9001\ntoken = "token-a"\n')
    writeFileSync(join(b, 'config', 'sirius_bridge.toml'), 'port = 9002\ntoken = "token-b"\n')
    // c 与 a 同 token：应被去重
    const c = join(dir, 'c')
    mkdirSync(join(c, 'config'), { recursive: true })
    writeFileSync(join(c, 'config', 'sirius_bridge.toml'), 'token = "token-a"\n')

    const list = findBridgeTokenCandidates(
      normalizeConfig({ gameDir: a, discoverDirs: [b, c] }),
      { APPDATA: join(dir, 'no-appdata') },
    )
    assert.deepEqual(list.map((x) => x.token), ['token-a', 'token-b'])
    assert.equal(list[0].port, 9001)
    assert.equal(list[1].port, 9002)
    assert.ok(list[0].path.endsWith('sirius_bridge.toml'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('findBridgeTokenCandidates：一个来源都没有时返回空数组（不是空 token 条目）', () => {
  const list = findBridgeTokenCandidates(
    normalizeConfig({}),
    { APPDATA: join(tmpdir(), 'sfw-no-such-appdata-2') },
  )
  assert.deepEqual(list, [])
})
