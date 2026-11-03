import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { toLosslessJSON } from '../json.mjs'

const ACTIVE = new Set(['queued', 'running'])

export class PluginRunStore {
  #runs = new Map()

  constructor (file = '') {
    this.file = file ? resolve(file) : ''
    if (!this.file) return
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8'))
      for (const run of stored.runs ?? []) {
        if (typeof run.run_id === 'string' && typeof run.plugin_id === 'string') this.#runs.set(run.run_id, run)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error(`插件运行状态无法读取：${error.message}`)
    }
  }

  start (record, args) {
    if (!this.file || !record.plugin_id || !['task', 'service'].includes(record.mode)) return
    this.#runs.set(record.run_id, {
      run_id: record.run_id,
      plugin_id: record.plugin_id,
      owner: record.owner,
      mode: record.mode,
      args: toLosslessJSON(args),
      checkpoint: toLosslessJSON(record.checkpoint),
      status: 'queued',
      updated_at: Date.now(),
    })
    this.#persist()
  }

  checkpoint (record, value) {
    const run = this.#runs.get(record.run_id ?? record.id)
    if (!run) return
    run.checkpoint = toLosslessJSON(value)
    run.status = record.status
    run.updated_at = Date.now()
    this.#persist()
  }

  finish (record) {
    const run = this.#runs.get(record.run_id ?? record.id)
    if (!run) return
    run.status = record.status
    run.error = record.error
    run.checkpoint = toLosslessJSON(record.checkpoint)
    run.updated_at = Date.now()
    this.#persist()
  }

  restoreActive () {
    if (!this.file) return []
    const active = [...this.#runs.values()].filter((run) => ACTIVE.has(run.status))
    for (const run of active) {
      run.status = 'interrupted'
      run.error = 'process_restarted'
      run.updated_at = Date.now()
    }
    if (active.length) this.#persist()
    return active.map((run) => structuredClone(run))
  }

  invalidatePlugin (pluginId, reason = 'plugin_invalidated') {
    let changed = false
    for (const run of this.#runs.values()) {
      if (run.plugin_id !== pluginId || !ACTIVE.has(run.status)) continue
      run.status = 'cancelled'
      run.error = reason
      run.updated_at = Date.now()
      changed = true
    }
    if (changed) this.#persist()
  }

  #persist () {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp`
    const runs = [...this.#runs.values()].sort((a, b) => a.updated_at - b.updated_at).slice(-200)
    writeFileSync(temporary, `${JSON.stringify({ version: 1, runs }, null, 2)}\n`, { encoding: 'utf8', flag: 'w' })
    renameSync(temporary, this.file)
  }
}
