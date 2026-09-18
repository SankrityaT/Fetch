// The models each agent CLI can run, for the chat's model picker.
//
// Read from the CLIs' own state wherever it exists, so the list is what this machine
// can actually use rather than what Fetch guessed at build time:
//
//   Codex        ~/.codex/models_cache.json, the catalogue Codex itself fetched, with
//                the effort levels each model supports. Hidden models stay hidden.
//   Claude Code  no local catalogue, so a short list of real model ids, plus anything
//                the account was offered (additionalModelOptionsCache in ~/.claude.json).
//
// The person's own defaults (Codex config.toml, Claude settings.json) are reported
// too, so the picker can say "your default" instead of silently overriding it.
//
// Main process only: reads files in the home directory.

const fs = require('fs')
const os = require('os')
const path = require('path')

const HOME = os.homedir()
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const readText = f => { try { return fs.readFileSync(f, 'utf8') } catch { return '' } }

// Every level `claude --effort` accepts.
const CLAUDE_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max']

// Newest first within each family. Haiku takes no effort setting.
const CLAUDE_MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', family: 'Fable', efforts: CLAUDE_EFFORT },
  { id: 'claude-fable-5', label: 'Fable 5', family: 'Fable', efforts: CLAUDE_EFFORT },
  { id: 'claude-opus-5', label: 'Opus 5', family: 'Opus', efforts: CLAUDE_EFFORT },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', family: 'Opus', efforts: CLAUDE_EFFORT },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', family: 'Sonnet', efforts: CLAUDE_EFFORT },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', family: 'Haiku', efforts: [] },
]

// Claude Code's aliases, to show which listed model the person's default resolves to.
const CLAUDE_ALIAS = { fable: 'claude-fable-5-1', opus: 'claude-opus-5', sonnet: 'claude-sonnet-5', haiku: 'claude-haiku-4-5-20251001' }

const stripCtx = id => String(id || '').replace(/\[[^\]]*\]$/, '')   // "opus[1m]" → "opus"

function claude() {
  const models = CLAUDE_MODELS.map(m => ({ ...m }))
  const cfg = readJson(path.join(HOME, '.claude.json')) || {}
  for (const o of cfg.additionalModelOptionsCache || []) {
    const id = stripCtx(o.value)
    if (!id || models.some(m => m.id === id)) continue
    const label = (String(o.description || '').split('·')[0].trim()) || o.label || id
    models.unshift({ id, label, family: o.label || '', efforts: CLAUDE_EFFORT })
  }
  const settings = readJson(path.join(HOME, '.claude', 'settings.json')) || {}
  const raw = stripCtx(settings.model)
  const def = CLAUDE_ALIAS[raw] || raw || null
  return {
    id: 'claude', label: 'Claude Code',
    models,
    default: { model: models.some(m => m.id === def) ? def : null, effort: settings.effortLevel || null },
  }
}

function codex() {
  const cache = readJson(path.join(HOME, '.codex', 'models_cache.json')) || {}
  const models = (cache.models || [])
    .filter(m => m && m.slug && m.visibility !== 'hide')
    .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    .map(m => ({
      id: m.slug,
      label: String(m.display_name || m.slug).replace(/-(?=[A-Z])/g, ' '),   // GPT-5.6-Sol → GPT-5.6 Sol
      family: 'GPT',
      efforts: (m.supported_reasoning_levels || []).map(x => (typeof x === 'string' ? x : x.effort)).filter(Boolean),
      defaultEffort: m.default_reasoning_level || null,
    }))
  const toml = readText(path.join(HOME, '.codex', 'config.toml'))
  const top = toml.split(/^\s*\[/m)[0]                                  // only top-level keys
  const pick = k => { const m = new RegExp(`^\\s*${k}\\s*=\\s*"([^"]+)"`, 'm').exec(top); return m ? m[1] : null }
  return {
    id: 'codex', label: 'Codex',
    models,
    default: { model: pick('model'), effort: pick('model_reasoning_effort') },
  }
}

// Only for engines that are installed; the caller passes that list in.
function catalogue(installed = ['claude', 'codex']) {
  const out = []
  if (installed.includes('claude')) out.push(claude())
  if (installed.includes('codex')) out.push(codex())
  return out
}

module.exports = { catalogue, CLAUDE_MODELS, CLAUDE_EFFORT }
