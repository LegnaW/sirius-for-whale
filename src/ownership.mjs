export class BodyOwnership {
  #owner = null
  #parents = new Map()

  attach (agentId, parentId = null) {
    const id = String(agentId ?? '')
    if (!id) return null
    const parent = parentId ? String(parentId) : null
    this.#parents.set(id, parent)
    return this.rootOf(id)
  }

  activate (agentId) {
    const root = this.rootOf(agentId)
    if (!root) return null
    this.#owner = root
    return root
  }

  remove (agentId) {
    const id = String(agentId ?? '')
    if (!id) return
    this.#parents.delete(id)
    for (const [child, parent] of this.#parents) {
      if (parent === id) this.#parents.delete(child)
    }
    if (this.#owner === id) this.#owner = null
  }

  rootOf (agentId) {
    let current = String(agentId ?? '')
    if (!current || !this.#parents.has(current)) return null
    const seen = new Set()
    while (current) {
      if (seen.has(current)) return null
      seen.add(current)
      const parent = this.#parents.get(current)
      if (!parent) return current
      current = parent
    }
    return null
  }

  canControl (agentId) {
    const root = this.rootOf(agentId)
    return root !== null && root === this.#owner
  }

  get owner () { return this.#owner }

  snapshot () {
    return { owner: this.#owner }
  }
}
