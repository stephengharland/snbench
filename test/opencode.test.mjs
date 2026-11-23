import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOpenCode, openCodeCommand, openCodeConfig, validateOpenCode } from '../lib/opencode.mjs'
import { runAgent, agentEnv } from '../lib/agents.mjs'

const step = (id = 's1', reason = 'stop') => ({ type: 'step_finish', part: { id, type: 'step-finish', reason, cost: 0.001, tokens: { input: 171, output: 39, reasoning: 0, cache: { read: 6784, write: 0 } } } })
const tool = (id, command, status = 'completed', output = '', exit = 0) => ({ type: 'tool_use', part: { type: 'tool', id, tool: 'shell', state: { status, input: { command }, output, metadata: { metadata: { exit } } } } })
const lines = (...events) => events.map(e => JSON.stringify(e)).join('\n') + '\n'
const adapter = { name: 'jsn', guide: 'Use jsn.', allowed_tools: ['Bash(jsn:*)'], script_commands: ['jsn eval'] }

test('CLI rejects missing model, unsupported adapter, command override and runner mismatch before connection', () => {
    const dir = mkdtempSync(join(tmpdir(), 'snb-cli-'))
    const cli = fileURLToPath(new URL('../bin/snbench.mjs', import.meta.url))
    const run = (args) => {
        try { execFileSync(process.execPath, [cli, 'run', ...args], { cwd: dir, env: { PATH: process.env.PATH }, stdio: 'pipe' }); assert.fail('expected rejection') }
        catch (e) { assert.equal(e.status, 1); return e.stderr.toString() }
    }
    try {
        assert.match(run(['--agent', 'opencode', '--adapter', 'jsn']), /requires --model/)
        for (const model of ['haiku', '/model', 'provider/', 'provider/model#', 'provider/model#a#b', 'provider/model name', ' provider/model']) {
            assert.match(run(['--agent', 'opencode', '--adapter', 'jsn', '--model', model]), /requires --model provider\/model/, model)
        }
        assert.match(run(['--agent', 'opencode', '--adapter', 'curl', '--model', 'deepseek/deepseek-flash']), /only the jsn/)
        assert.match(run(['--agent', 'opencode', '--adapter', 'jsn', '--agent-cmd', 'ignored']), /only supported with Claude/)
        const prior = join(dir, 'prior.json')
        writeFileSync(prior, JSON.stringify({ adapter: 'jsn', track: 'agent', model: 'deepseek/deepseek-flash', agent_runner: 'claude' }))
        assert.match(run(['--agent', 'opencode', '--adapter', 'jsn', '--model', 'deepseek/deepseek-flash', '--resume', prior]), /not this one/)
    } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unique step usage, duplicates and tool result accounting', () => {
    const rec = parseOpenCode(lines(step('s1', 'tool-calls'), step('s1', 'tool-calls'), tool('a', 'jsn version'), tool('a', 'jsn version'), tool('b', 'jsn eval x', 'error', 'HTTP 503', 1), tool('c', 'cat ../x', 'error', 'Permission denied'), step('s2')))
    assert.equal(rec.cost_usd, 0.002)
    assert.equal(rec.tokens.input, 342)
    assert.equal(rec.tokens.cache_read, 13568)
    assert.equal(rec.turns, 2)
    assert.equal(rec.shell_executions, 2)
    assert.equal(rec.shell_failures, 1)
    assert.equal(rec.shell_denied, 1)
    assert.equal(rec.instance_errors, 1)
    assert.equal(rec.agent_error, undefined)
})

test('malformed, missing cost, incomplete and provider errors are explicit', () => {
    assert.match(parseOpenCode('{').agent_error, /malformed/)
    assert.match(parseOpenCode(lines(step('a', 'tool-calls'))).agent_error, /terminal/)
    const s = step(); delete s.part.cost
    assert.equal(parseOpenCode(lines(s)).cost_usd, null)
    assert.match(parseOpenCode(lines({ type: 'error', error: { message: 'provider failed' } })).agent_error, /provider failed/)
    const duplicate = step(); duplicate.part.cost = 4
    assert.match(parseOpenCode(lines(step(), duplicate)).agent_error, /conflicting duplicate/)
})

test('policy denies baseline and external actions; unsupported adapters rejected', () => {
    validateOpenCode(adapter, 'deepseek/deepseek-flash')
    validateOpenCode(adapter, 'provider/model#variant')
    assert.deepEqual(openCodeCommand('deepseek/deepseek-flash'), ['opencode', '--standalone', 'run', '--model', 'deepseek/deepseek-flash', '--format', 'json', '--archived'])
    const rules = openCodeConfig().permissions
    assert.deepEqual(rules[0], { action: '*', resource: '*', effect: 'deny' })
    assert.ok(rules.some(r => r.action === 'external_directory' && r.effect === 'deny'))
    assert.ok(rules.some(r => r.action === 'shell' && r.resource === 'jsn *' && r.effect === 'allow'))
    assert.throws(() => validateOpenCode(adapter), /requires --model/)
    assert.throws(() => validateOpenCode({ name: 'curl' }, 'x/y'), /only the jsn/)
    assert.throws(() => validateOpenCode({ ...adapter, mcp: 'x' }, 'x/y'), /without MCP/)
})

test('runner environment passes provider input but not arbitrary config overrides', () => {
    process.env.DEEPSEEK_API_KEY = 'fixture-not-secret'
    process.env.OPENCODE_CONFIG_CONTENT = 'untrusted'
    process.env.ANTHROPIC_SNB_FIXTURE_OVERRIDE = 'fixture-override'
    process.env.CLAUDE_CODE_SNB_FIXTURE_OVERRIDE = 'fixture-override'
    try {
        const env = agentEnv(adapter, { SNB_INSTANCE: 'https://fixture.invalid' }, 'opencode')
        assert.equal(env.DEEPSEEK_API_KEY, 'fixture-not-secret')
        assert.equal(env.OPENCODE_CONFIG_CONTENT, undefined)
        assert.equal(env.ANTHROPIC_SNB_FIXTURE_OVERRIDE, undefined)
        assert.equal(env.CLAUDE_CODE_SNB_FIXTURE_OVERRIDE, undefined)
        const claude = agentEnv(adapter, {})
        assert.equal(claude.ANTHROPIC_SNB_FIXTURE_OVERRIDE, 'fixture-override')
        assert.equal(claude.CLAUDE_CODE_SNB_FIXTURE_OVERRIDE, 'fixture-override')
    } finally { delete process.env.DEEPSEEK_API_KEY; delete process.env.OPENCODE_CONFIG_CONTENT; delete process.env.ANTHROPIC_SNB_FIXTURE_OVERRIDE; delete process.env.CLAUDE_CODE_SNB_FIXTURE_OVERRIDE }
})

async function fixture(code, options = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'snb-opencode-'))
    try {
        const rec = await runAgent({ runner: 'opencode', adapter, model: 'deepseek/deepseek-flash', budget: 2, instance: 'https://fixture.invalid', env: { PATH: process.env.PATH }, dir, instruction: 'Fixture only', executable: [process.execPath, '-e', code], ...options })
        assert.ok(JSON.parse(readFileSync(join(dir, 'opencode.json'))).permissions)
        assert.deepEqual(rec.agent_command, [process.execPath, '-e', code])
        return rec
    } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('Node fixture child preserves script penalty and failed executions', async () => {
    const out = lines(tool('a', 'jsn eval x', 'error', 'failed', 1), step())
    const rec = await fixture(`process.stdin.resume(); console.log(${JSON.stringify(out)})`)
    assert.equal(rec.script_run, 'jsn eval x')
    assert.equal(rec.shell_failures, 1)
    assert.equal(rec.exit_code, 0)
})

test('Node fixtures cover nonzero exit, TERM escalation, and best-effort budget', async () => {
    assert.match((await fixture('process.exit(7)')).agent_error, /exit 7/)
    assert.match((await fixture("process.on('SIGTERM',()=>{}); setInterval(()=>{},100)", { timeout: 0.2, killGrace: 50 })).agent_error, /timed out/)
    const rec = await fixture(`console.log(${JSON.stringify(lines(step()))});setInterval(()=>{},100)`, { budget: 0.0001 })
    assert.match(rec.agent_error, /best-effort budget/)
    assert.equal(rec.budget_enforcement, 'best-effort-stream-usage-not-hard-cap')
})
