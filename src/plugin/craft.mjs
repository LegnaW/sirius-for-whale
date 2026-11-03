export const craftCode = `export default async function(ctx) {
  const a = ctx.args
  const call = (method, params) => ctx.api.call(method, params)
  const itemId = (value) => {
    if (typeof value !== 'string' || !value.trim()) return null
    const id = value.trim().toLowerCase()
    return id.includes(':') ? id : 'minecraft:' + id
  }
  const resultItem = itemId(a.result)
  const batches = Number(a.count ?? 1)
  if (!resultItem || !Array.isArray(a.grid) || ![4, 9].includes(a.grid.length)
      || !Number.isInteger(batches) || batches < 1 || batches > 64) {
    return { result: 'invalid_recipe', reason: '需要 result、4/9 格 grid 和 1..64 的整数 count' }
  }
  const layout = a.grid.length === 4
    ? [a.grid[0], a.grid[1], null, a.grid[2], a.grid[3], null, null, null, null]
    : a.grid
  const recipe = []
  for (let slot = 0; slot < layout.length; slot += 1) {
    const cell = layout[slot]
    if (cell == null) continue
    const item = itemId(typeof cell === 'string' ? cell : cell?.item)
    const count = typeof cell === 'string' ? 1 : Number(cell?.count ?? 1)
    if (!item || !Number.isInteger(count) || count < 1 || count > 64) {
      return { result: 'invalid_recipe', reason: 'grid 含无效物品或数量', slot }
    }
    recipe.push({ slot, item, count })
  }
  if (!recipe.length) return { result: 'invalid_recipe', reason: 'grid 不能为空' }
  let table = { x: a.x, y: a.y, z: a.z }
  if (![table.x, table.y, table.z].every(Number.isFinite)) {
    const range = Math.max(1, Math.min(8, Number(a.range ?? 4) || 4))
    const found = await call('world.query', { type: 'blocks', range, filter: ['minecraft:crafting_table'] })
    if (!found.blocks?.length) return { result: 'table_not_found', range }
    table = found.blocks[0]
  }
  const initialInventory = await call('inventory', {})
  const initialResultCount = initialInventory.counts?.[resultItem] ?? 0
  const resume = a.resume_checkpoint
  let startBatch = 0
  if (resume != null) {
    if (typeof resume !== 'object' || resume.result_item !== resultItem
        || !Number.isInteger(resume.completed) || resume.completed < 0 || resume.completed > batches
        || !Number.isFinite(resume.inventory_after)) {
      return { result: 'resume_conflict', reason: 'checkpoint 与当前配方或批数不匹配' }
    }
    if (initialResultCount < resume.inventory_after) {
      return {
        result: 'resume_conflict', reason: '实际产物少于 checkpoint，无法安全续做',
        expected_at_least: resume.inventory_after, actual: initialResultCount,
      }
    }
    startBatch = resume.completed
  }
  if (startBatch >= batches) {
    return { result: 'already_completed', item: resultItem, batches: startBatch, inventory_after: initialResultCount }
  }
  const remaining = batches - startBatch
  const required = {}
  for (const cell of recipe) required[cell.item] = (required[cell.item] ?? 0) + cell.count * remaining
  const missing = Object.entries(required).map(([item, need]) => ({
    item, need, have: initialInventory.counts?.[item] ?? 0,
  })).filter((entry) => entry.have < entry.need)
  if (missing.length) return { result: 'missing_ingredients', missing, table, resume_from: a.resume_from ?? null }
  let opened = false
  let recoveredGrid = false
  try {
    let used = await call('use', { ...table, hand: 'main' })
    if (used.result !== 'screen_opened') return { result: 'open_failed', table, evidence: used }
    opened = true
    let gui = await call('getGuiState', {})
    const craftSlots = () => (gui.slots ?? []).filter((slot) => slot.role === 'crafting')
      .sort((left, right) => left.index - right.index)
    if (craftSlots().length !== 9) return { result: 'not_crafting_table', table, screen: gui.screen_class }
    if (craftSlots().some((slot) => slot.item)) {
      await call('container.close', {})
      opened = false
      recoveredGrid = true
      used = await call('use', { ...table, hand: 'main' })
      if (used.result !== 'screen_opened') return { result: 'reopen_failed', table, recovered_grid: recoveredGrid }
      opened = true
      gui = await call('getGuiState', {})
      if (craftSlots().some((slot) => slot.item)) {
        return { result: 'grid_not_empty', table, recovered_grid: recoveredGrid }
      }
    }
    const crafted = []
    for (let batch = startBatch; batch < batches; batch += 1) {
      gui = await call('getGuiState', {})
      const empty = (gui.slots ?? []).find((slot) => ['player', 'hotbar'].includes(slot.role) && !slot.item)
      if (!empty) return { result: 'inventory_full', crafted, table, recovered_grid: recoveredGrid }
      const slots = craftSlots()
      if (slots.length !== 9 || slots.some((slot) => slot.item)) {
        return { result: 'grid_not_empty', crafted, table, recovered_grid: recoveredGrid }
      }
      const resultSlot = (gui.slots ?? []).find((slot) => slot.role === 'result')
      if (!resultSlot) return { result: 'no_result_slot', crafted, table }
      for (const cell of recipe) {
        gui = await call('getGuiState', {})
        const source = (gui.slots ?? []).find((slot) => ['player', 'hotbar'].includes(slot.role)
          && slot.item === cell.item && slot.count >= cell.count)
        if (!source) {
          return { result: 'missing_ingredients', crafted, missing: [{ item: cell.item, need: cell.count, have: 0 }], table }
        }
        const moved = await call('container.transfer', {
          from_slot: source.index, to_slot: slots[cell.slot].index, count: cell.count,
        })
        if (moved.result !== 'transferred') {
          return { result: 'transfer_failed', crafted, cell, evidence: moved, table }
        }
      }
      gui = await call('getGuiState', {})
      const produced = (gui.slots ?? []).find((slot) => slot.role === 'result')
      if (!produced?.item || produced.item !== resultItem) {
        return {
          result: 'result_mismatch', crafted, expected: resultItem,
          actual: produced?.item ?? null, table, recovered_grid: recoveredGrid,
        }
      }
      const expectedCount = produced.count
      const before = (await call('inventory', {})).counts?.[resultItem] ?? 0
      await call('container.clickSlot', { slot: resultSlot.index, button: 0, mode: 'quick_move' })
      await ctx.sleep(120)
      const after = (await call('inventory', {})).counts?.[resultItem] ?? 0
      const gained = after - before
      if (gained !== expectedCount) {
        return {
          result: gained > 0 ? 'partial_output' : 'output_unconfirmed', crafted,
          expected: resultItem, expected_count: expectedCount, actual_count: gained, table,
        }
      }
      crafted.push({ item: resultItem, count: gained })
      await ctx.checkpoint({ completed: batch + 1, result_item: resultItem, inventory_after: after })
    }
    return {
      result: 'crafted', item: resultItem, batches: crafted.length,
      produced: crafted.reduce((sum, entry) => sum + entry.count, 0),
      inventory_before: initialResultCount,
      inventory_after: initialResultCount + crafted.reduce((sum, entry) => sum + entry.count, 0),
      table, recovered_grid: recoveredGrid, resume_from: a.resume_from ?? null,
    }
  } catch (error) {
    return { result: ctx.signal.aborted ? 'interrupted' : 'failed', reason: String(error?.message ?? error), table }
  } finally {
    if (opened) await call('container.close', {}).catch(() => {})
  }
}`
