export const inventoryPluginIds = ['core.inventory_move', 'core.container_exchange']

export function inventoryCode (exchange) {
  return `export default async function(ctx) {
    const args = ctx.args
    const exchange = ${exchange}
    const storage = slot => ['hotbar', 'player'].includes(slot.role)
    const chest = slot => slot.role === 'container'
    const inRange = (n, max) => Number.isInteger(n) && n >= 1 && n <= max
    const operations = []
    if (exchange) {
      for (const direction of ['deposit', 'withdraw']) {
        const entries = args[direction] ?? []
        if (!Array.isArray(entries) || entries.length > 8) return { result: 'invalid_args' }
        for (const entry of entries) {
          if (typeof entry?.item !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(entry.item)
              || !inRange(entry.count, 2304)) return { result: 'invalid_args' }
          operations.push({ direction, item: entry.item, requested: entry.count, moved: 0 })
        }
      }
      if (!operations.length) return { result: 'invalid_args' }
    } else {
      if (![args.from_slot, args.to_slot].every(n => inRange(n + 1, 41))
          || (args.count !== undefined && !inRange(args.count, 128))) return { result: 'invalid_args' }
      if (args.from_slot === args.to_slot) return { result: 'no_op' }
    }
    const call = (method, params = {}) => ctx.api.call(method, params)
    const caps = await call('capabilities/list')
    const methods = caps.capabilities ?? caps.result ?? caps
    if (!Array.isArray(methods) || !methods.some(entry => entry.name === 'container.transfer')) {
      return { result: 'unsupported_bridge' }
    }
    let gui = await call('getGuiState')
    if (!gui.screen_open || !gui.slots?.length) return { result: 'no_container' }
    if (exchange && (!gui.slots.some(chest) || !gui.slots.some(storage))) {
      return { result: 'unsupported_container', screen_class: gui.screen_class }
    }
    const layout = state => JSON.stringify([state.screen_class,
      (state.slots ?? []).map(slot => [slot.index, slot.role, slot.container_slot])])
    const initialLayout = layout(gui)
    const screen = gui.screen_class
    let menuId
    let moved = 0
    let attempts = 0
    const finish = (result, reason) => ({
      result, reason, moved, evidence: 'client_snapshot', ...(exchange ? { operations } : {}),
    })
    const matches = (slot, item, count) => slot && !slot.note && (slot.item ?? null) === item && slot.count === count
    const transfer = async (from, to, count) => {
      if (++attempts > 96) return 'operation_limit'
      let reply
      try {
        reply = await call('container.transfer', { from_slot: from.index, to_slot: to.index, count })
      } catch {
        return 'rpc_outcome_unknown'
      }
      if (reply.result === 'no_container') return 'window_changed'
      if (reply.screen_class !== screen || (menuId !== undefined && reply.container_id !== menuId)) {
        return 'window_changed'
      }
      menuId = reply.container_id
      if (reply.result !== 'transferred') return reply.result
      const source = reply.changed_slots?.find(change => change.slot === from.index)
      const target = reply.changed_slots?.find(change => change.slot === to.index)
      const left = from.count - count
      if (reply.moved !== count || !matches(source?.before, from.item, from.count)
          || !matches(target?.before, to.item ?? null, to.count)
          || !matches(source?.after, left ? from.item : null, left)
          || !matches(target?.after, from.item, to.count + count)) return 'unexpected_slot_delta'
      try {
        gui = await call('getGuiState')
      } catch {
        return 'readback_failed'
      }
      if (layout(gui) !== initialLayout) return 'window_changed'
      const slot = index => gui.slots.find(candidate => candidate.index === index)
      if (!matches(slot(from.index), left ? from.item : null, left)
          || !matches(slot(to.index), from.item, to.count + count)) return 'readback_mismatch'
      moved += count
      return 'transferred'
    }
    if (!exchange) {
      const find = index => gui.slots.find(slot => !slot.note && slot.container_slot === index
        && (storage(slot) || ['armor', 'offhand'].includes(slot.role)))
      const from = find(args.from_slot)
      const to = find(args.to_slot)
      if (!from || !to) return finish('slot_unavailable')
      if (!from.item) return finish('empty_source')
      const verdict = await transfer(from, to, args.count ?? from.count)
      return finish(verdict)
    }
    for (const operation of operations) {
      const sourceRole = operation.direction === 'deposit' ? storage : chest
      const targetRole = operation.direction === 'deposit' ? chest : storage
      while (operation.moved < operation.requested) {
        const remaining = operation.requested - operation.moved
        const sources = gui.slots.filter(slot => !slot.note && sourceRole(slot) && slot.item === operation.item)
        if (sources.reduce((total, slot) => total + slot.count, 0) < remaining) {
          return finish(moved ? 'partial' : 'rejected', 'insufficient_items')
        }
        const targets = gui.slots.filter(slot => !slot.note && targetRole(slot)
          && (!slot.item || slot.item === operation.item))
          .sort((a, b) => Number(Boolean(b.item)) - Number(Boolean(a.item)))
        let advanced = false
        for (const from of sources) {
          for (const to of targets) {
            let count = Math.min(remaining, from.count, 128)
            while (count > 0) {
              const verdict = await transfer(from, to, count)
              if (verdict === 'transferred') {
                operation.moved += count
                advanced = true
                break
              }
              if (verdict === 'not_enough_space') { count = Math.floor(count / 2); continue }
              if (verdict === 'incompatible' || verdict === 'slot_forbidden') break
              return finish(moved ? 'partial' : 'stopped', verdict)
            }
            if (advanced) break
          }
          if (advanced) break
        }
        if (!advanced) return finish(moved ? 'partial' : 'rejected', 'no_destination')
      }
    }
    return finish('transferred')
  }`
}
