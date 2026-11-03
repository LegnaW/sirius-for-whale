export function createBridgeMaintenanceTick ({
  link,
  bridgeCache,
  getSubscribed,
  setSubscribed,
  ensureSubscribed,
  probeCapabilities,
  refreshSelf,
  tickAutonomy,
  log = () => {},
}) {
  let wasOnline = false

  return async () => {
    const status = await link.status()
    const online = status.online === true
    if (online !== wasOnline && !online) setSubscribed(false)
    wasOnline = online

    if (!online) {
      bridgeCache.capabilities.protocol = null
      bridgeCache.capabilities.hasUse = null
      bridgeCache.baritone.allowBreak = null
      bridgeCache.baritone.allowPlace = null
      bridgeCache.baritone.chatControl = null
      if (getSubscribed()) {
        setSubscribed(false)
        log('连接断开：事件订阅标记已清零，重连后会重新 subscribe')
      }
      return
    }

    if (status.protocol) bridgeCache.capabilities.protocol = status.protocol
    probeCapabilities()
    if (!getSubscribed()) ensureSubscribed()
    else refreshSelf()
    await tickAutonomy()
  }
}
