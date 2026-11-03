import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function captureScreenshot ({ link, workspace, params = {} }) {
  if (!workspace) throw new Error('无法确定当前会话工作区，截图未保存')
  const request = { tier: params.tier ?? 'full' }
  if (params.bbox) request.bbox = params.bbox
  if (params.quality != null) request.quality = params.quality
  const data = await link.call('screenshot', request, { timeoutMs: 30000 })
  const base64 = data?.image_b64 ?? ''
  if (!base64) throw new Error('bridge 没有返回图片数据')
  const format = String(data?.format ?? 'jpeg').toLowerCase()
  const extension = format === 'png' ? 'png' : format === 'webp' ? 'webp' : 'jpg'
  const relativePath = `images/sirius-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`
  const path = join(workspace, relativePath)
  const bytes = Buffer.from(base64, 'base64')
  await mkdir(join(workspace, 'images'), { recursive: true })
  await writeFile(path, bytes, { flag: 'wx' })
  const { image_b64: _omit, ...metadata } = data
  return {
    ...metadata,
    bytes: bytes.length,
    path,
    relative_path: relativePath,
  }
}
