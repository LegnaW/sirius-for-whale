/**
 * 人设：**从文本文件读**，不写进 cordis.patch.yml。
 * ============================================================================
 * 为什么（用户2026-10-31）：人设是最常被改的东西，而它原本埋在 YAML 的
 * `persona.config.prefix/suffix` 里——改一句话要动配置文件、还容易被引号/换行坑。
 * 现在改成仓库根的 `persona.txt`：
 *
 *   · 直接编辑 `persona.txt` 就行，不必懂 YAML；
 *   · **按 mtime 热加载**：改完下一次提示词装配就生效，不用重启 DSH
 *     （`PromptSection.text` 是函数，每次装配都会重新读）；
 *   · 文件缺失/为空 → 回退到内置默认（插件永远不会"没有身份"；
 *   · `config.persona`（内联字符串）/ `config.personaFile`（换路径）可覆盖。
 *
 * 🔴 不做 `{{变量}}` 插值：宿主在"引用了未注册变量"时会**渲染失败**，
 *    人设这种一改就崩整个会话的位置不值得赌。要插值请写在行为规则里。
 * ============================================================================
 */
// 注意别名：参数名与导入名同名会让默认值 `statSync = statSync` 撞上 TDZ（单测抓到的）
import { readFileSync, statSync as statFile } from 'node:fs'

/** 内置兜底人设：文件没了也不会失去身份。 */
export const DEFAULT_PERSONA = [
  '你是一个 Minecraft Java 版游戏助理。你通过 sirius_* 工具操作一台真实的 MC 客户端（sirius-bridge 模组）：',
  '它有自己的屏幕、自己的手、自己的背包，不是模拟器。',
  '专注于游戏本身，不要过问 bridge 的实现细节，除非用户明确要求调试。',
  '工具失败时先读返回值里的 result/reason 再决定下一步，不要盲目重试同一动作。',
].join('\n')

/**
 * 造一个加载器：每次调用都会（按 mtime）决定是否重读文件。
 * @param {object} options
 * @param {string} [options.file]   人设文件路径（一般由 plugin 用 import.meta.url 推出来）
 * @param {string} [options.inline] 内联人设（配置覆盖，优先级最高）
 * @param {Function} [options.readFile] 便于单测注入
 * @param {Function} [options.statSync]
 * @param {Function} [options.log]
 */
export function createPersonaLoader ({
  file,
  inline,
  readFile = readFileSync,
  statSync = statFile,
  log = () => {},
} = {}) {
  let cache = null // { text, source, mtimeMs }

  return function loadPersona () {
    if (typeof inline === 'string' && inline.trim()) {
      return { text: inline.trim(), source: 'config.persona（内联）' }
    }
    if (!file) return { text: DEFAULT_PERSONA, source: '内置默认（没配置 personaFile）' }
    try {
      const stat = statSync(file)
      if (cache && cache.mtimeMs === stat.mtimeMs && cache.text) return cache
      const raw = readFile(file, 'utf8')
      const text = String(raw ?? '').trim()
      if (!text) {
        cache = { text: DEFAULT_PERSONA, source: `${file}（空文件 → 内置默认）`, mtimeMs: stat.mtimeMs }
      } else {
        cache = { text, source: file, mtimeMs: stat.mtimeMs }
      }
      log(`人设已加载：${cache.source}（${cache.text.length} 字）`)
      return cache
    } catch (error) {
      const reason = error?.code ?? error?.message ?? 'unknown'
      return { text: DEFAULT_PERSONA, source: `内置默认（读不到 ${file}：${reason}）` }
    }
  }
}
