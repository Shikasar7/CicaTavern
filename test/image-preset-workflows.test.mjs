// 生图方案 keep their ComfyUI workflow: each imported one is kept under its tag (comfy-workflows/), a plan drawing
// with the workflow names it, and switching to the plan brings it back (server/media.mjs, http.mjs PUT /api/media/settings).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp } from '../server/http.mjs'
import { currentImagePreset, imagePresetOf } from '../web/shared/draw.js'

const workflow = words => ({
  4: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: `${words}.safetensors` } },
  6: { class_type: 'CLIPTextEncode', inputs: { text: `${words}, %prompt%`, clip: ['4', 1] } },
  7: { class_type: 'CLIPTextEncode', inputs: { text: 'lowres', clip: ['4', 1] } },
  3: { class_type: 'KSampler', inputs: { seed: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0] } },
  8: { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } },
})

async function tavern(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'tavern-plans-'))
  const app = createApp({ dataRoot, proxy: 'off', edition: 'release' })
  const server = await app.listen({ port: 0 })
  t.after(async () => {
    app.network.stop()
    server.closeAllConnections?.()
    server.close()
    await rm(dataRoot, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (pathname, { method = 'GET', body } = {}) => {
    const res = await fetch(`${base}${pathname}`, { method, headers: { 'content-type': 'application/json', 'x-agent-tavern': '1' }, body: body ? JSON.stringify(body) : undefined })
    const json = await res.json()
    assert.equal(res.status, 200, JSON.stringify(json))
    return json
  }
  const imported = async () => JSON.stringify(JSON.parse(await readFile(path.join(dataRoot, 'comfy-workflow.json'), 'utf8'))).includes('krea') ? 'krea' : 'moss'
  const kept = async () => (await readdir(path.join(dataRoot, 'comfy-workflows')).catch(() => [])).length
  return { dataRoot, call, imported, kept }
}

test('a plan drawing with the imported workflow keeps it, and switching plans switches the workflow', async t => {
  const { call, imported, kept } = await tavern(t)
  await call('/api/media/settings', { method: 'PUT', body: { imageBackend: 'comfy', comfyMode: 'workflow' } })
  const krea = await call('/api/media/workflow', { method: 'PUT', body: { workflow: workflow('krea') } })
  assert.match(krea.media.comfyWorkflowTag, /^[0-9a-f]{12}$/, 'an import tags the settings')
  let { media } = await call('/api/media/settings', { method: 'PUT', body: { imagePresets: [{ name: 'Krea', settings: imagePresetOf(krea.media) }] } })
  const kreaTag = media.comfyWorkflowTag
  assert.equal(media.imagePresets[0].settings.comfyWorkflowTag, kreaTag)
  assert.equal(currentImagePreset(media)?.name, 'Krea')

  // Another workflow: the plan is no longer the one in use. Saved from a page still holding the old tag, the new
  // plan names the workflow imported now (the server's), not the page's.
  const moss = await call('/api/media/workflow', { method: 'PUT', body: { workflow: workflow('moss') } })
  assert.notEqual(moss.media.comfyWorkflowTag, kreaTag)
  assert.equal(currentImagePreset(moss.media), null)
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: { imagePresets: [...media.imagePresets, { name: 'MOSS', settings: imagePresetOf(krea.media) }] } }))
  const [kreaPlan, mossPlan] = media.imagePresets
  assert.equal(mossPlan.settings.comfyWorkflowTag, moss.media.comfyWorkflowTag)
  assert.equal(kreaPlan.settings.comfyWorkflowTag, kreaTag, 'the other plan is left as it was')
  assert.equal(currentImagePreset(media)?.name, 'MOSS')
  assert.equal(await kept(), 2)

  // Switched to the Krea plan (what 换成这个 sends): its workflow is the imported one again.
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: kreaPlan.settings }))
  assert.equal(await imported(), 'krea')
  assert.equal(currentImagePreset(media)?.name, 'Krea')

  // A plan drawing otherwise names no workflow: switching to it leaves the imported one alone.
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: { imagePresets: [...media.imagePresets, { name: 'NAI', settings: { ...imagePresetOf(media), imageBackend: 'novelai' } }] } }))
  const nai = media.imagePresets[2]
  assert.equal(nai.settings.comfyWorkflowTag, '')
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: nai.settings }))
  assert.equal(await imported(), 'krea')
  assert.equal(media.comfyWorkflowTag, kreaTag)
  assert.equal(currentImagePreset(media)?.name, 'NAI')
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: mossPlan.settings }))
  assert.equal(await imported(), 'moss')
  assert.equal(currentImagePreset(media)?.name, 'MOSS')

  // A plan dropped: the workflow only it named goes.
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: { imagePresets: media.imagePresets.filter(p => p.name !== 'Krea') } }))
  assert.equal(await kept(), 1)
  // A tag nothing is kept under changes nothing.
  ;({ media } = await call('/api/media/settings', { method: 'PUT', body: kreaPlan.settings }))
  assert.equal(await imported(), 'moss')
  assert.equal(media.comfyWorkflowTag, mossPlan.settings.comfyWorkflowTag)
})

test('plans saved before workflows were kept take the one imported, once', async t => {
  const { dataRoot, call, kept } = await tavern(t)
  await call('/api/media/settings', { method: 'PUT', body: { imageBackend: 'comfy', comfyMode: 'workflow' } })
  await call('/api/media/workflow', { method: 'PUT', body: { workflow: workflow('krea') } })
  // As an older version left it: a workflow imported, no tag, a plan without one.
  const file = path.join(dataRoot, 'settings.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  const old = { ...saved.media, comfyWorkflowTag: '' }
  old.imagePresets = [{ id: 'abcd1234', name: '旧方案', settings: { ...imagePresetOf(old), comfyWorkflowTag: undefined } }]
  await writeFile(file, JSON.stringify({ ...saved, media: old }), 'utf8')
  await rm(path.join(dataRoot, 'comfy-workflows'), { recursive: true, force: true })
  const { media } = await call('/api/media/settings')
  assert.match(media.comfyWorkflowTag, /^[0-9a-f]{12}$/)
  assert.equal(media.imagePresets[0].settings.comfyWorkflowTag, media.comfyWorkflowTag)
  assert.equal(currentImagePreset(media)?.name, '旧方案')
  assert.equal(await kept(), 1)
})
