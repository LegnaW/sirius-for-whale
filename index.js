/**
 * 包根入口：只做转发，保持 Host 插件要求的 `apply` + `inject` 具名导出。
 */
export { apply, inject } from './src/plugin.mjs'
